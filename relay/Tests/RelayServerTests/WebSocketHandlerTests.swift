import XCTest
import SharedKit
@testable import RelayServer
@testable import RelayCore

final class WebSocketHandlerTests: XCTestCase {

    // MARK: - Hello flow

    func testHelloMissedReturnsClose() async {
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        let actions = await m.helloMissed()
        XCTAssertEqual(actions, [.close])
    }

    func testValidHelloEmitsAttach() async {
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        let json = #"{"deviceId":"d-7","appVersion":"1.0.0","protocolVersion":1}"#
        let actions = await m.processText(json)
        XCTAssertEqual(actions, [.attachSession(deviceId: "d-7")])
    }

    func testInvalidFirstFrameClosesBeforeHello() async {
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        let actions = await m.processText("not json")
        XCTAssertEqual(actions, [.close])
    }

    func testFirstFrameWrongShapeClosesBeforeHello() async {
        // Looks like JSON but isn't a HelloFrame.
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        let actions = await m.processText(#"{"id":"1","method":"workspace.list","params":{}}"#)
        XCTAssertEqual(actions, [.close])
    }

    func testHelloMissedAfterHelloIsNoop() async {
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)
        let actions = await m.helloMissed()
        XCTAssertEqual(actions, [])
    }

    // MARK: - RPC dispatch

