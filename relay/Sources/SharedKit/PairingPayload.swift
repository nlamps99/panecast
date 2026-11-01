import Foundation

/// The connection details a phone needs to pair with a relay.
///
/// Encoded as a `cmux://pair?...` URL so it can be carried by a QR code. The
/// custom scheme is deliberate: it is not a tappable https link, so a screenshot
/// posted somewhere is less likely to be opened by a browser, and iOS routes it
/// straight back into the app.
///
/// One payload can carry both transports. The broker fields are always present;
/// `lanURL`/`lanPairingCode` are optional and, when set, let the phone prefer a
/// same-Wi-Fi direct connection and fall back to the broker off-network. Older
/// QR codes decode unchanged because the LAN fields are additive.
///
/// This payload contains pairing codes in the clear. That is inherent to any
/// scan-to-pair flow — treat the QR code itself as a secret, the same way as the
/// codes it carries.
public struct PairingPayload: Equatable, Sendable {
    public var serverURL: String
    public var relayId: String
    public var pairingCode: String
    public var lanURL: String?
    public var lanPairingCode: String?

    public init(
        serverURL: String,
        relayId: String,
        pairingCode: String,
        lanURL: String? = nil,
        lanPairingCode: String? = nil
    ) {
        self.serverURL = serverURL
        self.relayId = relayId
        self.pairingCode = pairingCode
        self.lanURL = lanURL
        self.lanPairingCode = lanPairingCode
    }

    /// True when the payload carries a usable LAN direct endpoint.
    public var hasLAN: Bool {
        guard let lanURL, !lanURL.isEmpty,
              let lanPairingCode, !lanPairingCode.isEmpty
        else { return false }
        return true
    }

    public enum DecodeError: Error, Equatable {
        case notAPairingURL
        case missingField(String)
    }

    public static let scheme = "cmux"
    public static let host = "pair"

    /// Percent-encodes every field, so a pairing code containing URL-significant
    /// characters survives the round trip.
    public func url() -> URL? {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        var items = [
            URLQueryItem(name: "server", value: serverURL),
            URLQueryItem(name: "relay", value: relayId),
            URLQueryItem(name: "code", value: pairingCode),
        ]
        if hasLAN {
            items.append(URLQueryItem(name: "lan", value: lanURL))
            items.append(URLQueryItem(name: "lancode", value: lanPairingCode))
        }
        components.queryItems = items
        return components.url
    }

    public func urlString() throws -> String {
        guard let string = url()?.absoluteString else {
            throw DecodeError.notAPairingURL
        }
        return string
    }

    public init(url: URL) throws {
        guard url.scheme?.lowercased() == Self.scheme,
              url.host?.lowercased() == Self.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw DecodeError.notAPairingURL }

        func raw(_ name: String) -> String? {
            guard let value = components.queryItems?.first(where: { $0.name == name })?.value,
                  !value.isEmpty
            else { return nil }
            return value
        }

        func value(_ name: String) throws -> String {
            guard let value = raw(name) else { throw DecodeError.missingField(name) }
            return value
        }

        self.serverURL = try value("server")
        self.relayId = try value("relay")
        self.pairingCode = try value("code")
        // Both LAN fields or neither: a URL without its code (or the reverse)
        // cannot pair, and silently keeping half of it would surface later as a
        // confusing pairing failure rather than "this QR has no LAN details".
        let lanURL = raw("lan")
        let lanCode = raw("lancode")
        if lanURL != nil, lanCode != nil {
            self.lanURL = lanURL
            self.lanPairingCode = lanCode
        } else {
            self.lanURL = nil
            self.lanPairingCode = nil
        }
    }

    public init(urlString: String) throws {
        guard let url = URL(string: urlString) else { throw DecodeError.notAPairingURL }
        try self.init(url: url)
    }
}
