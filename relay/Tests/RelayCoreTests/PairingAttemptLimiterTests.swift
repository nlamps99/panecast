import XCTest
@testable import RelayCore

final class PairingAttemptLimiterTests: XCTestCase {
    func testAllowsUpToLimitThenRejects() {
        let limiter = PairingAttemptLimiter(limit: 3, window: 60, clock: FakeClock())
        XCTAssertTrue(limiter.allow(key: "192.168.1.5"))
        XCTAssertTrue(limiter.allow(key: "192.168.1.5"))
        XCTAssertTrue(limiter.allow(key: "192.168.1.5"))
        XCTAssertFalse(limiter.allow(key: "192.168.1.5"))
    }

    func testBucketsAreIndependentPerKey() {
        let limiter = PairingAttemptLimiter(limit: 1, window: 60, clock: FakeClock())
        XCTAssertTrue(limiter.allow(key: "192.168.1.5"))
        XCTAssertFalse(limiter.allow(key: "192.168.1.5"))
        XCTAssertTrue(limiter.allow(key: "192.168.1.6"))
    }

    func testAttemptsExpireAfterWindow() {
        let clock = FakeClock()
        let limiter = PairingAttemptLimiter(limit: 2, window: 60, clock: clock)
        XCTAssertTrue(limiter.allow(key: "10.0.0.2"))
        XCTAssertTrue(limiter.allow(key: "10.0.0.2"))
        XCTAssertFalse(limiter.allow(key: "10.0.0.2"))
        clock.advance(by: 61)
        XCTAssertTrue(limiter.allow(key: "10.0.0.2"))
    }

    /// A relay that runs for months must not keep a bucket for every address
    /// that ever probed the port.
    func testDropsEmptyBucketsAsWindowsExpire() {
        let clock = FakeClock()
        let limiter = PairingAttemptLimiter(limit: 5, window: 60, clock: clock)
        for octet in 1...20 {
            XCTAssertTrue(limiter.allow(key: "192.168.1.\(octet)"))
        }
        XCTAssertEqual(limiter.trackedKeyCount, 20)
        clock.advance(by: 61)
        XCTAssertTrue(limiter.allow(key: "10.1.1.1"))
        XCTAssertEqual(limiter.trackedKeyCount, 1)
    }
}
