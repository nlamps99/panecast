import SwiftUI
import SharedKit
import os.log
import UIKit

@main
struct CmuxRemoteApp: App {
    @UIApplicationDelegateAdaptor(RemoteNotificationRegistrar.self) private var remoteNotifications
    @State private var workspaceStore = WorkspaceStore(rpc: OfflineRPCDispatch())
    @State private var surfaceStore = SurfaceStore(rpc: OfflineRPCDispatch())
    @State private var notifStore = NotificationStore()
    @State private var hostStatusStore = HostStatusStore(rpc: OfflineRPCDispatch())
    @State private var notifPresenter = LocalNotificationPresenter()
    @State private var bootstrapped = false
    @State private var activeRPC: RPCClient?
    @State private var computers = ComputerStore()
    @State private var connectionTask: Task<Void, Never>?
    @State private var connectionID = UUID()
    @State private var transportCoordinator = TransportCoordinator {
        CmuxRemoteApp.resolveTransportSettings(useSavedComputer: true)
    }
    @State private var splashFinished = Self.shouldSkipSplash()
    @AppStorage("cmux.demoMode") private var demoMode: Bool = false
    @AppStorage("cmux.localNotificationsEnabled") private var localNotificationsEnabled = true
    @AppStorage("cmux.theme") private var themeRaw: String = CmuxColorTheme.storm.rawValue
    @AppStorage("cmux.keepScreenAwake") private var keepScreenAwake: Bool = false

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView(
                    workspaceStore: workspaceStore,
                    surfaceStore: surfaceStore,
                    notifStore: notifStore,
                    hostStatusStore: hostStatusStore,
                    computers: computers,
                    connectionID: connectionID,
                    onDisconnect: disconnect,
                    onReconnect: reconnect,
                    onTriggerTestNotification: triggerTestNotification
                )
                .task { if connectionTask == nil { reconnect() } }
                .onOpenURL(perform: handleDeepLink(_:))
                .opacity(splashFinished ? 1 : 0)

