import Foundation
import RelayCore
import CMUXClient
import SharedKit

/// Where `CmuxSurfaceReader` gets a terminal's text and render grid; a
/// protocol so tests can stand in for cmux.
public protocol CmuxScreenSource: Sendable {
    func readText(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen
    /// The visible rows only: the text read already carries the scrollback.
    func renderGrid(workspaceId: String, surfaceId: String) async throws -> CMUXRenderGrid
}

struct CmuxConnectionScreenSource: CmuxScreenSource {
    let connection: CmuxConnection

    func readText(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        try await connection.connect().surfaceReadText(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
    }

    func renderGrid(workspaceId: String, surfaceId: String) async throws -> CMUXRenderGrid {
        try await connection.connect().surfaceRenderGrid(workspaceId: workspaceId, surfaceId: surfaceId, scrollback: 0)
    }
}

/// `SurfaceReader` implementation that pulls screens from the live cmux
/// UDS. `DiffEngine` calls this on every tick of its polling loop, so the
/// underlying `CmuxConnection.connect()` is expected to return the
/// already-warm client after the first call.
///
/// Every tick reads plain text (cheap, with scrollback); cmux's render grid
/// (colors and the real cursor, ~10x the cost) is read only after the text
/// changed or the user typed, at most every `HybridScreen.minGridInterval`.
/// Repeated grid failures pause grid reads for a while, leaving plain text.
///
/// Viewers asking for different `lines` of one terminal (a phone and the
/// desktop) each get their own `HybridScreen`: sharing one made every read
/// replace the other viewer's text, so each saw the row count flip (a full
/// redraw) and an idle screen read a grid every interval. A grid read for
/// one of them colors them all. A screen is dropped when its last subscriber
/// leaves; past `maxTracked`, single screens go (unwatched first, then least
/// recently used), never all of them.
public final class CmuxSurfaceReader: SurfaceReader, @unchecked Sendable {
    private struct Key: Hashable {
        let surfaceId: String
        let lines: Int
    }

    private let source: CmuxScreenSource
    private let lock = NSLock()
    private var screens: [Key: HybridScreen] = [:]
    /// Subscribers reading each key; its screen goes when the last one leaves.
    private var viewers: [Key: Int] = [:]
    private var lastUsed: [Key: UInt64] = [:]
    private var uses: UInt64 = 0
    private var failures = 0
    private var gridPausedUntil: Date
    private let maxTracked: Int
    private let now: @Sendable () -> Date

    static let failuresBeforePause = 3
    static let pause: TimeInterval = 30

    /// Seconds since boot as a `Date`: the reader only compares these, and a
    /// wall clock stepping backward would pause grid reads until it caught up.
    public static let monotonicNow: @Sendable () -> Date = {
        Date(timeIntervalSinceReferenceDate: ProcessInfo.processInfo.systemUptime)
    }

    public convenience init(connection: CmuxConnection, now: @escaping @Sendable () -> Date = CmuxSurfaceReader.monotonicNow) {
        self.init(source: CmuxConnectionScreenSource(connection: connection), now: now)
    }

    public init(source: CmuxScreenSource,
                maxTracked: Int = 64,
                now: @escaping @Sendable () -> Date = CmuxSurfaceReader.monotonicNow) {
        self.source = source
        self.maxTracked = max(1, maxTracked)
        self.now = now
        self.gridPausedUntil = .distantPast
    }

    public func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        let key = Key(surfaceId: surfaceId, lines: lines)
        let text = try await source.readText(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
        let wantsGrid: Bool = lock.withLock {
            track(key)
            let time = now()
            return screens[key, default: HybridScreen()].acceptText(text.rows, at: time.timeIntervalSinceReferenceDate)
                && time >= gridPausedUntil
        }
        if wantsGrid {
            do {
                let grid = try await source.renderGrid(workspaceId: workspaceId, surfaceId: surfaceId)
                let visible = grid.toScreen(rev: 0, maxRows: grid.rows)
                let cursor = visible.cursor.y < visible.rows.count ? visible.cursor : nil
                lock.withLock {
                    let time = now().timeIntervalSinceReferenceDate
                    for other in keys(of: surfaceId) {
                        screens[other]?.acceptGrid(rows: visible.rows, cursor: cursor, at: time)
                    }
                    failures = 0
                }
            } catch {
                recordFailure(surfaceId)
            }
        }
        return lock.withLock {
            if let screen = screens[key] { return screen.screen(maxRows: lines, cols: text.cols) }
            // Dropped while this read was in flight (its viewer left): this
            // read's text, never an empty screen. Not re-tracked.
            var untracked = HybridScreen()
            _ = untracked.acceptText(text.rows, at: 0)
            return untracked.screen(maxRows: lines, cols: text.cols)
        }
    }

    public func noteInput(surfaceId: String) {
        lock.withLock {
            let time = now().timeIntervalSinceReferenceDate
            for key in keys(of: surfaceId) { screens[key]?.noteInput(at: time) }
        }
    }

    public func viewerStarted(surfaceId: String, lines: Int) {
        lock.withLock { viewers[Key(surfaceId: surfaceId, lines: lines), default: 0] += 1 }
    }

    public func viewerStopped(surfaceId: String, lines: Int) {
        let key = Key(surfaceId: surfaceId, lines: lines)
        lock.withLock {
            let remaining = (viewers[key] ?? 0) - 1
            if remaining > 0 {
                viewers[key] = remaining
            } else {
                viewers[key] = nil
                drop(key)
            }
        }
    }

    /// Screens currently kept, for tests.
    var trackedScreens: Int { lock.withLock { screens.count } }

    func isTracking(surfaceId: String, lines: Int) -> Bool {
        lock.withLock { screens[Key(surfaceId: surfaceId, lines: lines)] != nil }
    }

    // MARK: Call with `lock` held.

    /// Marks `key` used and gives it a screen, making room past the cap by
    /// dropping single screens (unwatched first, then least recently used),
    /// never every viewer's colors at once.
    private func track(_ key: Key) {
        uses += 1
        lastUsed[key] = uses
        guard screens[key] == nil else { return }
        while screens.count >= maxTracked, let victim = evictionCandidate(sparing: key) { drop(victim) }
        screens[key] = HybridScreen()
    }

    private func evictionCandidate(sparing key: Key) -> Key? {
        let others = screens.keys.filter { $0 != key }
        let unwatched = others.filter { (viewers[$0] ?? 0) == 0 }
        return (unwatched.isEmpty ? others : unwatched).min { (lastUsed[$0] ?? 0) < (lastUsed[$1] ?? 0) }
    }

    private func drop(_ key: Key) {
        screens[key] = nil
        lastUsed[key] = nil
    }

    private func keys(of surfaceId: String) -> [Key] {
        screens.keys.filter { $0.surfaceId == surfaceId }
    }

    private func recordFailure(_ surfaceId: String) {
        lock.withLock {
            let time = now().timeIntervalSinceReferenceDate
            for key in keys(of: surfaceId) { screens[key]?.gridFailed(at: time) }
            failures += 1
            if failures >= Self.failuresBeforePause {
                failures = 0
                gridPausedUntil = now().addingTimeInterval(Self.pause)
            }
        }
    }
}
