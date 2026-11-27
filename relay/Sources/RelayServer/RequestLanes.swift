import Foundation

/// Runs async operations one at a time, in the order `enqueue` was called.
///
/// `enqueue` is synchronous and lock-protected, so callers on one thread (a
/// channel's event loop, or another queue's operation) fix the order before
/// any task starts. Spawning `Task { await actor.run(...) }` per frame does
/// not: two such tasks can reach the actor in either order.
final class SerialTaskQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never>?

    func enqueue(_ operation: @escaping @Sendable () async -> Void) {
        lock.lock()
        defer { lock.unlock() }
        let previous = tail
        tail = Task {
            await previous?.value
            await operation()
        }
    }
}

/// Which ordered queue a request waits in on its connection.
///
/// Every connection used to answer requests strictly one after another, so a
/// keystroke waited behind a scrollback page or a project diff. Now writes
/// keep their exact order among themselves but never wait for reads; reads
/// wait only for other reads. Clients match responses by `id`, so answers may
/// arrive in a different order than the requests.
public enum WSRequestLane: Sendable, Hashable {
    /// Keystrokes and every other change, plus `surface.subscribe`/
    /// `unsubscribe` (cheap, and a terminal switch should not wait behind
    /// reads). Unknown methods land here too, keeping their old ordering
    /// against writes.
    case input
    /// Side-effect-free requests answered quickly.
    case read
    /// Large or slow work: scrollback pages, project files, uploads.
    case bulk

    static let readMethods: Set<String> = [
        "relay.info", "relay.snippets", "relay.diagnostics", "host.battery", "inbox.sync",
        "system.capabilities", "system.identify", "system.ping", "system.tree",
        "window.list", "window.current", "workspace.list", "workspace.current",
        "surface.list", "surface.current", "surface.read_text", "surface.read_selection",
        "surface.input_state", "surface.health", "surface.resume.get",
        "terminal.replay", "terminal.size_state", "terminal.conversation", "terminal.conversation.batch",
        "pane.list", "pane.surfaces", "notification.list", "notification.feed.list",
        "debug.terminals", "browser.url.get",
    ]

    static let bulkMethods: Set<String> = ["surface.history", "file.upload"]

    public static func of(method: String) -> WSRequestLane {
        if bulkMethods.contains(method) || method.hasPrefix("project.") { return .bulk }
        if readMethods.contains(method) { return .read }
        return .input
    }
}

/// One serial queue per lane.
final class RequestLanes: @unchecked Sendable {
    private let input = SerialTaskQueue()
    private let read = SerialTaskQueue()
    private let bulk = SerialTaskQueue()

    func enqueue(_ lane: WSRequestLane, _ operation: @escaping @Sendable () async -> Void) {
        switch lane {
        case .input: input.enqueue(operation)
        case .read: read.enqueue(operation)
        case .bulk: bulk.enqueue(operation)
        }
    }
}
