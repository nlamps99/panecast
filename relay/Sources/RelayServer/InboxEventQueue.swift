import Foundation

/// A synchronous enqueue point preserves upstream event order even though
/// persistence and push work run asynchronously.
final class InboxEventQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    func enqueue(_ work: @escaping @Sendable () async -> Void) {
        lock.lock(); defer { lock.unlock() }
        let previous = tail
        tail = Task { await previous?.value; await work() }
    }
}
