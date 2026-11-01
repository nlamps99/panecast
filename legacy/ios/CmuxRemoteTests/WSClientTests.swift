import XCTest
@testable import CmuxRemote

final class WSClientTests: XCTestCase {
    func testCloseDuringBackoffDoesNotReconnect() async throws {
        let client = WSClient(url: URL(string: "ws://127.0.0.1:1")!, headers: [:])
        let closed = expectation(description: "connection failed")
        closed.assertForOverFulfill = false
        let opens = LockBox(0)
        await client.setOnOpen { opens.withValue { $0 += 1 } }
        await client.setOnClose { _ in closed.fulfill() }
        await client.connect()
        await fulfillment(of: [closed], timeout: 5)
        await client.close()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(opens.withValue { $0 }, 1)
    }

    func testConnectsAndDeliversTextFrame() async throws {
        try XCTSkipIf(ProcessInfo.processInfo.environment["WS_ECHO"] != "1", "set WS_ECHO=1 to run")
        let url = URL(string: "wss://echo.websocket.events/")!
        let exp = expectation(description: "received echo")
        let client = WSClient(url: url, headers: [:])
        await client.setOnText { text in if text.contains("hello") { exp.fulfill() } }
        await client.connect()
        await client.send(text: "hello")
        await fulfillment(of: [exp], timeout: 5)
        await client.close()
    }
}