    func testTerminalGesturesWakeScreenPollingBeforeDispatch() async {
        let cmux = InputActivityFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)
        for method in ["terminal.scroll", "surface.send_key", "surface.send_text", "surface.read_text"] {
            let text = "{\"id\":\"1\",\"method\":\"\(method)\",\"params\":{\"surface_id\":\"s\"}}"
            _ = await machine.processText(text) { surfaceId in await cmux.note(surfaceId) }
        }
        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, ["active:s", "terminal.scroll", "active:s", "surface.send_key",
                               "active:s", "surface.send_text", "surface.read_text"])
    }

    func testRPCDispatchesToFacade() async {
        let cmux = RecordingCMUXFacade()
        let m = WSProtocolMachine(cmux: cmux)
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await m.processText(#"{"id":"1","method":"workspace.list","params":{}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls.map(\.method), ["workspace.list"])
        XCTAssertEqual(actions.count, 1)
        guard case .sendText(let s) = actions[0] else {
            return XCTFail("expected sendText, got \(actions[0])")
        }
        XCTAssertTrue(s.contains(#""id":"1""#), "missing id: \(s)")
        XCTAssertTrue(s.contains(#""ok":true"#), "missing ok=true: \(s)")
    }

    func testRPCErrorYieldsErrorResponse() async {
        let cmux = ThrowingCMUXFacade()
        let m = WSProtocolMachine(cmux: cmux)
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await m.processText(#"{"id":"7","method":"surface.send_text","params":{}}"#)
        XCTAssertEqual(actions.count, 1)
        guard case .sendText(let s) = actions[0] else {
            return XCTFail("expected sendText, got \(actions[0])")
        }
        XCTAssertTrue(s.contains(#""ok":false"#), "missing ok=false: \(s)")
        XCTAssertTrue(s.contains(#""code":"internal_error""#), "missing code: \(s)")
    }

    func testGarbageAfterHelloIsIgnored() async {
        let m = WSProtocolMachine(cmux: NoOpCMUXFacade())
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)
        let actions = await m.processText("not json")
        XCTAssertEqual(actions, [])
    }

    func testSurfaceSubscribeBecomesRelayActionWithoutCmuxDispatch() async {
        let cmux = RecordingCMUXFacade()
        let m = WSProtocolMachine(cmux: cmux)
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await m.processText(#"{"id":"9","method":"surface.subscribe","params":{"workspace_id":"w","surface_id":"s","fps":15}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(actions, [.subscribe(responseId: "9", workspaceId: "w", surfaceId: "s", lines: 200)])
    }

    func testSurfaceSubscribeUsesRequestedLineCount() async {
        let cmux = RecordingCMUXFacade()
        let m = WSProtocolMachine(cmux: cmux)
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await m.processText(#"{"id":"9","method":"surface.subscribe","params":{"workspace_id":"w","surface_id":"s","fps":15,"lines":120}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(actions, [.subscribe(responseId: "9", workspaceId: "w", surfaceId: "s", lines: 120)])
    }

    func testSurfaceUnsubscribeBecomesRelayActionWithoutCmuxDispatch() async {
        let cmux = RecordingCMUXFacade()
        let m = WSProtocolMachine(cmux: cmux)
        _ = await m.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await m.processText(#"{"id":"10","method":"surface.unsubscribe","params":{"surface_id":"s"}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(actions, [.unsubscribe(responseId: "10", surfaceId: "s")])
    }

    func testSurfaceHistoryBecomesRelayActionWithCursor() async {
        let cmux = RecordingCMUXFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)

        let actions = await machine.processText(#"{"id":"11","method":"surface.history","params":{"workspace_id":"w","surface_id":"s","cursor":"opaque","tail_lines":120,"limit":200}}"#)

        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(actions, [
            .history(
                responseId: "11",
                workspaceId: "w",
                surfaceId: "s",
                cursor: "opaque",
                tailLines: 120,
                limit: 200
            ),
        ])
    }
}

// MARK: - Test doubles

private actor InputActivityFacade: CMUXFacade {
    private var calls: [String] = []
    func note(_ surfaceId: String) { calls.append("active:\(surfaceId)") }
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        calls.append(method)
        return .object([:])
    }
    func snapshot() -> [String] { calls }
}

final class NoOpCMUXFacade: CMUXFacade {
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        .object([:])
    }
}

actor RecordingCMUXFacade: CMUXFacade {
    struct Call: Equatable, Sendable { let method: String }
    private var calls: [Call] = []
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        calls.append(.init(method: method))
        return .object([:])
    }
    func snapshot() -> [Call] { calls }
}

final class ThrowingCMUXFacade: CMUXFacade {
    struct Boom: Error {}
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        throw Boom()
    }
}

actor ParamsRecordingFacade: CMUXFacade {
    private var calls: [String] = []
    private let failOn: String?
    init(failOn: String? = nil) { self.failOn = failOn }
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        guard case .object(let fields) = params else { return .object([:]) }
        let value: String
        switch (fields["text"], fields["key"]) {
        case (.string(let text)?, _): value = text
        case (_, .string(let key)?): value = key
        default: value = ""
        }
        calls.append("\(method):\(value)")
        if method == failOn { throw ThrowingCMUXFacade.Boom() }
        return .object([:])
    }
    func snapshot() -> [String] { calls }
}

final class SurfaceInputTests: XCTestCase {
    private func hello(_ machine: WSProtocolMachine) async {
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)
    }

    func testBatchSendsEachItemInOrderAndWakesPolling() async throws {
        let cmux = ParamsRecordingFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        await hello(machine)
        let woke = ActivityBox()
        let actions = await machine.processText(#"{"id":"7","method":"surface.input","params":{"workspace_id":"w","surface_id":"s","items":[{"text":"ls"},{"key":"enter"},{"text":"中"}]}}"#) { id in await woke.add(id) }
        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, ["surface.send_text:ls", "surface.send_key:enter", "surface.send_text:中"])
        let wakes = await woke.values
        XCTAssertEqual(wakes, ["s"])
        guard case .sendText(let text)? = actions.first else { return XCTFail("no response") }
        let response = try JSONDecoder().decode(RPCResponse.self, from: Data(text.utf8))
        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.result, .object(["sent": .int(3)]))
    }

    func testFailureReportsHowManyArrived() async throws {
        let machine = WSProtocolMachine(cmux: ParamsRecordingFacade(failOn: "surface.send_key"))
        await hello(machine)
        let actions = await machine.processText(#"{"id":"8","method":"surface.input","params":{"workspace_id":"w","surface_id":"s","items":[{"text":"a"},{"key":"enter"},{"text":"b"}]}}"#)
        guard case .sendText(let text)? = actions.first else { return XCTFail("no response") }
        let response = try JSONDecoder().decode(RPCResponse.self, from: Data(text.utf8))
        XCTAssertEqual(response.ok, false)
        XCTAssertEqual(response.error?.data, .object(["sent": .int(1)]))
    }

    func testInvalidBatchesAreRejectedBeforeAnythingIsSent() async throws {
        let cmux = ParamsRecordingFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        await hello(machine)
        for items in [#"[]"#, #"[{"text":"a","key":"enter"}]"#, #"[{"key":"enter\n"}]"#, #"[{"text":""}]"#] {
            let actions = await machine.processText(#"{"id":"9","method":"surface.input","params":{"workspace_id":"w","surface_id":"s","items":"# + items + "}}")
            guard case .sendText(let text)? = actions.first else { return XCTFail("no response") }
            let response = try JSONDecoder().decode(RPCResponse.self, from: Data(text.utf8))
            XCTAssertEqual(response.error?.code, "invalid_params", items)
        }
        let calls = await cmux.snapshot()
        XCTAssertEqual(calls, [])
    }
}

actor ActivityBox {
    var values: [String] = []
    func add(_ value: String) { values.append(value) }
}
