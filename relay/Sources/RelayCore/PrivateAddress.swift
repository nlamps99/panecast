import Foundation

/// Classifies remote addresses for the direct transport's LAN pairing path.
///
/// This is deliberately narrow. Only the RFC1918 private ranges and IPv4
/// link-local count as "same LAN": those are the addresses a phone gets from a
/// home router's DHCP. Everything else — public addresses, the CGNAT block
/// Tailscale uses, IPv6, loopback — is excluded so LAN pairing can never
/// substitute for the tailnet identity check on a path where the caller is not
/// provably on the local segment.
public enum PrivateAddress {
    /// True when `addr` is an RFC1918 or IPv4 link-local literal.
    ///
    /// Tailscale's `100.64.0.0/10` is excluded on purpose even though it is
    /// also non-routable: peers arriving from the tailnet must keep proving
    /// their identity through `tailscaled.whois` rather than falling back to a
    /// shared LAN secret.
    public static func isPrivateLAN(_ addr: String) -> Bool {
        guard let octets = ipv4Octets(addr) else { return false }
        switch octets[0] {
        case 10:
            return true
        case 172:
            return (16...31).contains(octets[1])
        case 192:
            return octets[1] == 168
        case 169:
            return octets[1] == 254
        default:
            return false
        }
    }

    /// Parses a bare dotted-quad. Rejects anything carrying a port, a zone id,
    /// or leading zeroes so `010.0.0.1`-style octal ambiguity cannot smuggle a
    /// non-private address past ``isPrivateLAN(_:)``.
    static func ipv4Octets(_ value: String) -> [Int]? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        octets.reserveCapacity(4)
        for part in parts {
            guard !part.isEmpty, part.count <= 3,
                  part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  part.count == 1 || part.first != "0",
                  let octet = Int(part), (0...255).contains(octet)
            else { return nil }
            octets.append(octet)
        }
        return octets
    }
}
