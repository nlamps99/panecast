import Foundation
import RelayCore
import CMUXClient
import SharedKit

/// `SurfaceReader` implementation that pulls screens from the live cmux
/// UDS. `DiffEngine` calls this on every tick of its polling loop, so the
/// underlying `CmuxConnection.connect()` is expected to return the
/// already-warm client after the first call.
///
/// It prefers cmux's render grid (colors and the real cursor) and falls back
/// to `surface.read_text` for a tick when the grid is unavailable; repeated
/// failures pause grid reads for a while so an older cmux is not asked twice
/// per frame.
public final class CmuxSurfaceReader: SurfaceReader, @unchecked Sendable {
    private let connection: CmuxConnection
    private let lock = NSLock()
    private var visibleRows: [String: Int] = [:]
    private var failures = 0
    private var gridPausedUntil: Date = .distantPast
    private let now: @Sendable () -> Date

    static let failuresBeforePause = 3
    static let pause: TimeInterval = 30

    public init(connection: CmuxConnection, now: @escaping @Sendable () -> Date = Date.init) {
        self.connection = connection
        self.now = now
    }

    public func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        let client = try await connection.connect()
        if useGrid() {
            do {
                let known = lock.withLock { visibleRows[surfaceId] }
                // Ask for just enough history to fill `lines`; the first read
                // does not know the screen height yet.
                let scrollback = known.map { max(0, lines - $0) } ?? lines
                let grid = try await client.surfaceRenderGrid(workspaceId: workspaceId, surfaceId: surfaceId, scrollback: scrollback)
                lock.withLock { visibleRows[surfaceId] = grid.rows; failures = 0 }
                return grid.toScreen(rev: 0, maxRows: lines)
            } catch {
                recordFailure()
            }
        }
        return try await client.surfaceReadText(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
    }

    private func useGrid() -> Bool {
        lock.withLock { now() >= gridPausedUntil }
    }

    private func recordFailure() {
        lock.withLock {
            failures += 1
            if failures >= Self.failuresBeforePause {
                failures = 0
                gridPausedUntil = now().addingTimeInterval(Self.pause)
            }
        }
    }
}
