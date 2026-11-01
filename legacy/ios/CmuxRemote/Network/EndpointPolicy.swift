import Foundation

public enum ConnectionMode: String, CaseIterable, Identifiable, Sendable, Codable {
    case direct
    case broker

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .direct: return L10n.string("DIRECT")
        case .broker: return L10n.string("SERVER")
        }
    }
}

public struct RelayEndpoint: Equatable, Sendable, Codable {
    public let mode: ConnectionMode
    public let host: String
    public let port: Int
    public let scheme: String
    public let brokerBaseURL: String
    public let relayId: String

    public static func direct(host: String, port: Int, scheme: String = "http") -> Self {
        .init(
            mode: .direct,
            host: host,
            port: port,
            scheme: scheme,
            brokerBaseURL: "",
            relayId: ""
        )
    }

    public static func broker(baseURL: String, relayId: String) -> Self {
        .init(
            mode: .broker,
            host: "",
            port: 0,
            scheme: "",
            brokerBaseURL: baseURL,
            relayId: relayId
        )
    }

    public func validate() throws {
        switch mode {
        case .direct:
            guard EndpointPolicy.isAllowedRelayHost(host) else { throw AuthError.disallowedHost }
            guard (1...65535).contains(port), ["http", "https"].contains(scheme.lowercased()) else {
                throw AuthError.invalidURL
            }
        case .broker:
            _ = try brokerComponents(webSocket: false, path: "/v1/health")
            guard !relayId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AuthError.missingRelayId
            }
        }
    }

    public func registrationURL() throws -> URL {
        switch mode {
        case .direct:
            try validate()
            guard let url = URL(string: "\(scheme)://\(normalizedHost):\(port)/v1/devices/me/register") else {
                throw AuthError.invalidURL
            }
            return url
        case .broker:
            try validate()
            return try brokerComponents(webSocket: false, path: "/v1/devices/me/register")
        }
    }

    public func apnsURL() throws -> URL {
        switch mode {
        case .direct:
            try validate()
            guard let url = URL(string: "\(scheme)://\(normalizedHost):\(port)/v1/devices/me/apns") else {
                throw AuthError.invalidURL
            }
            return url
        case .broker:
            try validate()
            return try brokerComponents(
                webSocket: false,
                path: "/v1/devices/me/apns",
                queryItems: [URLQueryItem(name: "relay_id", value: normalizedRelayId)]
            )
        }
    }

    /// True when pairing with this endpoint needs a shared code rather than the
    /// relay's tailnet identity check. Broker endpoints always do; direct
    /// endpoints only when the host is on the local network.
    public var requiresPairingCode: Bool {
        switch mode {
        case .broker: return true
        case .direct: return EndpointPolicy.isPrivateLANHost(host)
        }
    }

    /// How this endpoint reaches the relay, for display on the workspace list.
    public var activeTransport: ActiveTransport {
        switch mode {
        case .broker: return .broker
        case .direct: return EndpointPolicy.isPrivateLANHost(host) ? .lan : .tailscale
        }
    }

    /// Unauthenticated liveness endpoint, used to decide whether the LAN path is
    /// reachable before committing to it.
    public func healthURL() throws -> URL {
        switch mode {
        case .direct:
            try validate()
            guard let url = URL(string: "\(scheme)://\(normalizedHost):\(port)/v1/health") else {
                throw AuthError.invalidURL
            }
            return url
        case .broker:
            try validate()
            return try brokerComponents(webSocket: false, path: "/v1/health")
        }
    }

    public func webSocketURL() throws -> URL {
        switch mode {
        case .direct:
            try validate()
            let wsScheme = scheme.lowercased() == "https" ? "wss" : "ws"
            guard let url = URL(string: "\(wsScheme)://\(normalizedHost):\(port)/v1/ws") else {
                throw AuthError.invalidURL
            }
            return url
        case .broker:
            try validate()
            return try brokerComponents(
                webSocket: true,
                path: "/v1/ws",
                queryItems: [URLQueryItem(name: "relay_id", value: normalizedRelayId)]
            )
        }
    }

    public func credentialIdentity() throws -> String {
        try validate()
        switch mode {
        case .direct:
            return "direct|\(scheme.lowercased())://\(normalizedHost):\(port)"
        case .broker:
            let healthURL = try brokerComponents(webSocket: false, path: "/v1/health")
            var components = URLComponents(url: healthURL, resolvingAgainstBaseURL: false)
            let suffix = "/v1/health"
            if components?.path.hasSuffix(suffix) == true {
                components?.path.removeLast(suffix.count)
            }
            return "broker|\(components?.url?.absoluteString ?? brokerBaseURL)|\(normalizedRelayId)"
        }
    }

    public var legacyHost: String? {
        mode == .direct ? normalizedHost : nil
    }

    private var normalizedHost: String {
        host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var normalizedRelayId: String {
        relayId.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func brokerComponents(
        webSocket: Bool,
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URL {
        let raw = brokerBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: raw),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.fragment == nil,
              components.queryItems?.isEmpty != false
        else { throw AuthError.invalidURL }

        let local = EndpointPolicy.isLoopbackHost(host)
        switch components.scheme?.lowercased() {
        case "https": components.scheme = webSocket ? "wss" : "https"
        case "wss": components.scheme = webSocket ? "wss" : "https"
        case "http" where local: components.scheme = webSocket ? "ws" : "http"
        case "ws" where local: components.scheme = webSocket ? "ws" : "http"
        default: throw AuthError.insecureBrokerURL
        }

        var basePath = components.path
        while basePath.hasSuffix("/") { basePath.removeLast() }
        components.path = basePath + path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw AuthError.invalidURL }
        return url
    }
}

