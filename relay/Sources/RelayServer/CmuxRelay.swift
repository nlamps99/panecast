import Foundation
import ArgumentParser
import NIOPosix
import RelayCore
import CMUXClient
import SharedKit
import Logging

/// `cmux-relay` CLI entry point. Spec section 6.4, plan task 12.
///
/// Subcommands:
/// - `serve` (default) — boot the HTTP/WS relay against the local cmux UDS.
/// - `devices list` / `devices revoke <id>` — inspect / mutate
///   `~/.cmuxremote/devices.json` without going through the running server.
///
/// The AppKit menu-bar subcommand from the plan is intentionally deferred
/// — it's not on the critical path to "phone talks to relay" and adds
/// linker weight that the v1.0 service binary doesn't need.
@main
struct CmuxRelay: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "cmux-relay",
        subcommands: [Serve.self, Devices.self, Pair.self],
        defaultSubcommand: Serve.self
    )
}

/// Prints a scannable pairing code so the phone does not have to have a broker
/// URL, relay id, and 64-character pairing code typed into it by hand.
///
/// The pairing code is passed in rather than read from `relay.json` on purpose:
/// `relay.json` holds the relay's own `relay_token`, not the phone pairing
/// secret, and the Mac has no need to store the latter. Keeping it an argument
/// avoids widening where that secret lives.
struct Pair: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "pair",
        abstract: "Print pairing details for a phone, optionally as a QR code."
    )

    @Option(name: .customLong("config"),
            help: "Path to relay.json (default: ~/.cmuxremote/relay.json).")
    var config: String = defaultConfigPath()

    @Option(name: .customLong("pairing-code"),
            help: "The broker's CMUX_PAIRING_CODE. Read from stdin when omitted.")
    var pairingCode: String?

    @Option(name: .customLong("lan-host"),
            help: """
            LAN address the phone should use on the same Wi-Fi (default: this \
            Mac's private IPv4). Only used when relay.json has lan.pairing_code.
            """)
    var lanHost: String?

    @Flag(name: .customLong("url-only"),
          help: "Print just the cmux:// pairing URL, skipping the QR code.")
    var urlOnly = false

    func run() async throws {
        let store = ConfigStore(url: URL(fileURLWithPath: config))
        try store.reload()
        guard let broker = store.current.broker else {
            throw ValidationError(
                "relay.json has no `broker` block. QR pairing applies to broker transport only."
            )
        }
        guard store.current.transport.enablesBroker else {
            throw ValidationError(
                "relay.json transport is `\(store.current.transport.rawValue)`; expected `broker` or `both`."
            )
        }

        let code = try resolvePairingCode()
        let lan = try resolveLAN(config: store.current)
        let payload = PairingPayload(
            serverURL: broker.url,
            relayId: broker.relayId,
            pairingCode: code,
            lanURL: lan?.url,
            lanPairingCode: lan?.code
        )
        let urlString = try payload.urlString()

        if urlOnly {
            print(urlString)
            return
        }

        print("")
        print(try QRCodeRenderer.asciiQR(for: urlString))
        print("  server : \(broker.url)")
        print("  relay  : \(broker.relayId)")
        print("  code   : \(Self.redact(code))")
        if let lan {
            print("  lan    : \(lan.url)")
            print("  lancode: \(Self.redact(lan.code))")
        }
        print("")
        print("  Scan from cmux Remote > Settings > Connection > Scan QR.")
        print("  Treat this code like a password: it pairs any device that reads it.")
        if lan == nil, store.current.transport.enablesDirect {
            print("")
            print("  No LAN details: set lan.pairing_code in relay.json to let the")
            print("  phone take the faster same-Wi-Fi path when it is at home.")
        }
        print("")
    }

    /// Resolves the optional LAN half of the payload. Returns nil (rather than
    /// throwing) whenever LAN pairing is not configured, because the broker-only
    /// QR remains the documented happy path.
    private func resolveLAN(config: RelayConfig) throws -> (url: String, code: String)? {
        guard config.transport.enablesDirect,
              let lan = config.lan,
              lan.enablesPairing
        else { return nil }
        let host: String
        if let lanHost, !lanHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            host = lanHost.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let detected = LANAddress.primaryIPv4() {
            host = detected
        } else {
            throw ValidationError(
                "Could not detect this Mac's LAN address. Pass --lan-host <ip> explicitly."
            )
        }
        let (_, port) = parseListen(config.listen)
        return ("http://\(host):\(port)", lan.pairingCode)
    }

    /// Reading from stdin keeps the secret out of the shell history and out of
    /// the process list that any local user can inspect via `ps`.
    private func resolvePairingCode() throws -> String {
        if let pairingCode, !pairingCode.isEmpty {
            return pairingCode
        }
        FileHandle.standardError.write(Data("Pairing code: ".utf8))
        guard let line = readLine(strippingNewline: true),
              !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw ValidationError("A pairing code is required.")
        }
        return line.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func redact(_ secret: String) -> String {
        guard secret.count > 8 else { return String(repeating: "*", count: secret.count) }
        return "\(secret.prefix(4))\u{2026}\(secret.suffix(4)) (\(secret.count) chars)"
    }
}

