import XCTest
import Foundation
import SharedKit
import RelayCore
@testable import RelayServer

final class InboxJournalTests: XCTestCase {
    func event(_ id: String) -> EventFrame { .init(category: .notification, name: "notification.created", payload: .object(["id": .string(id), "title": .string("Task completed"), "workspace_id": .string("w")])) }
    func object(_ value: JSONValue) throws -> [String: JSONValue] { guard case .object(let object) = value else { throw NSError(domain: "test", code: 1) }; return object }
    func testDurableCursorAndRetentionGap() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("journal-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let journal = InboxJournal(url: url, limit: 2)
        _ = try await journal.append(event("one")); let first = try object(await journal.page(params: .object([:])))
        _ = try await journal.append(event("two")); _ = try await journal.append(event("three")); _ = try await journal.append(event("four"))
        let restored = InboxJournal(url: url, limit: 2)
        let page = try object(await restored.page(params: .object(["cursor": first["next_cursor"]!])))
        XCTAssertEqual(page["reset"], .bool(true)); XCTAssertEqual(page["has_more"], .bool(false))
        guard case .array(let events)? = page["events"] else { return XCTFail("events missing") }
        XCTAssertEqual(events.count, 2)
        let ignored = try await restored.append(.init(category: .agent, name: "message", payload: .object(["text": .string("the task completed")])))
        XCTAssertNil(ignored)
    }
    func testCompletionRequiresStructuredIdentity() {
        XCTAssertFalse(InboxJournal.isResolution(.init(category: .agent, name: "turn/completed", payload: .object(["thread_id": .string("thread")]))))
        XCTAssertTrue(InboxJournal.isResolution(.init(category: .agent, name: "task.completed", payload: .object(["task_id": .string("task")]))))
    }
    func testRetainsTurnOutcomeAndIdentityWithoutReplayingToolProgress() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("journal-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let journal = InboxJournal(url: url)
        for outcome in ["completed", "failed"] {
            let event = EventFrame(category: .agent, name: "turn/completed", payload: .object([
                "source_id": .string("s"), "threadId": .string("th"), "turn": .object(["id": .string("t"), "status": .string(outcome)])]))
            let saved = try await journal.append(event)
            let retained = try XCTUnwrap(saved)
            XCTAssertEqual(NotificationSignal.from(retained), outcome == "completed" ? .completed : .attention)
            XCTAssertEqual(try object(retained.payload)["turn_id"], .string("t"))
            XCTAssertTrue(InboxJournal.isResolution(retained))
        }
        let progress = try await journal.append(.init(category: .agent, name: "item/completed", payload: .object(["status": .string("completed"), "turn_id": .string("t")])))
        XCTAssertNil(progress)
    }
    func testQuietHoursUsesIANAZoneWithOvernightBounds() throws {
        let preferences = NotificationPreferences(needsInputOnly: true, mutedWorkspaces: ["muted"], quietHours: .init(enabled: true, startMinutes: 1320, endMinutes: 480, timeZone: "America/Los_Angeles"))
        let formatter = ISO8601DateFormatter()
        XCTAssertFalse(preferences.allows(workspaceId: "w", needsInput: true, at: formatter.date(from: "2026-11-04T07:00:00Z")!))
        XCTAssertTrue(preferences.allows(workspaceId: "w", needsInput: true, at: formatter.date(from: "2026-11-04T16:00:00Z")!))
        XCTAssertFalse(preferences.allows(workspaceId: "muted", needsInput: true, at: formatter.date(from: "2026-11-04T16:00:00Z")!))
        XCTAssertFalse(preferences.allows(workspaceId: "w", needsInput: false, at: formatter.date(from: "2026-11-04T16:00:00Z")!))
    }
}
