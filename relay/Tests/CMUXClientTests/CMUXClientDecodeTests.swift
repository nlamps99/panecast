import XCTest
import NIOCore
import SharedKit
@testable import CMUXClient

/// Responses are decoded once, straight into what the caller wants.
final class CMUXClientDecodeTests: XCTestCase {
    func testReadTextDecodesStraightFromTheResponseLine() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }

        async let screen = fix.client.surfaceReadText(workspaceId: "w", surfaceId: "s", lines: 50)
        let request = try await fix.awaitRequestLine()
        XCTAssertTrue(request.contains(#""method":"surface.read_text""#), request)
        try await fix.sendToClient(line: #"{"id":"\#(try Self.id(in: request))","ok":true,"result":{"text":"$ ls\nа  b","base64":"JCBscwrQsCAgYg==","surface_id":"s"}}"#)

        let value = try await screen
        XCTAssertEqual(value.rows, ["$ ls", "а  b"])
        XCTAssertEqual(value.cols, 4)
    }

    func testRenderGridDecodesItsSnakeCaseKeysFromTheResponseLine() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }

        async let grid = fix.client.surfaceRenderGrid(workspaceId: "w", surfaceId: "s", scrollback: 0)
        let request = try await fix.awaitRequestLine()
        XCTAssertTrue(request.contains(#""method":"terminal.replay""#), request)
        let result = #"{"columns":20,"rows":2,"render_grid":{"columns":20,"rows":2,"cursor":{"row":1,"column":2,"visible":true},"styles":[{"id":1,"foreground_source":"palette","foreground_palette_index":1}],"row_spans":[{"row":0,"column":0,"style_id":1,"text":"red","cell_width":3}],"scrollback_rows":0,"scrollback_spans":[]}}"#
        try await fix.sendToClient(line: #"{"id":"\#(try Self.id(in: request))","result":\#(result)}"#)

        let screen = try await grid.toScreen(rev: 0, maxRows: 10)
        XCTAssertEqual(screen.rows.first, "\u{1B}[31mred\u{1B}[0m")
        XCTAssertEqual(screen.cursor, CursorPos(x: 2, y: 1))
    }

    func testTypedCallsSurfaceCmuxErrors() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }

        async let screen = fix.client.surfaceReadText(workspaceId: "w", surfaceId: "gone", lines: 5)
        let request = try await fix.awaitRequestLine()
        try await fix.sendToClient(line: #"{"id":"\#(try Self.id(in: request))","ok":false,"error":{"code":"not_found","message":"Surface not found"}}"#)
        do {
            _ = try await screen
            XCTFail("expected the cmux error")
        } catch CMUXClientError.rpc(let error) {
            XCTAssertEqual(error.code, "not_found")
        }
    }

    func testReplayWithoutAGridIsUnavailable() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }

        async let grid = fix.client.surfaceRenderGrid(workspaceId: "w", surfaceId: "s", scrollback: 0)
        let request = try await fix.awaitRequestLine()
        try await fix.sendToClient(line: #"{"id":"\#(try Self.id(in: request))","result":{"rows":2}}"#)
        do {
            _ = try await grid
            XCTFail("expected unavailable")
        } catch is CMUXRenderGridUnavailable {}
    }

    /// An events frame carries its own (numeric or string) id: it is an
    /// event, never the answer to a waiting call.
    func testEventsFramesNeverResolveAPendingCall() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }
        let events = EventBox()
        await fix.client.onEventStream { frame in
            if case .event(let event) = frame { Task { await events.add(event.name) } }
        }

        async let response = fix.client.call(method: "workspace.list", params: .object([:]))
        let request = try await fix.awaitRequestLine()
        let id = try Self.id(in: request)
        try await fix.sendToClient(line: #"{"protocol":"cmux-events","id":"\#(id)","category":"workspace","name":"workspace.created","payload":{"n":1}}"#)
        try await fix.sendToClient(line: #"{"protocol":"cmux-events","id":7,"category":"workspace","name":"workspace.renamed"}"#)
        try await fix.sendToClient(line: #"{"id":"\#(id)","result":{"workspaces":[]}}"#)

        let value = try await response
        XCTAssertEqual(value.result, .object(["workspaces": .array([])]))
        for _ in 0..<50 where await events.names.count < 2 { try await Task.sleep(nanoseconds: 10_000_000) }
        let names = await events.names
        XCTAssertEqual(names, ["workspace.created", "workspace.renamed"])
    }

    func testSendKeyUsesTheCmuxName() async throws {
        let fix = try await MTELGCmuxFixture.make(requestTimeout: .seconds(2))
        defer { Task { await fix.shutdown() } }

        async let sent: Void = fix.client.surfaceSendKey(workspaceId: "w", surfaceId: "s", key: .pageUp)
        let request = try await fix.awaitRequestLine()
        XCTAssertTrue(request.contains(#""key":"pageup""#), request)
        try await fix.sendToClient(line: #"{"id":"\#(try Self.id(in: request))","result":{}}"#)
        try await sent
    }

    private static func id(in line: String) throws -> String {
        let regex = try NSRegularExpression(pattern: #"\"id\":\"([^\"]+)\""#)
        let match = try XCTUnwrap(regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)), "no id in: \(line)")
        return String(line[Range(match.range(at: 1), in: line)!])
    }
}

private actor EventBox {
    var names: [String] = []
    func add(_ name: String) { names.append(name) }
}