struct Serve: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "serve",
        abstract: "Run the configured direct and/or broker relay transports."
    )

    @Option(name: .customLong("config"),
            help: "Path to relay.json (default: ~/.cmuxremote/relay.json).")
    var config: String = defaultConfigPath()

    func run() async throws {
        let logger = Logger(label: "cmux-relay")
        let store = ConfigStore(url: URL(fileURLWithPath: config))
        try store.reload()

        let group = MultiThreadedEventLoopGroup(numberOfThreads: 2)
        let conn = CmuxConnection(group: group)
        let facade = CMUXFacadeImpl(connection: conn)
        let historyFacade = CMUXFacadeImpl(connection: conn, lane: .history)
        let history = SurfaceHistoryService(cmux: historyFacade)
        let reader = CmuxSurfaceReader(connection: conn)
        let manager = SessionManager(reader: reader,
                                     defaultFps: store.current.defaultFps,
                                     idleFps: store.current.idleFps)
        let deviceStore = try DeviceStore(url: URL(fileURLWithPath: devicesStorePath()))
        let apnsProvider = APNsProviderClient(config: { store.current.apns })
        let apnsFanout = InboxPushFanout(
            deviceStore: deviceStore,
            sender: apnsProvider,
            config: { store.current.apns }
        )
        conn.onReset = {
            Task { await manager.broadcastReset() }
        }
        Task {
            var policy = ReconnectPolicy()
            while !Task.isCancelled {
                do {
                    let client = try await conn.connectForEvents()
                    let stream = EventStream(client: client) { event in
                        if event.category == .system,
                           let boot = try? event.payload.decode(BootInfo.self)
                        {
                            conn.observe(bootInfo: boot)
                        }
                        Task { await manager.broadcastToAll(frame: .event(event)) }
                        Task { await apnsFanout.deliver(event: event) }
                    }
                    await stream.start(categories: EventCategory.allCases)
                    logger.info("cmux event stream attached")
                    let attachedAt = ContinuousClock.now
                    await client.awaitClosed()
                    // Only treat this as a healthy connection (and reset backoff)
                    // if it stayed attached a while; otherwise a flapping/crash-
                    // looping cmux would be re-attacked every base interval.
                    if ContinuousClock.now - attachedAt > .seconds(5) {
                        policy.reset()
                    }
                    logger.warning("cmux event stream detached; will re-attach")
                    await conn.invalidateEvents()
                } catch {
                    logger.warning("cmux event stream unavailable: \(String(describing: error))")
                }
                let delay = policy.nextDelay()
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
        let sighup = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .global())
        sighup.setEventHandler {
            do {
                try store.reload()
                logger.info("config reloaded")
            } catch {
                logger.warning("config reload failed: \(error)")
            }
        }
        sighup.resume()
        signal(SIGHUP, SIG_IGN)

        var brokerRunner: Task<Void, Never>?
        if store.current.transport.enablesBroker {
            guard let brokerConfig = store.current.broker else {
                throw ValidationError("transport '\(store.current.transport.rawValue)' requires a broker block")
            }
            guard !brokerConfig.relayToken.isEmpty else {
                throw ValidationError("broker.relay_token must not be empty")
            }
            let tunnel = try BrokerTunnelClient(config: brokerConfig)
            let bridge = RemoteSessionBridge(sessionManager: manager, cmux: facade, history: history) { envelope in
                await tunnel.send(envelope)
            }
            await tunnel.setOnEnvelope { envelope in
                await bridge.receive(envelope)
            }
            await tunnel.setOnDisconnect {
                await bridge.disconnectAll()
            }
            brokerRunner = Task { await tunnel.runForever() }
            logger.info("broker transport enabled for relay_id=\(brokerConfig.relayId)")
        }
        defer { brokerRunner?.cancel() }

        if store.current.transport.enablesDirect {
            let auth = TailscaledLocalAuth()

            // A fresh direct-mode config has an empty allow_login. Authorise
            // this Mac's own tailnet login unless the operator opts out.
            var effectiveConfig = store.current
            if ProcessInfo.processInfo.environment["CMUX_NO_SELF_LOGIN"] == nil,
               let selfLogin = await auth.selfLogin() {
                if !effectiveConfig.allowLogin.contains(selfLogin) {
                    logger.info("auto-authorising this Mac's tailnet login for pairing: \(selfLogin)")
                }
                effectiveConfig = effectiveConfig.authorizing(login: selfLogin)
            }

            let routes = Routes(deviceStore: deviceStore,
                                config: effectiveConfig,
                                auth: auth)
            let server = HTTPServer(group: group, routes: routes, auth: auth,
                                    deviceStore: deviceStore,
                                    sessionManager: manager,
                                    cmux: facade,
                                    history: history)
            let (host, port) = parseListen(store.current.listen)
            logger.info("direct transport listening on \(host):\(port)")
            try await server.run(host: host, port: port)
        } else if let brokerRunner {
            await brokerRunner.value
        }
    }
}

