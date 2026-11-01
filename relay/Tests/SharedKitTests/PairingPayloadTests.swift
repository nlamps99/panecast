import XCTest
@testable import SharedKit

final class PairingPayloadTests: XCTestCase {
    private let payload = PairingPayload(
        serverURL: "https://relay.example.com/cmux-remote",
        relayId: "home-mac",
        pairingCode: "deadbeef0123456789abcdef"
    )

    func testRoundTripsThroughURL() throws {
        let decoded = try PairingPayload(urlString: try payload.urlString())
        XCTAssertEqual(decoded, payload)
    }

    /// A base64/hex pairing code can contain `+`, `/` and `=`, which are all
    /// URL-significant. They must survive the round trip untouched.
    func testPreservesURLSignificantCharactersInTheCode() throws {
        let tricky = PairingPayload(
            serverURL: "https://relay.example.com",
            relayId: "home-mac",
            pairingCode: "a+b/c=d&e?f"
        )
        let decoded = try PairingPayload(urlString: try tricky.urlString())
        XCTAssertEqual(decoded.pairingCode, "a+b/c=d&e?f")
    }

    func testPreservesPathInServerURL() throws {
        let decoded = try PairingPayload(urlString: try payload.urlString())
        XCTAssertEqual(decoded.serverURL, "https://relay.example.com/cmux-remote")
    }

    func testRejectsForeignSchemes() {
        XCTAssertThrowsError(
            try PairingPayload(urlString: "https://pair?server=a&relay=b&code=c")
        ) { error in
            XCTAssertEqual(error as? PairingPayload.DecodeError, .notAPairingURL)
        }
    }

    func testRejectsOtherCmuxDeepLinks() {
        XCTAssertThrowsError(
            try PairingPayload(urlString: "cmux://surface/SF-1")
        ) { error in
            XCTAssertEqual(error as? PairingPayload.DecodeError, .notAPairingURL)
        }
    }

    func testRejectsMissingAndEmptyFields() {
        XCTAssertThrowsError(
            try PairingPayload(urlString: "cmux://pair?server=a&relay=b")
        ) { error in
            XCTAssertEqual(error as? PairingPayload.DecodeError, .missingField("code"))
        }
        XCTAssertThrowsError(
            try PairingPayload(urlString: "cmux://pair?server=a&relay=&code=c")
        ) { error in
            XCTAssertEqual(error as? PairingPayload.DecodeError, .missingField("relay"))
        }
    }

    // MARK: - LAN half

    private let withLAN = PairingPayload(
        serverURL: "https://relay.example.com",
        relayId: "home-mac",
        pairingCode: "broker-code",
        lanURL: "http://192.168.1.42:4399",
        lanPairingCode: "lan-code"
    )

    func testRoundTripsLANFields() throws {
        let decoded = try PairingPayload(urlString: try withLAN.urlString())
        XCTAssertEqual(decoded, withLAN)
        XCTAssertTrue(decoded.hasLAN)
    }

    /// Older QR codes carry no LAN fields and must still decode.
    func testBrokerOnlyPayloadHasNoLAN() throws {
        let decoded = try PairingPayload(urlString: try payload.urlString())
        XCTAssertFalse(decoded.hasLAN)
        XCTAssertNil(decoded.lanURL)
        XCTAssertNil(decoded.lanPairingCode)
    }

    func testBrokerOnlyPayloadOmitsLANQueryItems() throws {
        let urlString = try payload.urlString()
        XCTAssertFalse(urlString.contains("lan"))
    }

    /// Half a LAN config cannot pair, so it is dropped rather than kept — the
    /// phone should report "no LAN details" instead of failing later at connect.
    func testDropsPartialLANFields() throws {
        let urlOnly = try PairingPayload(
            urlString: "cmux://pair?server=https://s&relay=r&code=c&lan=http://192.168.1.5:4399"
        )
        XCTAssertFalse(urlOnly.hasLAN)
        XCTAssertNil(urlOnly.lanURL)

        let codeOnly = try PairingPayload(
            urlString: "cmux://pair?server=https://s&relay=r&code=c&lancode=x"
        )
        XCTAssertFalse(codeOnly.hasLAN)
        XCTAssertNil(codeOnly.lanPairingCode)
    }

    func testHasLANIsFalseForEmptyStrings() {
        let empty = PairingPayload(
            serverURL: "https://s",
            relayId: "r",
            pairingCode: "c",
            lanURL: "",
            lanPairingCode: ""
        )
        XCTAssertFalse(empty.hasLAN)
    }
}
