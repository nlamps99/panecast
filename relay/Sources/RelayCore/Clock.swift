import Foundation

public protocol Clock: Sendable {
    var now: TimeInterval { get }
}

/// Wall-clock seconds since 1970. It can step backward or forward (NTP, a
/// manual change, waking from sleep), so it suits timestamps, not intervals.
public final class SystemClock: Clock {
    public init() {}
    public var now: TimeInterval { Date().timeIntervalSince1970 }
}

/// Seconds since boot, never stepping backward: for scheduling. Only
/// differences between readings mean anything.
public final class MonotonicClock: Clock {
    public init() {}
    public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

public final class FakeClock: Clock, @unchecked Sendable {
    private var t: TimeInterval = 0
    public init() {}
    public var now: TimeInterval { t }
    public func advance(by dt: TimeInterval) { t += dt }
}