                if !splashFinished {
                    SplashView {
                        withAnimation(.easeOut(duration: 0.22)) {
                            splashFinished = true
                        }
                    }
                    .transition(.opacity)
                }
            }
            .onAppear {
                CmuxTheme.apply(themeRawValue: themeRaw)
                UIApplication.shared.isIdleTimerDisabled = keepScreenAwake
            }
            .onChange(of: themeRaw) { _, newValue in
                CmuxTheme.apply(themeRawValue: newValue)
            }
            .onChange(of: keepScreenAwake) { _, enabled in
                UIApplication.shared.isIdleTimerDisabled = enabled
            }
        }
    }

    private static func shouldSkipSplash() -> Bool {
        let info = ProcessInfo.processInfo
        return info.environment["CMUX_SKIP_SPLASH"] == "1"
            || info.arguments.contains("--cmux-skip-splash")
    }

    private static func shouldUseFakeRelay(_ info: ProcessInfo) -> Bool {
        // Explicit opt-out wins so a sim can still smoke a real relay.
        if info.environment["CMUX_REAL_RELAY"] == "1"
            || info.arguments.contains("--cmux-real-relay")
        {
            return false
        }
        if info.environment["CMUX_FAKE_RELAY"] == "1"
            || info.arguments.contains("--cmux-fake-relay")
        {
            return true
        }
        #if targetEnvironment(simulator) && DEBUG
        return true
        #else
        return false
        #endif
    }

    /// Copies an explicitly supplied launch configuration into the app
    /// container. This is intended for trusted development-device installs so
    /// the operator does not need to manually transcribe a broker URL, relay
    /// ID, or pairing code into the Settings UI.
    ///
    /// The switch is deliberately opt-in: ordinary launches and simulator
    /// smoke tests can still override settings with environment values without
    /// mutating persistent user configuration.
    private static func persistConnectionSettingsIfRequested(
        _ info: ProcessInfo,
        defaults: UserDefaults = .standard
    ) {
        let environment = info.environment
        guard environment["CMUX_PERSIST_CONNECTION_SETTINGS"] == "1" else { return }
        let preferenceRaw = environment["CMUX_TRANSPORT_PREFERENCE"]
            ?? environment["CMUX_CONNECTION_MODE"]
            ?? ""
        guard let preference = TransportPreference(rawValue: preferenceRaw) else { return }

        func persistDirect() -> Bool {
            guard let host = environment["CMUX_HOST"], !host.isEmpty else { return false }
            defaults.set(host, forKey: "cmux.host")
            if let port = Int(environment["CMUX_PORT"] ?? ""), port > 0 {
                defaults.set(port, forKey: "cmux.port")
            }
            if let code = environment["CMUX_LAN_PAIRING_CODE"], !code.isEmpty {
                defaults.set(code, forKey: "cmux.lanPairingCode")
            }
            return true
        }

        func persistBroker() -> Bool {
            guard let brokerURL = environment["CMUX_BROKER_URL"],
                  let relayId = environment["CMUX_RELAY_ID"],
                  let pairingCode = environment["CMUX_PAIRING_CODE"],
                  !brokerURL.isEmpty,
                  !relayId.isEmpty,
                  !pairingCode.isEmpty
            else { return false }
            defaults.set(brokerURL, forKey: "cmux.brokerURL")
            defaults.set(relayId, forKey: "cmux.relayId")
            defaults.set(pairingCode, forKey: "cmux.pairingCode")
            return true
        }

        switch preference {
        case .direct:
            guard persistDirect() else { return }
        case .broker:
            guard persistBroker() else { return }
        case .auto:
            // Auto needs both halves to be meaningful; refuse a partial seed
            // rather than persisting a preference that can only ever resolve one
            // way.
            guard persistDirect(), persistBroker() else { return }
        }
        defaults.set(preference.rawValue, forKey: "cmux.transportPreference")
    }

    /// Reads the transport preference and both candidate endpoints from the
    /// environment (simulator smoke tests) falling back to `UserDefaults`.
    ///
    /// The direct candidate's host does double duty: it holds either a tailnet
    /// address or a private-LAN one, and `RelayEndpoint.requiresPairingCode`
    /// decides which pairing path applies. That keeps one host field in Settings
    /// instead of two that mean almost the same thing.
    nonisolated static func resolveTransportSettings(
        _ info: ProcessInfo = .processInfo,
        defaults: UserDefaults = .standard,
        useSavedComputer: Bool = false
    ) -> (preference: TransportPreference, candidates: TransportCandidates) {
        let environment = info.environment
        if useSavedComputer,
           !["CMUX_HOST", "CMUX_BROKER_URL", "CMUX_TRANSPORT_PREFERENCE", "CMUX_CONNECTION_MODE"].contains(where: { environment[$0] != nil }),
           let computer = ComputerStore.savedComputer(defaults: defaults) {
            return (computer.preference, TransportCandidates(lan: computer.direct, broker: computer.broker))
        }
        func value(_ key: String, _ defaultsKey: String) -> String {
            let fromEnvironment = environment[key] ?? ""
            if !fromEnvironment.isEmpty { return fromEnvironment }
            return defaults.string(forKey: defaultsKey) ?? ""
        }

        let preferenceRaw = environment["CMUX_TRANSPORT_PREFERENCE"]
            ?? defaults.string(forKey: "cmux.transportPreference")
            // Pre-auto installs only stored a concrete mode; carry it forward so
            // upgrading never silently changes which transport is used.
            ?? environment["CMUX_CONNECTION_MODE"]
            ?? defaults.string(forKey: "cmux.connectionMode")
            ?? TransportPreference.direct.rawValue
        let preference = TransportPreference(rawValue: preferenceRaw) ?? .direct

        let host = value("CMUX_HOST", "cmux.host")
        let envPort = Int(environment["CMUX_PORT"] ?? "") ?? 0
        let storedPort = defaults.integer(forKey: "cmux.port")
        let port = envPort > 0 ? envPort : (storedPort == 0 ? 4399 : storedPort)
        let directEndpoint: RelayEndpoint? = host.isEmpty
            ? nil
            : .direct(host: host, port: port)

        let brokerURL = value("CMUX_BROKER_URL", "cmux.brokerURL")
        let relayId = value("CMUX_RELAY_ID", "cmux.relayId")
        let brokerEndpoint: RelayEndpoint? = brokerURL.isEmpty
            ? nil
            : .broker(baseURL: brokerURL, relayId: relayId)

        return (
            preference,
            TransportCandidates(
                lan: directEndpoint,
                lanPairingCode: value("CMUX_LAN_PAIRING_CODE", "cmux.lanPairingCode"),
                broker: brokerEndpoint,
                brokerPairingCode: value("CMUX_PAIRING_CODE", "cmux.pairingCode")
            )
        )
    }

    @MainActor
    private func bootstrapOnce() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        let sessionID = connectionID
        let notifications = notifStore
        let presenter = notifPresenter
        notifStore.localNotificationsEnabled = localNotificationsEnabled
        notifStore.onNew = { record in
            guard sessionID == connectionID else { return }
            presenter.present(record, relayEndpoint: computers.selectedID?.uuidString)
        }
        if localNotificationsEnabled { Task { await presenter.requestAuthorizationIfNeeded() } }
        let processInfo = ProcessInfo.processInfo
        Self.persistConnectionSettingsIfRequested(processInfo)
        if demoMode || Self.shouldUseFakeRelay(processInfo) {
            await bootstrapDemo()
            return
        }

        let keychain = Keychain(service: "com.genie.cmuxremote")
        if !Self.shouldSkipHardeningForDevelopment() {
            let result = HardeningCheck(keychain: keychain).runAtLaunch()
            guard result == .ok else { return }
        }

        do {
            try computers.migrateLegacyCredentials()
            if processInfo.environment["CMUX_PERSIST_CONNECTION_SETTINGS"] == "1" {
                try computers.saveCurrentSettings()
            } else if !computers.pendingNewComputer {
                computers.activateSelected()
            }
        } catch {
            workspaceStore.connection = .error(error.localizedDescription)
            return
        }

        let http = URLSessionHTTP()
        let (preference, candidates) = Self.resolveTransportSettings(processInfo)
        guard let selection = await TransportSelector(http: http)
            .select(preference: preference, candidates: candidates)
        else {
            guard sessionID == connectionID, !Task.isCancelled else { return }
            workspaceStore.connection = .error(L10n.string("Configure Mac host in Settings"))
            return
        }
        guard sessionID == connectionID, !Task.isCancelled else { return }
        let endpoint = selection.endpoint
        os_log("cmux bootstrap preference=%{public}@ mode=%{public}@",
               preference.rawValue, endpoint.mode.rawValue)

        let auth = AuthClient(
            endpoint: endpoint,
            keychain: keychain,
            http: http,
            pairingCode: selection.pairingCode,
            clientId: Self.clientIdentifier(),
            deviceName: UIDevice.current.name
        )
        let token: String
        let deviceId: String
        let wsURL: URL
        os_log("cmux register start mode=%{public}@", endpoint.mode.rawValue)
        do {
            try await auth.registerIfNeeded()
            guard sessionID == connectionID, !Task.isCancelled else { return }
            try computers.clearPairingCode(for: endpoint)
            Self.clearStoredPairingCode(
                afterSuccessfulRegistrationWith: endpoint,
                defaults: .standard
            )
            guard let credentials = try auth.storedCredentials() else {
                throw AuthError.missingBearer
            }
            token = credentials.token
            deviceId = credentials.deviceId
            wsURL = try endpoint.webSocketURL()
            os_log("cmux register ok")
            remoteNotifications.configure(authClient: auth)
            Task { @MainActor in
                guard await presenter.requestAuthorizationIfNeeded() else { return }
                await remoteNotifications.registerForRemoteNotifications()
            }
        } catch {
            guard sessionID == connectionID, !Task.isCancelled else { return }
            os_log("cmux register FAILED: %{public}@", String(describing: error))
            workspaceStore.connection = .error(String(describing: error))
            return
        }
        activeEndpointDidConnect(endpoint)

        let ws = WSClient(url: wsURL, headers: [
            "Sec-WebSocket-Protocol": "cmuxremote.v1",
            "Authorization": "Bearer \(token)",
        ])
        let rpc = RPCClient(transport: ws)
        let liveWorkspaceStore = WorkspaceStore(rpc: rpc)
        let liveSurfaceStore = SurfaceStore(rpc: rpc)
        let liveHostStatusStore = HostStatusStore(rpc: rpc)
        await MainActor.run {
            guard sessionID == connectionID, !Task.isCancelled else { return }
            liveWorkspaceStore.onWorkspaceAlert = {
                guard sessionID == connectionID else { return }
                notifications.append($0, deliveryPolicy: .userInputRequired)
            }
            liveWorkspaceStore.activeTransport = endpoint.activeTransport
            workspaceStore = liveWorkspaceStore
            surfaceStore = liveSurfaceStore
            hostStatusStore = liveHostStatusStore
            activeRPC = rpc
        }
        await rpc.onPush { frame in
            Task { @MainActor in
                guard sessionID == connectionID else { return }
                liveSurfaceStore.ingest(frame)
                notifications.ingest(frame)
            }
        }
        await ws.setOnText { text in Task { await rpc.handleIncoming(text: text) } }
        await ws.setOnClose { _ in
            Task { @MainActor in
                guard sessionID == connectionID else { return }
                await rpc.failAllPending(RPCClientError.closed)
                await MainActor.run { liveWorkspaceStore.connection = .disconnected }
            }
        }
        await ws.setOnOpen {
            Task { @MainActor in
                guard sessionID == connectionID else { return }
                let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.4"
                let hello = HelloFrame(deviceId: deviceId, appVersion: appVersion, protocolVersion: 1)
                if let data = try? SharedKitJSON.deterministicEncoder.encode(hello),
                   let text = String(data: data, encoding: .utf8)
                {
                    await ws.send(text: text)
                }
                await liveSurfaceStore.resubscribe()
            }
        }
        guard sessionID == connectionID, !Task.isCancelled else { await rpc.close(); return }
        await ws.connect()
        guard sessionID == connectionID, !Task.isCancelled else { await rpc.close(); return }
        await liveWorkspaceStore.refresh()
        guard sessionID == connectionID, !Task.isCancelled else { return }
        await liveHostStatusStore.refreshBattery()
    }

    @MainActor
    private func bootstrap(rpc: any RPCDispatch) async {
        workspaceStore = WorkspaceStore(rpc: rpc)
        surfaceStore = SurfaceStore(rpc: rpc)
        hostStatusStore = HostStatusStore(rpc: rpc)
        await workspaceStore.refresh()
        await hostStatusStore.refreshBattery()
    }

    @MainActor
    private func bootstrapDemo() async {
        let sessionID = connectionID
        let notifications = notifStore
        let rpc = DemoRPCDispatch()
        let liveWorkspaceStore = WorkspaceStore(rpc: rpc)
        let liveSurfaceStore = SurfaceStore(rpc: rpc)
        let liveHostStatusStore = HostStatusStore(rpc: rpc)
        liveWorkspaceStore.onWorkspaceAlert = {
            guard sessionID == connectionID else { return }
            notifications.append($0, deliveryPolicy: .userInputRequired)
        }
        // Demo mode has no real link; showing the LAN badge would misrepresent
        // it, so pick the transport the demo narrative implies.
        liveWorkspaceStore.activeTransport = .broker
        workspaceStore = liveWorkspaceStore
        surfaceStore = liveSurfaceStore
        hostStatusStore = liveHostStatusStore

        // When the user taps a surface chip, push a corresponding screen.full
        // so the terminal mirror lights up just like the live path would.
        await rpc.setOnSubscribe { surfaceId in
            await MainActor.run {
                guard sessionID == connectionID else { return }
                if let frame = DemoContent.screenFull(for: surfaceId) {
                    liveSurfaceStore.ingest(.screenFull(frame))
                }
            }
        }

        await liveWorkspaceStore.refresh()
        guard sessionID == connectionID, !Task.isCancelled else { return }
        await liveHostStatusStore.refreshBattery()

        // Seed the inbox after a short beat so reviewers see notifications
        // without us racing the workspace list render.
        let store = notifStore
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard sessionID == connectionID else { return }
            for record in DemoContent.notifications() {
                store.append(record)
            }
        }
    }

    /// Re-runs transport selection when the network path changes, and reconnects
    /// only if it now resolves to a different endpoint.
    @MainActor
    private func activeEndpointDidConnect(_ endpoint: RelayEndpoint) {
        transportCoordinator.connected(to: endpoint) { reconnect() }
    }

    @MainActor
    private func reconnect() {
        startConnection(connect: true)
    }

    @MainActor
    private func startConnection(connect: Bool) {
        let previousTask = connectionTask
        previousTask?.cancel()
        connectionID = UUID()
        let sessionID = connectionID
        let rpc = activeRPC
        activeRPC = nil
        transportCoordinator.disconnected()
        transportCoordinator.stop()
        remoteNotifications.configure(authClient: nil)
        notifStore.onNew = nil
        workspaceStore = WorkspaceStore(rpc: OfflineRPCDispatch())
        surfaceStore = SurfaceStore(rpc: OfflineRPCDispatch())
        hostStatusStore = HostStatusStore(rpc: OfflineRPCDispatch())
        notifStore = NotificationStore()
        bootstrapped = false
        connectionTask = Task { @MainActor in
            await rpc?.close()
            await previousTask?.value
            guard connect, sessionID == connectionID, !Task.isCancelled else { return }
            await bootstrapOnce()
        }
    }

    @MainActor
    private func disconnect() {
        startConnection(connect: false)
        do { try computers.unpairSelected() }
        catch { workspaceStore.connection = .error(error.localizedDescription) }
    }

    private func handleDeepLink(_ url: URL) {
        // A `cmux://pair?...` code scanned with the system Camera app lands here
        // rather than in the in-app scanner. Store the connection details and let
        // the user confirm in Settings; pairing is not started automatically.
        if let payload = try? PairingPayload(url: url) {
            transportCoordinator.stop()
            computers.pendingNewComputer = true
            Self.persist(payload, defaults: UserDefaults.standard)
            return
        }
        // cmux://surface/<id> will land with APNs/deep-link handling in M6.
    }

    /// Writes a scanned payload into settings. A payload carrying LAN details
    /// selects `auto` so the phone takes the faster same-Wi-Fi path at home and
    /// the broker elsewhere; a broker-only payload keeps the previous
    /// server-only behaviour.
    static func persist(_ payload: PairingPayload, defaults: UserDefaults) {
        defaults.set(payload.serverURL, forKey: "cmux.brokerURL")
        defaults.set(payload.relayId, forKey: "cmux.relayId")
        defaults.set(payload.pairingCode, forKey: "cmux.pairingCode")
        if payload.hasLAN,
           let lanURL = payload.lanURL,
           let components = URLComponents(string: lanURL),
           let host = components.host,
           !host.isEmpty
        {
            defaults.set(host, forKey: "cmux.host")
            defaults.set(components.port ?? 4399, forKey: "cmux.port")
            defaults.set(payload.lanPairingCode, forKey: "cmux.lanPairingCode")
            defaults.set(TransportPreference.auto.rawValue, forKey: "cmux.transportPreference")
        } else {
            defaults.removeObject(forKey: "cmux.host")
            defaults.removeObject(forKey: "cmux.lanPairingCode")
            defaults.set(TransportPreference.broker.rawValue, forKey: "cmux.transportPreference")
        }
        // Keep the legacy key in step so a downgrade, or any code still reading
        // it, does not silently fall back to a different transport.
        defaults.set(ConnectionMode.broker.rawValue, forKey: "cmux.connectionMode")
    }

    @MainActor
    private func triggerTestNotification() -> TestNotificationResult {
        let workspaceId = workspaceStore.selectedId
            ?? workspaceStore.workspaces.first?.id
            ?? "test-workspace"
        let id = "local-test-\(UUID().uuidString)"
        let record = NotificationRecord(
            id: id,
            workspaceId: workspaceId,
            surfaceId: nil,
            title: L10n.string("cmux test notification"),
            subtitle: L10n.string("Settings → SEND TEST NOTIFICATION"),
            body: L10n.string("It appears in Inbox and should show an iOS banner in the background."),
            ts: Int64(Date().timeIntervalSince1970),
            threadId: "workspace-\(workspaceId)"
        )
        notifStore.append(record)

        let roundTrip: Task<Void, Error>?
        if let rpc = activeRPC {
            roundTrip = Task {
                let response = try await rpc.call(method: "notification.create", params: .object([
                    "workspace_id": .string(workspaceId),
                    "title": .string(L10n.string("cmux round-trip")),
                    "body": .string(L10n.string("relay → cmux → events.stream → iOS")),
                ]))
                _ = try response.requireOk()
            }
        } else {
            roundTrip = nil
        }
        return TestNotificationResult(localInjected: true, roundTrip: roundTrip)
    }

    /// Jailbreak/debugger checks are skipped in DEBUG builds so simulator and
    /// device development does not trip them. There is deliberately no
    /// environment or argument escape hatch: that would ship a bypass path for
    /// the hardening check inside Release builds. Gating on the build
    /// configuration keeps the bypass impossible to reach in production.
    static func shouldSkipHardeningForDevelopment() -> Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    private static func clientIdentifier() -> String {
        if let identifier = UIDevice.current.identifierForVendor?.uuidString {
            return identifier
        }
        let key = "cmux.clientId"
        if let stored = UserDefaults.standard.string(forKey: key), !stored.isEmpty {
            return stored
        }
        let generated = UUID().uuidString
        UserDefaults.standard.set(generated, forKey: key)
        return generated
    }

    static func clearStoredPairingCode(
        afterSuccessfulRegistrationWith endpoint: RelayEndpoint,
        defaults: UserDefaults
    ) {
        // A pairing code is only needed to mint the per-device bearer token, and
        // that token now lives in the Keychain under this endpoint's identity.
        // Do not retain the shared secret afterwards — each transport has its
        // own, so clear only the one that was just consumed.
        guard endpoint.requiresPairingCode else { return }
        switch endpoint.mode {
        case .broker: defaults.removeObject(forKey: "cmux.pairingCode")
        case .direct: defaults.removeObject(forKey: "cmux.lanPairingCode")
        }
    }
}

