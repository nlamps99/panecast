import Foundation

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Finds this host's private IPv4 address, for printing LAN pairing details.
///
/// Only used by `cmux-relay pair` to fill in the QR code, so a wrong guess is
/// recoverable: the operator can override it with `--lan-host`.
public enum LANAddress {
    /// Returns the first RFC1918 address on an up, non-loopback interface.
    ///
    /// Interfaces are preferred in name order with the usual Wi-Fi/Ethernet
    /// devices first, because a Mac running Docker or a VPN typically has
    /// several private addresses and only the router-assigned one is reachable
    /// from the phone.
    public static func primaryIPv4() -> String? {
        let candidates = privateIPv4Addresses()
        for prefix in preferredInterfacePrefixes {
            if let match = candidates.first(where: { $0.interface.hasPrefix(prefix) }) {
                return match.address
            }
        }
        return candidates.first?.address
    }

    /// `en` covers Wi-Fi and Ethernet on macOS. Everything else (bridge devices,
    /// `utun` VPN tunnels, Docker's `vmenet`) is only considered as a fallback.
    static let preferredInterfacePrefixes = ["en"]

    /// Enumerates up, running, non-loopback interfaces carrying an RFC1918
    /// IPv4 address, in the order the system reports them.
    public static func privateIPv4Addresses() -> [(interface: String, address: String)] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }

        var found: [(interface: String, address: String)] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(pointer.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP,
                  flags & IFF_LOOPBACK == 0,
                  let sockaddr = pointer.pointee.ifa_addr,
                  sockaddr.pointee.sa_family == UInt8(AF_INET)
            else { continue }

            var storage = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sockaddr, socklen_t(sockaddr.pointee.sa_len),
                              &storage, socklen_t(storage.count),
                              nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let address = String(cString: storage)
            guard PrivateAddress.isPrivateLAN(address) else { continue }
            found.append((String(cString: pointer.pointee.ifa_name), address))
        }
        return found
    }
}