struct Devices: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "devices",
        abstract: "Inspect and revoke registered phones.",
        subcommands: [List.self, Revoke.self]
    )

    struct List: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list",
            abstract: "Print all registered devices."
        )

        func run() async throws {
            let store = try DeviceStore(url: URL(fileURLWithPath: devicesStorePath()))
            for d in store.allDevices() {
                print("\(d.deviceId)  \(d.loginName)  \(d.hostname)  registered=\(d.registeredAt)")
            }
        }
    }

    struct Revoke: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "revoke",
            abstract: "Revoke a single device by id."
        )

        @Argument(help: "Device id to revoke.")
        var deviceId: String

        func run() async throws {
            let store = try DeviceStore(url: URL(fileURLWithPath: devicesStorePath()))
            try store.revoke(deviceId: deviceId)
            print("revoked \(deviceId)")
        }
    }
}

// MARK: - Path helpers

func defaultConfigPath() -> String {
    "\(NSHomeDirectory())/.cmuxremote/relay.json"
}

func devicesStorePath() -> String {
    "\(NSHomeDirectory())/.cmuxremote/devices.json"
}

/// Split `RelayConfig.listen` ("host:port") into a host + port pair.
/// Falls back to 4399 if the port is missing or unparseable so a typo
/// in relay.json doesn't take the daemon down silently.
func parseListen(_ listen: String) -> (host: String, port: Int) {
    let parts = listen.split(separator: ":", maxSplits: 1).map(String.init)
    let host = parts.first ?? "0.0.0.0"
    let port = parts.count >= 2 ? (Int(parts[1]) ?? 4399) : 4399
    return (host, port)
}
