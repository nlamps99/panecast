import Foundation
import XCTest
@testable import SharedKit

final class NotificationSignalTests: XCTestCase {
    func testSharedSignalCases() throws {
        struct Case: Decodable { let label: String; let event: EventFrame; let expected: String? }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("docs/specs/fixtures/notification-signals.json"))
        for entry in try JSONDecoder().decode([Case].self, from: data) {
            XCTAssertEqual(NotificationSignal.from(entry.event)?.rawValue, entry.expected, entry.label)
            XCTAssertEqual(InboxNotification.record(from: entry.event) != nil, entry.expected != nil, entry.label)
        }
    }
}
