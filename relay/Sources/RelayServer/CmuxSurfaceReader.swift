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
/// one of them colors them all.
public final class CmuxSurfaceReader: SurfaceReader, @unchecked Sendable {
    private struct Key: Hashable {
        let surfaceId: String
        let lines: Int
    }

    private let source: CmuxScreenSource
    private let lock = NSLock()
    private var screens: [Key: HybridScreen] = [:]
    private var failures = 0
    private var gridPausedUntil: Date = .distantPast
    private let now: @Sendable () -> Date

    static let failuresBeforePause = 3
    static let pause: TimeInterval = 30
    static let maxTracked = 64

    public convenience init(connection: CmuxConnection, now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(source: CmuxConnectionScreenSource(connection: connection), now: now)
    }

    public init(source: CmuxScreenSource, now: @escaping @Sendable () -> Date = { Date() }) {
        self.source = source
        self.now = now
    }

    public func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        let key = Key(surfaceId: surfaceId, lines: lines)
        let text = try await source.readText(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
        let wantsGrid: Bool = lock.withLock {
            if screens[key] == nil, screens.count >= Self.maxTracked { screens.removeAll() }
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
        return lock.withLock { (screens[key] ?? HybridScreen()).screen(maxRows: lines, cols: text.cols) }
    }

    public func noteInput(surfaceId: String) {
        lock.withLock {
            let time = now().timeIntervalSinceReferenceDate
            for key in keys(of: surfaceId) { screens[key]?.noteInput(at: time) }
        }
    }

    /// Call with `lock` held.
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
