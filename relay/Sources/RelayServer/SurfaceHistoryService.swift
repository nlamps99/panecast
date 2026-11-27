import Foundation
import SharedKit

/// A facade that reads a terminal's text without building and re-encoding a
/// `JSONValue` tree, which for a 100k-line scrollback is most of the cost.
public protocol CMUXTextReading: Sendable {
    func readText(workspaceId: String, surfaceId: String, lines: Int) async throws -> String
}

/// Provides stable, cursor-addressable snapshots of a terminal's scrollback.
///
/// cmux currently exposes only a trailing `lines` argument.  The relay turns
/// that into a real pagination contract by materialising one bounded snapshot
/// on the Mac, then serving immutable pages from it.  A cursor is deliberately
/// opaque to the phone and expires when the relay restarts or its snapshot is
/// evicted.
///
/// The snapshot is read when the first page is asked for. Subscribing no
/// longer starts one: every terminal switch and reconnect paid for a
/// scrollback read (up to 100k lines) that was kept only 2 s, while clients
/// that browse ask for their first page right after the screen arrives
/// anyway. Callers that overlap share one read.
public actor SurfaceHistoryService {
    public static let maximumSnapshotLines = 100_000
    public static let maximumSnapshots = 8
    public static let maximumPageLines = 500
    /// A prewarm is useful only for a reader who begins browsing shortly
    /// after opening a surface. Reusing an old snapshot creates a hole between
    /// the paged history and the terminal's current bottom rows.
    public static let prewarmFreshness: TimeInterval = 2

    private struct SurfaceKey: Hashable {
        let workspaceId: String
        let surfaceId: String
    }

    private struct Snapshot {
        let workspaceId: String
        let surfaceId: String
        let rows: [String]
        let createdAt: Date
    }

    private let cmux: any CMUXFacade
    private var reading: [SurfaceKey: Task<(UUID, Snapshot), Error>] = [:]
    private var snapshots: [UUID: Snapshot] = [:]
    private var snapshotOrder: [UUID] = []
    private var newestSnapshotBySurface: [SurfaceKey: UUID] = [:]

    public init(cmux: any CMUXFacade) {
        self.cmux = cmux
    }

    /// Starts the expensive cmux scrollback read before a user reaches the
    /// top of the terminal. It is intentionally fire-and-forget from the WS
    /// subscription path: history pagination subsequently reads only this
    /// in-memory snapshot and never blocks a swipe on a large UDS response.
    public func prewarm(workspaceId: String, surfaceId: String) async {
        let key = SurfaceKey(workspaceId: workspaceId, surfaceId: surfaceId)
        if let id = newestSnapshotBySurface[key],
           let snapshot = snapshots[id],
           isFresh(snapshot)
        {
            return
        }
        _ = try? await createSnapshot(workspaceId: workspaceId, surfaceId: surfaceId)
    }

    /// Returns rows immediately before `cursor`.  With no cursor it also
    /// returns an `anchor_rows` tail: the iOS client keeps that tail frozen
    /// while it browses so new terminal output cannot shift or duplicate the
    /// paged history it is reading.
    public func page(
        workspaceId: String,
        surfaceId: String,
        cursor: String?,
        tailLines: Int,
        limit: Int
    ) async throws -> JSONValue {
        let pageLimit = min(max(limit, 1), Self.maximumPageLines)

        if let cursor {
            let (snapshotId, before) = try parse(cursor: cursor)
            guard let snapshot = snapshots[snapshotId],
                  snapshot.workspaceId == workspaceId,
                  snapshot.surfaceId == surfaceId
            else {
                throw SurfaceHistoryError.cursorExpired
            }
            return page(
                snapshot: snapshot,
                snapshotId: snapshotId,
                before: before,
                limit: pageLimit,
                includeAnchor: false
            )
        }

        let key = SurfaceKey(workspaceId: workspaceId, surfaceId: surfaceId)
        let snapshotId: UUID
        let snapshot: Snapshot
        if let existingId = newestSnapshotBySurface[key],
           let existing = snapshots[existingId],
           isFresh(existing)
        {
            snapshotId = existingId
            snapshot = existing
        } else {
            (snapshotId, snapshot) = try await createSnapshot(
                workspaceId: workspaceId,
                surfaceId: surfaceId
            )
        }

        let anchorCount = min(max(tailLines, 1), snapshot.rows.count)
        let before = max(0, snapshot.rows.count - anchorCount)
        return page(
            snapshot: snapshot,
            snapshotId: snapshotId,
            before: before,
            limit: pageLimit,
            includeAnchor: true
        )
    }

    /// Reads a new snapshot, or joins the read already under way for this
    /// terminal (a prewarm, or a page asked for while one was loading).
    private func createSnapshot(
        workspaceId: String,
        surfaceId: String
    ) async throws -> (UUID, Snapshot) {
        let key = SurfaceKey(workspaceId: workspaceId, surfaceId: surfaceId)
        if let running = reading[key] { return try await running.value }
        let cmux = self.cmux
        // Inherits this actor: the body starts only after `reading` is set.
        let task = Task { () throws -> (UUID, Snapshot) in
            defer { self.reading[key] = nil }
            let text = try await Self.readText(cmux: cmux, workspaceId: workspaceId, surfaceId: surfaceId)
            return self.store(text: text, key: key)
        }
        reading[key] = task
        return try await task.value
    }

    private static func readText(cmux: any CMUXFacade, workspaceId: String, surfaceId: String) async throws -> String {
        if let reader = cmux as? CMUXTextReading {
            return try await reader.readText(workspaceId: workspaceId, surfaceId: surfaceId, lines: maximumSnapshotLines)
        }
        let result = try await cmux.dispatch(
            method: "surface.read_text",
            params: .object([
                "workspace_id": .string(workspaceId),
                "surface_id": .string(surfaceId),
                "lines": .int(Int64(maximumSnapshotLines)),
            ])
        )
        guard case .object(let values) = result,
              case .string(let text)? = values["text"]
        else {
            throw SurfaceHistoryError.invalidResponse
        }
        return text
    }

    private func store(text: String, key: SurfaceKey) -> (UUID, Snapshot) {
        let rows = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let snapshot = Snapshot(workspaceId: key.workspaceId, surfaceId: key.surfaceId, rows: rows, createdAt: Date())
        let snapshotId = UUID()
        snapshots[snapshotId] = snapshot
        snapshotOrder.append(snapshotId)
        newestSnapshotBySurface[key] = snapshotId
        evictSnapshotsIfNeeded()
        return (snapshotId, snapshot)
    }

    private func page(
        snapshot: Snapshot,
        snapshotId: UUID,
        before: Int,
        limit: Int,
        includeAnchor: Bool
    ) -> JSONValue {
        let end = min(max(before, 0), snapshot.rows.count)
        let start = max(0, end - limit)
        let nextCursor = start > 0 ? makeCursor(snapshotId: snapshotId, before: start) : nil

        var result: [String: JSONValue] = [
            "rows": .array(snapshot.rows[start..<end].map(JSONValue.string)),
            "next_cursor": nextCursor.map(JSONValue.string) ?? .null,
        ]
        if includeAnchor {
            result["anchor_rows"] = .array(snapshot.rows[end...].map(JSONValue.string))
        }
        return .object(result)
    }

    private func makeCursor(snapshotId: UUID, before: Int) -> String {
        "\(snapshotId.uuidString).\(before)"
    }

    private func parse(cursor: String) throws -> (UUID, Int) {
        let components = cursor.split(separator: ".", maxSplits: 1).map(String.init)
        guard components.count == 2,
              let id = UUID(uuidString: components[0]),
              let before = Int(components[1]),
              before >= 0
        else {
            throw SurfaceHistoryError.cursorExpired
        }
        return (id, before)
    }

    private func evictSnapshotsIfNeeded() {
        while snapshotOrder.count > Self.maximumSnapshots {
            let oldest = snapshotOrder.removeFirst()
            if let snapshot = snapshots.removeValue(forKey: oldest) {
                let key = SurfaceKey(
                    workspaceId: snapshot.workspaceId,
                    surfaceId: snapshot.surfaceId
                )
                if newestSnapshotBySurface[key] == oldest {
                    newestSnapshotBySurface[key] = nil
                }
            }
        }
    }

    private func isFresh(_ snapshot: Snapshot) -> Bool {
        Date().timeIntervalSince(snapshot.createdAt) <= Self.prewarmFreshness
    }
}

public enum SurfaceHistoryError: LocalizedError {
    case cursorExpired
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .cursorExpired: return "terminal history cursor expired"
        case .invalidResponse: return "cmux returned an invalid terminal history response"
        }
    }
}