extension RelayEndpoint {
    public init(host: String, port: Int = 4399) {
        self = .direct(host: host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), port: port)
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decodeIfPresent(ConnectionMode.self, forKey: .mode) ?? .direct
        host = try values.decodeIfPresent(String.self, forKey: .host) ?? ""
        port = try values.decodeIfPresent(Int.self, forKey: .port) ?? 4399
        scheme = try values.decodeIfPresent(String.self, forKey: .scheme) ?? "http"
        brokerBaseURL = try values.decodeIfPresent(String.self, forKey: .brokerBaseURL) ?? ""
        relayId = try values.decodeIfPresent(String.self, forKey: .relayId) ?? ""
    }

    var key: String { (try? credentialIdentity()) ?? "" }
    var isValid: Bool {
        if mode == .direct, host.contains(where: { $0.isWhitespace || "/:@?#".contains($0) }) { return false }
        return (try? validate()) != nil
    }
}

public enum EndpointPolicy {
    /// Hosts the direct transport may target.
    ///
    /// Two families are allowed, and they authenticate differently:
    /// - Tailnet hosts (`*.ts.net`, `100.64.0.0/10`) pair through
    ///   `tailscaled.whois` on the relay and need no pairing code.
    /// - Private-LAN hosts (RFC1918, IPv4 link-local, `*.local`) pair with the
    ///   relay's `lan.pairing_code`. This path is plain HTTP, so it is only
    ///   appropriate on a network the user trusts — see ``requiresPairingCode``.
    public static func isAllowedRelayHost(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return false }
        if trimmed == "localhost" || trimmed == "127.0.0.1" { return true }
        if trimmed.hasSuffix(".ts.net") { return true }
        if isPrivateLANHost(trimmed) { return true }
        if let ipv4 = IPv4(trimmed) {
            return ipv4.octets[0] == 100 && (64...127).contains(ipv4.octets[1])
        }
        return false
    }

    /// True for hosts that reach the relay over the local network rather than
    /// the tailnet, which is what decides whether a pairing code is required.
    ///
    /// `.local` names are included because that is how Bonjour advertises a
    /// Mac's hostname; resolving one still requires the local-network
    /// permission the app already declares.
    public static func isPrivateLANHost(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return false }
        if trimmed.hasSuffix(".local") { return trimmed.count > ".local".count }
        guard let ipv4 = IPv4(trimmed) else { return false }
        switch ipv4.octets[0] {
        case 10: return true
        case 172: return (16...31).contains(ipv4.octets[1])
        case 192: return ipv4.octets[1] == 168
        case 169: return ipv4.octets[1] == 254
        default: return false
        }
    }

    public static func isAllowedBrokerURL(_ value: String) -> Bool {
        let endpoint = RelayEndpoint.broker(baseURL: value, relayId: "policy-check")
        return (try? endpoint.validate()) != nil
    }

    static func isLoopbackHost(_ host: String) -> Bool {
        ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
    }
}

private struct IPv4 {
    let octets: [Int]

    init?(_ value: String) {
        let parts = value.split(separator: ".")
        guard parts.count == 4 else { return nil }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return nil }
        self.octets = octets
    }
}
