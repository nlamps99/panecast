import Foundation

/// Capped exponential backoff for the cmux event-stream supervisor.
/// `nextDelay()` returns seconds and advances the attempt counter;
/// `reset()` is called after a successful (long-lived) attach so the
/// next reconnect starts fast again.
public struct ReconnectPolicy {
    private let base: Double
    private let cap: Double
    private var attempt: Int = 0

    public init(base: Double = 0.5, cap: Double = 8.0) {
        self.base = base
        self.cap = cap
    }

    public mutating func nextDelay() -> Double {
        let raw = base * pow(2.0, Double(attempt))
        attempt += 1
        return min(cap, raw)
    }

    public mutating func reset() {
        attempt = 0
    }
}
