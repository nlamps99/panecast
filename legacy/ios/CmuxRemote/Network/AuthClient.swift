import Foundation

public protocol HTTPClientFacade: Sendable {
    func request(_ request: URLRequest) async throws -> (Data, Int)
}

public final class URLSessionHTTP: HTTPClientFacade, @unchecked Sendable {
    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func request(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, code)
    }
}

public final class AuthClient: @unchecked Sendable {
    public let endpoint: RelayEndpoint
    public let keychain: Keychain
    public let http: any HTTPClientFacade
    public let pairingCode: String
    public let clientId: String
    public let deviceName: String

    public init(host: String, port: Int, keychain: Keychain, http: any HTTPClientFacade, scheme: String = "http") {
        self.endpoint = .direct(host: host, port: port, scheme: scheme)
        self.keychain = keychain
        self.http = http
        self.pairingCode = ""
        self.clientId = ""
        self.deviceName = ""
    }

    public init(
        endpoint: RelayEndpoint,
        keychain: Keychain,
        http: any HTTPClientFacade,
        pairingCode: String = "",
        clientId: String = "",
        deviceName: String = ""
    ) {
        self.endpoint = endpoint
        self.keychain = keychain
        self.http = http
        self.pairingCode = pairingCode
        self.clientId = clientId
        self.deviceName = deviceName
    }

    public func registerIfNeeded() async throws {
        try endpoint.validate()
        let identity = try endpoint.credentialIdentity()
        migrateLegacyCredentialsIfNeeded(identity: identity)
        if try credential(.bearer, identity: identity) != nil,
           try credential(.deviceId, identity: identity) != nil {
            return
        }
        var request = URLRequest(url: try endpoint.registrationURL())
        request.httpMethod = "POST"
        if endpoint.requiresPairingCode {
            guard !pairingCode.isEmpty else { throw AuthError.missingPairingCode }
            guard !clientId.isEmpty, !deviceName.isEmpty else { throw AuthError.invalidRegistration }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            // The direct-LAN relay identifies one Mac by host, so it takes the
            // same body minus `relay_id`.
            if endpoint.mode == .broker {
                request.httpBody = try JSONEncoder().encode(BrokerRegisterRequest(
                    relayId: endpoint.relayId.trimmingCharacters(in: .whitespacesAndNewlines),
                    pairingCode: pairingCode,
                    clientId: clientId,
                    deviceName: deviceName
                ))
            } else {
                request.httpBody = try JSONEncoder().encode(LANRegisterRequest(
                    pairingCode: pairingCode,
                    clientId: clientId,
                    deviceName: deviceName
                ))
            }
        }
        let (data, code) = try await http.request(request)
        guard code == 200 else { throw AuthError.relayRejected(code) }
        let payload = try JSONDecoder().decode(RegisterResponse.self, from: data)
        try await MainActor.run {
            try Task.checkCancellation()
            try setCredential(.deviceId, payload.deviceId, identity: identity)
            try setCredential(.bearer, payload.token, identity: identity)
        }
    }

    /// The bearer + device id currently held for this endpoint, or nil when the
    /// endpoint has never paired.
    public func storedCredentials() throws -> (token: String, deviceId: String)? {
        let identity = try endpoint.credentialIdentity()
        guard let token = try credential(.bearer, identity: identity),
              let deviceId = try credential(.deviceId, identity: identity)
        else { return nil }
        return (token, deviceId)
    }

    public func registerAPNsTokenHex(
        _ tokenHex: String,
        environment: APNsRegistrationEnvironment
    ) async throws {
        try endpoint.validate()
        let identity = try endpoint.credentialIdentity()
        guard !tokenHex.isEmpty else { throw AuthError.invalidAPNsToken }
        guard let bearer = try credential(.bearer, identity: identity),
              try credential(.deviceId, identity: identity) != nil
        else {
            throw AuthError.missingBearer
        }
        var request = URLRequest(url: try endpoint.apnsURL())
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(APNsRegistrationRequest(
            apnsToken: tokenHex,
            env: environment.rawValue
        ))
        let (_, code) = try await http.request(request)
        guard code == 204 else { throw AuthError.relayRejected(code) }
    }

    public func wipe() throws {
        try Self.removeCredentials(endpoint: endpoint, keychain: keychain)
    }

    static func removeCredentials(endpoint: RelayEndpoint, keychain: Keychain) throws {
        let identity = try endpoint.credentialIdentity()
        for kind in [CredentialKind.bearer, .deviceId] {
            try keychain.delete(keychainKey(kind, identity: identity))
        }
    }

