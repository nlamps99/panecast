import Foundation

/// Which transport the user wants the app to use.
///
/// Distinct from ``ConnectionMode``, which names the transport actually in use:
/// `auto` is a preference that resolves to one of the concrete modes at connect
/// time, so `RelayEndpoint` never has to represent an unresolved state.
public enum TransportPreference: String, CaseIterable, Identifiable, Sendable, Codable {
    case direct
    case broker
    case auto

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .direct: return L10n.string("DIRECT")
        case .broker: return L10n.string("SERVER")
        case .auto: return L10n.string("AUTO")
        }
    }
}

/// The endpoints available to choose between, plus the pairing secret each needs.
public struct TransportCandidates: Sendable, Equatable {
    public var lan: RelayEndpoint?
    public var lanPairingCode: String
    public var broker: RelayEndpoint?
    public var brokerPairingCode: String

    public init(
        lan: RelayEndpoint? = nil,
        lanPairingCode: String = "",
        broker: RelayEndpoint? = nil,
        brokerPairingCode: String = ""
    ) {
        self.lan = lan
        self.lanPairingCode = lanPairingCode
        self.broker = broker
        self.brokerPairingCode = brokerPairingCode
    }
}

/// A resolved choice: the endpoint to connect to and the code to pair with.
public struct SelectedTransport: Sendable, Equatable {
    public let endpoint: RelayEndpoint
    public let pairingCode: String

    public init(endpoint: RelayEndpoint, pairingCode: String) {
        self.endpoint = endpoint
        self.pairingCode = pairingCode
    }
}

/// Picks between the LAN relay and the VPS broker.
///
/// `auto` prefers the LAN endpoint because it avoids two public-internet legs,
/// but only after a liveness probe confirms it answers — a Wi-Fi SSID or an
/// interface type cannot tell us the Mac is on this network (a phone on
/// guest Wi-Fi, a different subnet, or the Mac asleep all look identical from
/// the radio's point of view). The probe is the only signal that does.
public struct TransportSelector: Sendable {
    /// Kept short: it runs before the first connection, so the user is watching
    /// a spinner. Off-network this is the added delay before falling back, and a
    /// LAN round trip that cannot finish inside this window would not have made
    /// a good interactive terminal anyway.
    public static let probeTimeout: TimeInterval = 1.2

    private let http: any HTTPClientFacade
    private let timeout: TimeInterval

    public init(http: any HTTPClientFacade, timeout: TimeInterval = TransportSelector.probeTimeout) {
        self.http = http
        self.timeout = timeout
    }

    public func select(
        preference: TransportPreference,
        candidates: TransportCandidates
    ) async -> SelectedTransport? {
        switch preference {
        case .direct:
            return candidates.lan.map {
                SelectedTransport(endpoint: $0, pairingCode: candidates.lanPairingCode)
            }
        case .broker:
            return candidates.broker.map {
                SelectedTransport(endpoint: $0, pairingCode: candidates.brokerPairingCode)
            }
        case .auto:
            if let lan = candidates.lan, await isReachable(lan) {
                return SelectedTransport(endpoint: lan, pairingCode: candidates.lanPairingCode)
            }
            if let broker = candidates.broker {
                return SelectedTransport(endpoint: broker, pairingCode: candidates.brokerPairingCode)
            }
            // No broker configured: still try the LAN endpoint rather than
            // reporting "nothing configured", so the failure the user sees comes
            // from the connection attempt and names a real cause.
            return candidates.lan.map {
                SelectedTransport(endpoint: $0, pairingCode: candidates.lanPairingCode)
            }
        }
    }

    /// GETs `/v1/health`. Any non-200, timeout, or transport error counts as
    /// unreachable — this only decides which endpoint to try first, so being
    /// wrong costs one fallback rather than a broken connection.
    public func isReachable(_ endpoint: RelayEndpoint) async -> Bool {
        guard let url = try? endpoint.healthURL() else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (_, status) = try? await http.request(request) else { return false }
        return status == 200
    }
}
