import Foundation

/// A sleep that `wake()` cuts short: the surface poll loop waits on it
/// between reads, and input wakes it so the echo is read at once instead of
/// after the rest of an idle interval.
public final class PollWaker: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = false
    private var sleeper: Task<Void, Never>?

    public init() {}

    /// Ends the current sleep, or the next one if none is running.
    public func wake() {
        lock.withLock {
            if let sleeper {
                sleeper.cancel()
                self.sleeper = nil
            } else {
                pending = true
            }
        }
    }

    /// Sleeps for `seconds`. True when `wake()` ended it (or had been called
    /// since the last sleep); false when the time ran out or the calling task
    /// was cancelled.
    @discardableResult
    public func sleep(seconds: TimeInterval) async -> Bool {
        let nanoseconds = UInt64(max(0, seconds) * 1_000_000_000)
        let task: Task<Void, Never>? = lock.withLock {
            if pending {
                pending = false
                return nil
            }
            let task = Task<Void, Never> { _ = try? await Task.sleep(nanoseconds: nanoseconds) }
            sleeper = task
            return task
        }
        guard let task else { return true }

        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }

        return lock.withLock {
            // `wake()` clears `sleeper` when it cancels it.
            guard sleeper == task else { return true }
            sleeper = nil
            return false
        }
    }
}
