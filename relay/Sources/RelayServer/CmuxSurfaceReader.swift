import Foundation
import RelayCore
import CMUXClient
import SharedKit

/// `SurfaceReader` implementation that pulls screens from the live cmux
/// UDS. `DiffEngine` calls this on every tick of its polling loop, so the
/// underlying `CmuxConnection.connect()` is expected to return the
/// already-warm client after the first call.
///
/// Every tick reads plain text (cheap, with scrollback); cmux's render grid
/// (colors and the real cursor, ~10x the cost) is read only after the text
/// changed or the user typed, at most every `HybridScreen.minGridInterval`.
/// Repeated grid failures pause grid reads for a while, leaving plain text.
public final class CmuxSurfaceReader: SurfaceReader, @unchecked Sendable {
    private let connection: CmuxConnection
    private let lock = NSLock()
    private var screens: [String: HybridScreen] = [:]
    private var failures = 0
    private var gridPausedUntil: Date = .distantPast
    private let now: @Sendable () -> Date

    static let failuresBeforePause = 3
    static let pause: TimeInterval = 30
    static let maxTracked = 64

    public init(connection: CmuxConnection, now: @escaping @Sendable () -> Date = { Date() }) {
        self.connection = connection
        self.now = now
    }

    public func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        let client = try await connection.connect()
        let text = try await client.surfaceReadText(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
        let wantsGrid: Bool = lock.withLock {
            if screens[surfaceId] == nil, screens.count >= Self.maxTracked { screens.removeAll() }
            let time = now()
            return screens[surfaceId, default: HybridScreen()].acceptText(text.rows, at: time.timeIntervalSinceReferenceDate)
                && time >= gridPausedUntil
        }
        if wantsGrid {
            do {
                // Only the visible rows: the text read already carries the scrollback.
                let grid = try await client.surfaceRenderGrid(workspaceId: workspaceId, surfaceId: surfaceId, scrollback: 0)
                let visible = grid.toScreen(rev: 0, maxRows: grid.rows)
                let cursor = visible.cursor.y < visible.rows.count ? visible.cursor : nil
                lock.withLock {
                    screens[surfaceId, default: HybridScreen()].acceptGrid(rows: visible.rows, cursor: cursor, at: now().timeIntervalSinceReferenceDate)
                    failures = 0
                }
            } catch {
                recordFailure(surfaceId)
            }
        }
        return lock.withLock { (screens[surfaceId] ?? HybridScreen()).screen(maxRows: lines, cols: text.cols) }
    }

    public func noteInput(surfaceId: String) {
        lock.withLock { screens[surfaceId]?.noteInput(at: now().timeIntervalSinceReferenceDate) }
    }

    private func recordFailure(_ surfaceId: String) {
        lock.withLock {
            screens[surfaceId]?.gridFailed(at: now().timeIntervalSinceReferenceDate)
            failures += 1
            if failures >= Self.failuresBeforePause {
                failures = 0
                gridPausedUntil = now().addingTimeInterval(Self.pause)
            }
        }
    }
}
