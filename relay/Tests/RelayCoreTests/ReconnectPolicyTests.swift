import XCTest
@testable import RelayCore

final class ReconnectPolicyTests: XCTestCase {
    func testBackoffSequenceIsCappedExponential() {
        var p = ReconnectPolicy(base: 0.5, cap: 8.0)
        XCTAssertEqual(p.nextDelay(), 0.5, accuracy: 1e-9)
        XCTAssertEqual(p.nextDelay(), 1.0, accuracy: 1e-9)
        XCTAssertEqual(p.nextDelay(), 2.0, accuracy: 1e-9)
        XCTAssertEqual(p.nextDelay(), 4.0, accuracy: 1e-9)
        XCTAssertEqual(p.nextDelay(), 8.0, accuracy: 1e-9)
        XCTAssertEqual(p.nextDelay(), 8.0, accuracy: 1e-9, "stays capped")
    }

    func testResetReturnsToBase() {
        var p = ReconnectPolicy(base: 0.5, cap: 8.0)
        _ = p.nextDelay()
        _ = p.nextDelay()
        p.reset()
        XCTAssertEqual(p.nextDelay(), 0.5, accuracy: 1e-9)
    }
}
