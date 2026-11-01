import XCTest
@testable import SharedKit

final class WorkspaceNotificationTallyTests: XCTestCase {
    private func rec(_ id: String, _ ws: String) -> NotificationRecord {
        NotificationRecord(id: id, workspaceId: ws, surfaceId: nil, title: "t",
                           subtitle: nil, body: "b", ts: 0, threadId: "th")
    }

    func testGroupsUnreadByWorkspace() {
        let records = [rec("1", "A"), rec("2", "A"), rec("3", "B")]
        let counts = WorkspaceNotificationTally.unreadCounts(records: records, readIds: [])
        XCTAssertEqual(counts, ["A": 2, "B": 1])
    }

    func testExcludesReadIds() {
        let records = [rec("1", "A"), rec("2", "A"), rec("3", "B")]
        let counts = WorkspaceNotificationTally.unreadCounts(records: records, readIds: ["1"])
        XCTAssertEqual(counts, ["A": 1, "B": 1])
    }

    func testFullyReadWorkspaceHasNoEntry() {
        let records = [rec("1", "A"), rec("2", "A")]
        let counts = WorkspaceNotificationTally.unreadCounts(records: records, readIds: ["1", "2"])
        XCTAssertNil(counts["A"])
    }

    func testIdsForWorkspace() {
        let records = [rec("1", "A"), rec("2", "A"), rec("3", "B")]
        XCTAssertEqual(WorkspaceNotificationTally.ids(in: records, forWorkspace: "A"), ["1", "2"])
        XCTAssertEqual(WorkspaceNotificationTally.ids(in: records, forWorkspace: "B"), ["3"])
    }
}
