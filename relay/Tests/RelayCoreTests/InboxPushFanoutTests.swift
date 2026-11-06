import XCTest
@testable import RelayCore
@testable import SharedKit

final class InboxPushFanoutTests: XCTestCase {
    func testOnlyProblemsAndCompletionArePushedAndRepeatedCallbacksAreSuppressed() async throws {
        let store = try emptyStore()
        _ = try store.register(deviceId: "d1", loginName: "a", hostname: "iPhone", apnsToken: nil)
        try store.setAPNsToken(deviceId: "d1", token: "token-1", env: "sandbox", preferences: .init(dedupeSeconds: 0))
        let sender = RecordingAPNsSender()
        let fanout = InboxPushFanout(deviceStore: store, sender: sender, config: { testAPNsConfig })
        for name in ["notification.created", "notification.cleared", "notification.resolved"] {
            await fanout.deliver(event: .init(category: .notification, name: name, payload: .object(["title": .string("Working"), "id": .string("noise")])))
        }
        let failure = EventFrame(category: .agent, name: "task.failed", payload: .object(["task_id": .string("task"), "title": .string("Build")]))
        let completion = EventFrame(category: .agent, name: "task.completed", payload: .object(["task_id": .string("task"), "title": .string("Build")]))
        await fanout.deliver(event: failure)
        await fanout.deliver(event: completion)
        await fanout.deliver(event: completion)
        let pushes = await sender.recordedPushes()
        XCTAssertEqual(pushes.map(\.needsInput), [true, false])
        XCTAssertEqual(pushes.map(\.notification.id), ["task-event:::task:attention", "task-event:::task:completed"])
    }

    func testSendsInboxEventToRegisteredDeviceToken() async throws {
        let store = try emptyStore()
        _ = try store.register(deviceId: "d1", loginName: "a", hostname: "iPhone", apnsToken: nil)
        try store.setAPNsToken(deviceId: "d1", token: "token-1", env: "sandbox")
        let sender = RecordingAPNsSender()
        let fanout = InboxPushFanout(
            deviceStore: store,
            sender: sender,
            config: { testAPNsConfig }
        )

        await fanout.deliver(event: EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object([
                "id": .string("n1"),
                "workspace_id": .string("w1"),
                "surface_id": .string("s1"),
                "title": .string("Codex needs input"),
                "body": .string("terminal SECRET_TOKEN must not be sent by provider"),
            ])
        ))

        let pushes = await sender.recordedPushes()
        XCTAssertEqual(pushes.count, 1)
        XCTAssertEqual(pushes.first?.deviceToken, "token-1")
        XCTAssertEqual(pushes.first?.environment, "sandbox")
        XCTAssertEqual(pushes.first?.notification.workspaceId, "w1")
        XCTAssertEqual(pushes.first?.notification.surfaceId, "s1")
    }

    func testSkipsNonInboxEventsAndEnvMismatches() async throws {
        let store = try emptyStore()
        _ = try store.register(deviceId: "d1", loginName: "a", hostname: "iPhone", apnsToken: nil)
        try store.setAPNsToken(deviceId: "d1", token: "token-1", env: "prod")
        let sender = RecordingAPNsSender()
        let fanout = InboxPushFanout(
            deviceStore: store,
            sender: sender,
            config: { testAPNsConfig }
        )

        await fanout.deliver(event: EventFrame(
            category: .workspace,
            name: "workspace.updated",
            payload: .object(["workspace_id": .string("w1")])
        ))
        await fanout.deliver(event: EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object(["workspace_id": .string("w1"), "title": .string("Done")])
        ))

        let pushes = await sender.recordedPushes()
        XCTAssertTrue(pushes.isEmpty)
    }

    func testInvalidTokenResponseClearsStoredToken() async throws {
        let store = try emptyStore()
        _ = try store.register(deviceId: "d1", loginName: "a", hostname: "iPhone", apnsToken: nil)
        try store.setAPNsToken(deviceId: "d1", token: "token-1", env: "sandbox")
        let sender = RecordingAPNsSender(result: .invalidToken(reason: "Unregistered", apnsId: "apns-1"))
        let fanout = InboxPushFanout(
            deviceStore: store,
            sender: sender,
            config: { testAPNsConfig }
        )

        await fanout.deliver(event: EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object(["workspace_id": .string("w1"), "title": .string("Done")])
        ))

        XCTAssertNil(store.lookup(deviceId: "d1")?.apnsToken)
        XCTAssertNil(store.lookup(deviceId: "d1")?.apnsEnv)
    }

    private func emptyStore() throws -> DeviceStore {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("InboxPushFanoutTests-\(UUID()).json")
        return try DeviceStore(url: path)
    }
}

private let testAPNsConfig = RelayConfig.APNs(
    keyPath: "/dev/null",
    keyId: "K",
    teamId: "T",
    topic: "com.genie.CmuxRemote",
    env: "sandbox"
)

private actor RecordingAPNsSender: APNsSending {
    private(set) var pushes: [APNsPushAlert] = []
    let result: APNsSendResult

    init(result: APNsSendResult = .delivered(apnsId: "ok")) {
        self.result = result
    }

    func send(_ push: APNsPushAlert) async throws -> APNsSendResult {
        pushes.append(push)
        return result
    }

    func recordedPushes() -> [APNsPushAlert] {
        pushes
    }
}