    static func migrateLegacyCredentials(endpoint: RelayEndpoint, keychain: Keychain) throws {
        let identity = try endpoint.credentialIdentity()
        let bearerKey = keychainKey(.bearer, identity: identity)
        let deviceKey = keychainKey(.deviceId, identity: identity)
        if endpoint.mode == .direct {
            let oldKey = "relay.credentials.\(endpoint.scheme)://\(endpoint.host.lowercased()):\(endpoint.port)"
            if let raw = try keychain.get(oldKey) {
                let record = try JSONDecoder().decode(RegisterResponse.self, from: Data(raw.utf8))
                if try keychain.get(bearerKey) == nil {
                    try keychain.set(record.deviceId, for: deviceKey)
                    try keychain.set(record.token, for: bearerKey)
                }
                try keychain.delete(oldKey)
            }
        }
        let legacyIdentity = try keychain.get("relay_endpoint")
        let legacyHost = try keychain.get("relay_host")
        let matches = legacyIdentity == identity || (legacyIdentity == nil && endpoint.mode == .direct
            && legacyHost?.lowercased() == endpoint.host.lowercased())
        if matches, let bearer = try keychain.get("bearer"), let device = try keychain.get("device_id") {
            if try keychain.get(bearerKey) == nil {
                try keychain.set(device, for: deviceKey)
                try keychain.set(bearer, for: bearerKey)
            }
            for key in ["bearer", "device_id", "relay_endpoint", "relay_host"] { try keychain.delete(key) }
        }
    }

    // MARK: - Per-endpoint credential storage

    /// Credentials are stored under a key that includes the endpoint identity,
    /// so a phone that alternates between the LAN relay and the broker keeps
    /// both bearers. The two transports mint tokens from separate device stores
    /// — the Mac's `devices.json` and the broker's — so one cannot stand in for
    /// the other, and overwriting on every switch would force a re-pair that
    /// the broker cannot satisfy once its one-time pairing code is consumed.
    enum CredentialKind: String {
        case bearer
        case deviceId = "device_id"
    }

    static func keychainKey(_ kind: CredentialKind, identity: String) -> String {
        "\(kind.rawValue)|\(identity)"
    }

    private func credential(_ kind: CredentialKind, identity: String) throws -> String? {
        try keychain.get(Self.keychainKey(kind, identity: identity))
    }

    private func setCredential(_ kind: CredentialKind, _ value: String, identity: String) throws {
        try keychain.set(value, for: Self.keychainKey(kind, identity: identity))
    }

    /// Moves a pre-namespacing install's credentials onto the new key for the
    /// endpoint they belonged to, so upgrading does not silently re-pair.
    ///
    /// Failures are ignored: the fallback is a normal registration, which is
    /// what an un-migrated install would have done anyway.
    private func migrateLegacyCredentialsIfNeeded(identity: String) {
        guard (try? credential(.bearer, identity: identity)) == nil else { return }
        guard let legacyToken = try? keychain.get("bearer"),
              let legacyDeviceId = try? keychain.get("device_id"),
              let legacyIdentity = try? keychain.get("relay_endpoint"),
              legacyIdentity == identity
        else { return }
        try? setCredential(.bearer, legacyToken, identity: identity)
        try? setCredential(.deviceId, legacyDeviceId, identity: identity)
        try? keychain.delete("bearer")
        try? keychain.delete("device_id")
        try? keychain.delete("relay_endpoint")
        try? keychain.delete("relay_host")
    }
}

private struct RegisterResponse: Decodable {
    let deviceId: String
    let token: String

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case token
    }
}

private struct APNsRegistrationRequest: Encodable {
    let apnsToken: String
    let env: String

    enum CodingKeys: String, CodingKey {
        case apnsToken = "apns_token"
        case env
    }
}

private struct BrokerRegisterRequest: Encodable {
    let relayId: String
    let pairingCode: String
    let clientId: String
    let deviceName: String

    enum CodingKeys: String, CodingKey {
        case relayId = "relay_id"
        case pairingCode = "pairing_code"
        case clientId = "client_id"
        case deviceName = "device_name"
    }
}

private struct LANRegisterRequest: Encodable {
    let pairingCode: String
    let clientId: String
    let deviceName: String

    enum CodingKeys: String, CodingKey {
        case pairingCode = "pairing_code"
        case clientId = "client_id"
        case deviceName = "device_name"
    }
}

public enum APNsRegistrationEnvironment: String, Codable, Sendable, Equatable {
    case sandbox
    case prod
}

public enum AuthError: Error, Equatable {
    case invalidURL
    case disallowedHost
    case insecureBrokerURL
    case missingRelayId
    case missingPairingCode
    case invalidRegistration
    case missingBearer
    case invalidAPNsToken
    case relayRejected(Int)
}

extension AuthError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidURL: return L10n.string("Invalid relay URL")
        case .disallowedHost: return L10n.string("Direct mode needs a Tailscale host or a private LAN address")
        case .insecureBrokerURL: return L10n.string("Server mode requires an HTTPS URL")
        case .missingRelayId: return L10n.string("Relay ID is required")
        case .missingPairingCode: return L10n.string("Pairing code is required")
        case .invalidRegistration: return L10n.string("This device could not create a pairing identity")
        case .missingBearer: return L10n.string("This device is not paired")
        case .invalidAPNsToken: return L10n.string("Invalid APNs token")
        case .relayRejected(let code): return L10n.format("Relay rejected the request (HTTP %lld)", code)
        }
    }
}
