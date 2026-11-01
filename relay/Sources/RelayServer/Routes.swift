import Foundation
import NIOCore
import NIOHTTP1
import Crypto
import RelayCore
import SharedKit

/// Lightweight response envelope. The HTTP layer in M3.11 will translate
/// this into NIOHTTP1 head + body chunks; keeping it small here makes
/// `Routes` independent of the channel pipeline.
public struct HTTPResponseLite: Sendable {
    public var status: HTTPResponseStatus
    public var body: Data?
    public init(_ status: HTTPResponseStatus, body: Data? = nil) {
        self.status = status; self.body = body
    }
}

/// HTTP REST endpoints. Spec section 6.1.
///
/// Actor-isolated because authenticated paths (`apns`, `revoke`) and the
/// register flow can race with `ConfigStore.reload` and the WS handler.
/// The DeviceStore + AuthService it depends on are themselves
/// thread-safe, so this layer just sequences the request handling.
public actor Routes {
    private let deviceStore: DeviceStore
    private let config: RelayConfig
    private let auth: AuthService
    private let allowLocalhost: Bool
    private let pairingLimiter: PairingAttemptLimiter

    public init(deviceStore: DeviceStore,
                config: RelayConfig,
                auth: AuthService,
                allowLocalhost: Bool = Routes.defaultAllowLocalhost(),
                pairingLimiter: PairingAttemptLimiter = PairingAttemptLimiter())
    {
        self.deviceStore = deviceStore
        self.config = config
        self.auth = auth
        self.allowLocalhost = allowLocalhost
        self.pairingLimiter = pairingLimiter
    }

    /// Reads `CMUX_DEV_ALLOW_LOCALHOST=1` from the environment. When true,
    /// loopback callers (`127.0.0.1` / `::1`) bypass `tailscaled.whois` —
    /// macOS short-circuits packets to the local Tailscale IP through `lo0`,
    /// so the iOS Simulator on the same Mac can never produce a remote
    /// address tailscaled will recognise. We keep the bypass opt-in so it
    /// never ships to a production binding.
    public static func defaultAllowLocalhost() -> Bool {
        ProcessInfo.processInfo.environment["CMUX_DEV_ALLOW_LOCALHOST"] == "1"
    }

    /// Top-level dispatch. `deviceId` is `nil` until the HTTP layer has
    /// validated the bearer token (M3.11) — `Routes` itself does not
    /// re-validate, so authenticated paths short-circuit on `deviceId == nil`.
    public func handle(method: HTTPMethod,
                       path: String,
                       body: Data?,
                       deviceId: String?,
                       remoteAddr: String) async -> HTTPResponseLite
    {
        switch (method, path) {
        case (.GET, "/v1/health"):
            return .init(.ok, body: Data(#"{"ok":true}"#.utf8))

        case (.GET, "/v1/state"):
            return state()

        case (.POST, "/v1/devices/me/register"):
            return await registerNew(body: body, remoteAddr: remoteAddr)

        case (.POST, "/v1/devices/me/apns"):
            guard let did = deviceId,
                  deviceStore.lookup(deviceId: did) != nil else {
                return .init(.unauthorized)
            }
            return registerApns(deviceId: did, body: body)

        case (.DELETE, "/v1/devices/me"):
            guard let did = deviceId else { return .init(.unauthorized) }
            try? deviceStore.revoke(deviceId: did)
            return .init(.noContent)

        default:
            return .init(.notFound)
        }
    }

    // MARK: - GET /v1/state

    private func state() -> HTTPResponseLite {
        struct State: Encodable {
            let snippets: [RelayConfig.Snippet]
            let defaultFps: Int
            enum CodingKeys: String, CodingKey {
                case snippets, defaultFps = "default_fps"
            }
        }
        let s = State(snippets: config.snippets, defaultFps: config.defaultFps)
        let body = (try? JSONEncoder().encode(s)) ?? Data()
        return .init(.ok, body: body)
    }

    // MARK: - POST /v1/devices/me/apns

    private func registerApns(deviceId: String, body: Data?) -> HTTPResponseLite {
        struct Payload: Decodable {
            let apnsToken: String
            let env: String
            enum CodingKeys: String, CodingKey {
                case apnsToken = "apns_token", env
            }
        }
        guard let body,
              let p = try? JSONDecoder().decode(Payload.self, from: body),
              Self.isAPNsToken(p.apnsToken) else {
            return .init(.badRequest)
        }
        guard p.env == "prod" || p.env == "sandbox" else {
            return .init(.badRequest)
        }
        try? deviceStore.setAPNsToken(deviceId: deviceId,
                                      token: p.apnsToken, env: p.env)
        return .init(.noContent)
    }

    private static func isAPNsToken(_ token: String) -> Bool {
        !token.isEmpty && token.utf8.count.isMultiple(of: 2) && token.utf8.allSatisfy { byte in
            (48...57).contains(byte)
                || (65...70).contains(byte)
                || (97...102).contains(byte)
        }
    }

    // MARK: - POST /v1/devices/me/register

    private func registerNew(body: Data?, remoteAddr: String) async -> HTTPResponseLite {
        let peer: PeerIdentity
        if let request = Self.decodeLANPairing(body) {
            switch lanPeer(for: request, remoteAddr: remoteAddr) {
            case .peer(let identity):
                peer = identity
            case .rejected(let response):
                return response
            }
        } else if allowLocalhost, Self.isLoopback(remoteAddr), let login = config.allowLogin.first {
            // Dev bypass — see `defaultAllowLocalhost()`. The peer identity
            // is fabricated from the first allow_login so the simulator can
            // pair without traversing tailscaled. nodeKey is a stable
            // synthetic value so re-registering yields the same deviceId.
            peer = PeerIdentity(
                loginName: login,
                hostname: "localhost-dev",
                os: "ios-simulator",
                nodeKey: "cmux-dev-localhost:\(login)"
            )
        } else {
            do {
                peer = try await auth.whois(remoteAddr: remoteAddr)
            } catch RelayError.unauthorized {
                // tailscaled didn't recognize the peer at all — treat as
                // forbidden so the phone shows a clear "not on tailnet" UI
                // rather than a 5xx that suggests a relay bug.
                return .init(.forbidden)
            } catch {
                return .init(.internalServerError)
            }

            guard config.allowLogin.contains(peer.loginName) else {
                return .init(.forbidden)
            }
        }

        let deviceId = sha256Hex(peer.nodeKey)
        // Idempotent: rebinding the same node rotates the bearer so the
        // previous token (which may have leaked) is no longer valid.
        try? deviceStore.revoke(deviceId: deviceId)
        do {
            let token = try deviceStore.register(deviceId: deviceId,
                                                 loginName: peer.loginName,
                                                 hostname: peer.hostname,
                                                 apnsToken: nil)
            struct R: Encodable {
                let device_id: String
                let token: String
            }
            let body = try JSONEncoder().encode(R(device_id: deviceId, token: token))
            return .init(.ok, body: body)
        } catch {
            return .init(.internalServerError)
        }
    }
}

private func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

// MARK: - LAN pairing

extension Routes {
    /// Body of a LAN pairing registration. Shaped like the broker's register
    /// payload so the phone can reuse one request builder for both transports.
    /// `relay_id` is absent: the direct transport addresses one Mac by host, so
    /// there is nothing to disambiguate.
    struct LANPairingRequest: Decodable {
        let pairingCode: String
        let clientId: String
        let deviceName: String

        enum CodingKeys: String, CodingKey {
            case pairingCode = "pairing_code"
            case clientId = "client_id"
            case deviceName = "device_name"
        }
    }

    /// Returns the decoded pairing request, or nil when the caller sent no body
    /// — the Tailscale path, which stays on `tailscaled.whois`. A body that is
    /// present but unparseable also returns nil so a malformed request falls
    /// through to whois and is rejected there rather than silently treated as
    /// an anonymous LAN attempt.
    static func decodeLANPairing(_ body: Data?) -> LANPairingRequest? {
        guard let body, !body.isEmpty,
              let request = try? JSONDecoder().decode(LANPairingRequest.self, from: body),
              !request.pairingCode.isEmpty,
              !request.clientId.isEmpty,
              !request.deviceName.isEmpty
        else { return nil }
        return request
    }

    /// Outcome of validating a LAN pairing attempt: either the synthesised peer
    /// identity to register, or the response to return as-is.
    enum LANPairingOutcome {
        case peer(PeerIdentity)
        case rejected(HTTPResponseLite)
    }

    /// Validates a LAN pairing attempt and synthesises the peer identity it
    /// registers under.
    ///
    /// Order matters: the rate limiter is charged before the secret is compared,
    /// so a caller cannot get unlimited guesses by racing. The caller must also
    /// arrive from an RFC1918 address — the shared code alone is not enough,
    /// because it would otherwise authorise anyone who could reach the port.
    private func lanPeer(
        for request: LANPairingRequest,
        remoteAddr: String
    ) -> LANPairingOutcome {
        guard let lan = config.lan, lan.enablesPairing else {
            return .rejected(.init(.forbidden))
        }
        guard PrivateAddress.isPrivateLAN(remoteAddr) else {
            return .rejected(.init(.forbidden))
        }
        guard pairingLimiter.allow(key: remoteAddr) else {
            return .rejected(.init(.tooManyRequests))
        }
        guard Self.secretsMatch(request.pairingCode, lan.pairingCode) else {
            return .rejected(.init(.forbidden))
        }
        // `nodeKey` is what `registerNew` hashes into the device id, so keying
        // it on the phone's stable client id makes re-pairing the same handset
        // idempotent — matching how a tailnet peer's node key behaves.
        return .peer(PeerIdentity(
            loginName: "lan-pairing",
            hostname: request.deviceName,
            os: "ios",
            nodeKey: "cmux-lan-pairing:\(request.clientId)"
        ))
    }

    /// Constant-time comparison, so a wrong code cannot be recovered one byte
    /// at a time from response timing. Length is compared first because it is
    /// not secret in the way the contents are.
    static func secretsMatch(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        guard !a.isEmpty, a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in a.indices {
            difference |= a[index] ^ b[index]
        }
        return difference == 0
    }
}

extension Routes {
    static func isLoopback(_ addr: String) -> Bool {
        addr == "127.0.0.1" || addr == "::1" || addr == "0:0:0:0:0:0:0:1"
    }
}
