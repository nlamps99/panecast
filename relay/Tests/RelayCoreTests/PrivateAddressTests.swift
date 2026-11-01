import XCTest
@testable import RelayCore

final class PrivateAddressTests: XCTestCase {
    func testAcceptsRFC1918Ranges() {
        XCTAssertTrue(PrivateAddress.isPrivateLAN("10.0.0.1"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("10.255.255.254"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("172.16.0.1"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("172.31.255.1"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("192.168.1.5"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("169.254.10.20"))
    }

    func testRejectsAddressesOutsidePrivateRanges() {
        XCTAssertFalse(PrivateAddress.isPrivateLAN("172.15.0.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("172.32.0.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.169.0.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("8.8.8.8"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("169.253.0.1"))
    }

    /// The tailnet range is non-routable too, but peers arriving from it must
    /// keep proving identity through whois rather than a shared LAN secret.
    func testRejectsTailscaleCGNATRange() {
        XCTAssertFalse(PrivateAddress.isPrivateLAN("100.64.0.5"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("100.115.102.6"))
    }

    func testRejectsLoopbackAndNonIPv4() {
        XCTAssertFalse(PrivateAddress.isPrivateLAN("127.0.0.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("::1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("fe80::1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN(""))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("mac.local"))
    }

    /// A port-carrying address must not be mistaken for a bare one: the caller
    /// passes `remoteAddr` straight through, and accepting `10.0.0.1:5` here
    /// would widen what counts as private.
    func testRejectsMalformedLiterals() {
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.1.5:4399"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.1.5.6"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.1.256"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.1.-1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168..1"))
    }

    /// Leading zeroes read as octal in some parsers; rejecting them keeps one
    /// spelling per address so the check cannot be bypassed by re-encoding.
    func testRejectsLeadingZeroOctets() {
        XCTAssertFalse(PrivateAddress.isPrivateLAN("010.0.0.1"))
        XCTAssertFalse(PrivateAddress.isPrivateLAN("192.168.01.5"))
        XCTAssertTrue(PrivateAddress.isPrivateLAN("10.0.0.0"))
    }
}
