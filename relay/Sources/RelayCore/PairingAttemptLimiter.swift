import Foundation

/// Sliding-window limiter for pairing attempts, keyed by caller address.
///
/// The LAN pairing path compares a shared secret, so it needs a brake on
/// guessing: without one, any host on the Wi-Fi could grind the code offline at
/// wire speed. Mirrors the broker's `SlidingWindowRateLimiter` (5 attempts per
/// minute per IP) so both transports fail the same way under abuse.
///
/// Entries are dropped once their window empties, so a long-running relay does
/// not accumulate a bucket per address that ever probed it.
public final class PairingAttemptLimiter: @unchecked Sendable {
    private let limit: Int
    private let window: TimeInterval
    private let clock: Clock
    private var stamps: [String: [TimeInterval]] = [:]
    private let lock = NSLock()

    public init(limit: Int = 5, window: TimeInterval = 60, clock: Clock = SystemClock()) {
        self.limit = limit
        self.window = window
        self.clock = clock
    }

    /// Records an attempt from `key`, returning false once the window is full.
    public func allow(key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let now = clock.now
        for (bucket, times) in stamps {
            let live = times.filter { now - $0 <= window }
            if live.isEmpty { stamps.removeValue(forKey: bucket) } else { stamps[bucket] = live }
        }
        var attempts = stamps[key, default: []]
        guard attempts.count < limit else { return false }
        attempts.append(now)
        stamps[key] = attempts
        return true
    }

    /// Number of addresses currently holding a bucket. Exposed so a test can
    /// assert the map does not grow without bound.
    var trackedKeyCount: Int {
        lock.lock(); defer { lock.unlock() }
        return stamps.count
    }
}
