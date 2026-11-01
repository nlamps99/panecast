/// Pure derivation of per-workspace unread notification counts. Lives in
/// SharedKit so it is unit-testable via `swift test` (no iOS simulator).
public enum WorkspaceNotificationTally {
    /// Unread = records whose id is not in `readIds`, grouped by workspaceId.
    /// Workspaces with zero unread are omitted from the result.
    public static func unreadCounts(records: [NotificationRecord],
                                    readIds: Set<String>) -> [String: Int] {
        var counts: [String: Int] = [:]
        for r in records where !readIds.contains(r.id) {
            counts[r.workspaceId, default: 0] += 1
        }
        return counts
    }

    /// The notification ids belonging to a workspace (used to mark them read).
    public static func ids(in records: [NotificationRecord],
                           forWorkspace workspaceId: String) -> Set<String> {
        Set(records.lazy.filter { $0.workspaceId == workspaceId }.map(\.id))
    }
}
