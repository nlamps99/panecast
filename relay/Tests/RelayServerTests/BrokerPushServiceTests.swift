import XCTest
import Foundation
import RelayCore
import SharedKit
@testable import RelayServer

final class BrokerPushServiceTests: XCTestCase {
    func testRegistersWithoutLANAndStopsAfterRevocationOrLeaseExpiry() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sender = PushRecorder(), clock = PushClock()
        let service = BrokerPushService(url: directory.appendingPathComponent("push.json"), relayId: "computer", sender: sender,
            config: { .init(keyPath: "key", keyId: "key", teamId: "team", topic: "app", env: "prod") }, now: { clock.now() })
        let request = BrokerEnvelope(type: .pushRegister, sessionId: "r", deviceId: "phone", text: #"{"apns_token":"aabb","env":"prod"}"#)
        let denied = await service.receive(request)
        XCTAssertTrue(denied?.text?.contains("device_not_authorized") == true)
        _ = await service.receive(.init(type: .pushSync, sessionId: "s", text: #"["phone"]"#))
        let result = await service.receive(request)
        let data = try XCTUnwrap(result?.text?.data(using: .utf8))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["forwarded"] as? Bool, true)
        XCTAssertEqual(body["push_enabled"] as? Bool, true)
        let event = EventFrame(category: .notification, name: "notification.created", payload: .object(["id": .string("n"), "workspace_id": .string("w"), "title": .string("needs input")]))
        let accepted = await service.deliver(event: event)
        XCTAssertEqual(accepted, ["aabb"])
        clock.advance(46)
        let expired = await service.deliver(event: event)
        XCTAssertTrue(expired.isEmpty)
        _ = await service.receive(.init(type: .pushSync, sessionId: "s", text: "[]"))
        let revoked = await service.receive(request)
        XCTAssertTrue(revoked?.text?.contains("device_not_authorized") == true)
        let pushes = await sender.pushes
        XCTAssertEqual(pushes.count, 1)
        XCTAssertEqual(pushes[0].relayId, "computer")
    }
    func testReportsMissingAPNsConfigurationInsteadOfReady() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let service = BrokerPushService(url: file, relayId: "computer", sender: PushRecorder(), config: { RelayConfig.defaults.apns })
        _ = await service.receive(.init(type: .pushSync, sessionId: "s", text: #"["phone"]"#))
        let response = await service.receive(.init(type: .pushRegister, sessionId: "r", deviceId: "phone", text: #"{"apns_token":"aabb","env":"prod"}"#))
        let body = try JSONSerialization.jsonObject(with: Data(response!.text!.utf8)) as! [String: Any]
        XCTAssertEqual(body["push_enabled"] as? Bool, false)
    }
}
private actor PushRecorder: APNsSending {
    var pushes: [APNsPushAlert] = []
    func send(_ push: APNsPushAlert) async throws -> APNsSendResult { pushes.append(push); return .delivered(apnsId: "test") }
}
private final class PushClock: @unchecked Sendable {
    let lock = NSLock(); var value = Date(timeIntervalSince1970: 1000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ interval: TimeInterval) { lock.lock(); defer { lock.unlock() }; value.addTimeInterval(interval) }
}