public struct TestNotificationResult: Sendable {
    public let localInjected: Bool
    public let roundTrip: Task<Void, Error>?
}

actor OfflineRPCDispatch: RPCDispatch {
    func call(method: String, params: JSONValue) async throws -> RPCResponse {
        throw CmuxRemoteRPCError.rpc(code: "offline", message: L10n.string("Configure Mac host in Settings"))
    }
}

actor FakeRPCDispatch: RPCDispatch {
    private var workspaces: [(id: String, title: String)] = [("WS-FAKE", "Demo Workspace")]
    private var surfaces: [(id: String, title: String)] = [("SF-FAKE", "shell")]

    func call(method: String, params: JSONValue) async throws -> RPCResponse {
        switch method {
        case "workspace.list":
            return RPCResponse(id: "fake", result: .object([
                "workspaces": .array(workspaces.enumerated().map { index, workspace in
                    .object([
                        "id": .string(workspace.id),
                        "title": .string(workspace.title),
                        "index": .int(Int64(index)),
                    ])
                }),
            ]))
        case "workspace.create":
            let title: String
            if case .object(let params) = params, case .string(let value)? = params["title"] {
                title = value
            } else if case .object(let params) = params, case .string(let value)? = params["name"] {
                title = value
            } else {
                title = "Terminal \(workspaces.count + 1)"
            }
            let workspaceId = "WS-FAKE-\(workspaces.count + 1)"
            workspaces.append((workspaceId, title))
            if surfaces.isEmpty { surfaces.append(("SF-FAKE", "shell")) }
            return RPCResponse(id: "fake", ok: true, result: .object([
                "workspace_id": .string(workspaceId),
                "workspace": .object([
                    "id": .string(workspaceId),
                    "title": .string(title),
                    "index": .int(Int64(workspaces.count - 1)),
                ]),
            ]))
        case "workspace.rename":
            if case .object(let params) = params,
               case .string(let workspaceId)? = params["workspace_id"],
               case .string(let title)? = params["title"],
               let index = workspaces.firstIndex(where: { $0.id == workspaceId })
            {
                workspaces[index].title = title
            }
            return RPCResponse(id: "fake", ok: true, result: .object([:]))
        case "workspace.close":
            if case .object(let params) = params,
               case .string(let workspaceId)? = params["workspace_id"],
               workspaces.count > 1
            {
                workspaces.removeAll { $0.id == workspaceId }
            }
            return RPCResponse(id: "fake", ok: true, result: .object([:]))
        case "surface.list":
            return RPCResponse(id: "fake", result: .object([
                "surfaces": .array(surfaces.enumerated().map { index, surface in
                    .object([
                        "id": .string(surface.id),
                        "title": .string(surface.title),
                        "index": .int(Int64(index)),
                    ])
                }),
            ]))
        case "surface.create":
            let nextIndex = surfaces.count + 1
            let id = "SF-FAKE-\(nextIndex)"
            surfaces.append((id, "shell \(nextIndex)"))
            return RPCResponse(id: "fake", result: .object(["surface_id": .string(id)]))
        case "surface.close":
            if case .object(let params) = params,
               case .string(let surfaceId)? = params["surface_id"],
               surfaces.count > 1
            {
                surfaces.removeAll { $0.id == surfaceId }
            }
            return RPCResponse(id: "fake", ok: true, result: .object([:]))
        case "surface.subscribe", "surface.unsubscribe", "surface.send_text", "surface.send_key", "surface.focus":
            return RPCResponse(id: "fake", ok: true, result: .object([:]))
        case "host.battery":
            return RPCResponse(id: "fake", ok: true, result: .object([
                "available": .bool(true),
                "percent": .int(88),
                "state": .string("charged"),
                "is_charging": .bool(true),
                "power_source": .string("AC Power"),
            ]))
        case "file.upload":
            return RPCResponse(id: "fake", ok: true, result: .object([
                "filename": .string("demo-image.jpg"),
                "path": .string("/Users/demo/Downloads/cmux-remote/demo-image.jpg"),
                "bytes": .int(42),
                "mime_type": .string("image/jpeg"),
            ]))
        case "surface.read_text":
            return RPCResponse(id: "fake", result: .object(["text": .string("hello from fake relay")]))
        case "surface.history":
            return RPCResponse(id: "fake", result: .object([
                "rows": .array([]),
                "anchor_rows": .array([.string("hello from fake relay")]),
                "next_cursor": .null,
            ]))
        default:
            return RPCResponse(id: "fake", ok: true, result: .object([:]))
        }
    }
}
