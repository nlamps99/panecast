import XCTest
import NIOCore
import NIOEmbedded
import NIOWebSocket
import SharedKit
@testable import RelayServer
@testable import RelayCore

final class RequestLaneClassificationTests: XCTestCase {
    func testWritesReadsAndBulkWork() {
        for method in ["surface.send_text", "surface.send_key", "surface.input", "terminal.paste", "terminal.scroll",
                       "workspace.create", "surface.close", "notification.create", "surface.subscribe",
                       "surface.unsubscribe", "something.new"] {
            XCTAssertEqual(WSRequestLane.of(method: method), .input, method)
        }
        for method in ["surface.read_text", "workspace.list", "surface.list", "window.list", "terminal.replay",
                       "relay.info", "host.battery", "surface.resume.get", "inbox.sync"] {
            XCTAssertEqual(WSRequestLane.of(method: method), .read, method)
        }
        for method in ["surface.history", "file.upload", "project.diff", "project.read"] {
            XCTAssertEqual(WSRequestLane.of(method: method), .bulk, method)
        }
    }

    func testSerialQueueKeepsEnqueueOrder() async {
        let queue = SerialTaskQueue()
        let log = OrderLog()
        for index in 0..<50 {
            queue.enqueue {
                if index % 7 == 0 { try? await Task.sleep(nanoseconds: 1_000_000) }
                await log.add("\(index)")
            }
        }
        let done = expectation(description: "drained")
        queue.enqueue { done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        let entries = await log.entries
        XCTAssertEqual(entries, (0..<50).map(String.init))
    }
}

/// `WebSocketHandler` on a test channel, the way the upgrader installs it:
/// added to a channel that is already active.
final class WebSocketHandlerLaneTests: XCTestCase {
    private static let hello = #"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#

    private func makeChannel(cmux: CMUXFacade, manager: SessionManager? = nil) async throws -> (NIOAsyncTestingChannel, SessionManager) {
        let channel = NIOAsyncTestingChannel()
        try await channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).get()
        let manager = manager ?? SessionManager(reader: BlankReader(), defaultFps: 15, idleFps: 5)
        let handler = WebSocketHandler(deviceId: "d", deviceStore: try DeviceStore.empty(), sessionManager: manager,
                                       cmuxClient: cmux, history: SurfaceHistoryService(cmux: cmux))
        try await channel.pipeline.addHandler(handler)
        return (channel, manager)
    }

    private func send(_ text: String, to channel: NIOAsyncTestingChannel) async throws {
        var buffer = channel.allocator.buffer(capacity: text.utf8.count)
        buffer.writeString(text)
        try await channel.writeInbound(WebSocketFrame(fin: true, opcode: .text, data: buffer))
    }

    /// The next response the handler wrote, or nil after `timeout` seconds.
    private func nextResponse(from channel: NIOAsyncTestingChannel, timeout: TimeInterval = 2) async throws -> RPCResponse? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let frame = try await channel.readOutbound(as: WebSocketFrame.self) {
                let data = frame.unmaskedData
                let text = data.getString(at: data.readerIndex, length: data.readableBytes) ?? ""
                if let response = try? JSONDecoder().decode(RPCResponse.self, from: Data(text.utf8)) { return response }
                continue
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        return nil
    }

    private func attach(_ channel: NIOAsyncTestingChannel, _ manager: SessionManager) async throws {
        try await send(Self.hello, to: channel)
        for _ in 0..<200 where await manager.activeSessionCount == 0 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let count = await manager.activeSessionCount
        XCTAssertEqual(count, 1, "hello attaches a session")
    }

    private func waitUntilClosed(_ channel: NIOAsyncTestingChannel) async throws {
        for _ in 0..<200 where channel.isActive { try await Task.sleep(nanoseconds: 5_000_000) }
    }

    // MARK: Hello deadline

    func testASilentConnectionClosesAfterFiveSecondsNotBefore() async throws {
        let (channel, _) = try await makeChannel(cmux: GatedFacade())
        await channel.testingEventLoop.advanceTime(by: .milliseconds(4_900))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(channel.isActive, "a busy gateway's late hello must still be accepted")
        await channel.testingEventLoop.advanceTime(by: .milliseconds(200))
        try await waitUntilClosed(channel)
        XCTAssertFalse(channel.isActive, "the deadline is armed even though the channel was already active")
    }

    func testAHelloSecondsLateStillAttaches() async throws {
        let (channel, manager) = try await makeChannel(cmux: GatedFacade())
        await channel.testingEventLoop.advanceTime(by: .seconds(3))
        try await attach(channel, manager)
        await channel.testingEventLoop.advanceTime(by: .seconds(10))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(channel.isActive)
        _ = try await channel.close()
    }

    func testTheSessionIsDetachedWhenThePeerLeaves() async throws {
        let (channel, manager) = try await makeChannel(cmux: GatedFacade())
        try await attach(channel, manager)
        _ = try await channel.close()
        for _ in 0..<200 where await manager.activeSessionCount > 0 { try await Task.sleep(nanoseconds: 5_000_000) }
        let count = await manager.activeSessionCount
        XCTAssertEqual(count, 0)
    }

    // MARK: Lanes

    func testAKeystrokeIsAnsweredWhileAReadIsStillRunning() async throws {
        let cmux = GatedFacade(gated: ["surface.read_text"])
        let (channel, manager) = try await makeChannel(cmux: cmux)
        try await attach(channel, manager)

        try await send(#"{"id":"read","method":"surface.read_text","params":{"workspace_id":"w","surface_id":"s","lines":5}}"#, to: channel)
        try await send(#"{"id":"key","method":"surface.send_key","params":{"workspace_id":"w","surface_id":"s","key":"pgup"}}"#, to: channel)

        let first = try await nextResponse(from: channel)
        XCTAssertEqual(first?.id, "key", "input must not wait behind the read")
        let started = await cmux.started
        XCTAssertEqual(started, ["surface.read_text", "surface.send_key:pageup"])

        await cmux.release("surface.read_text")
        let second = try await nextResponse(from: channel)
        XCTAssertEqual(second?.id, "read")
        _ = try await channel.close()
    }

    func testWritesKeepTheirOrderEvenWhenOneIsSlow() async throws {
        let cmux = GatedFacade(gated: ["surface.send_text"])
        let (channel, manager) = try await makeChannel(cmux: cmux)
        try await attach(channel, manager)

        try await send(#"{"id":"1","method":"surface.send_text","params":{"workspace_id":"w","surface_id":"s","text":"a"}}"#, to: channel)
        try await send(#"{"id":"2","method":"surface.send_key","params":{"workspace_id":"w","surface_id":"s","key":"enter"}}"#, to: channel)
        try await send(#"{"id":"3","method":"surface.input","params":{"workspace_id":"w","surface_id":"s","items":[{"key":"f5"},{"text":"b"}]}}"#, to: channel)
        try await send(#"{"id":"4","method":"workspace.list","params":{}}"#, to: channel)

        let read = try await nextResponse(from: channel)
        XCTAssertEqual(read?.id, "4", "a read does not wait for writes either")
        try await Task.sleep(nanoseconds: 50_000_000)
        let whileBlocked = await cmux.started
        XCTAssertEqual(whileBlocked.filter { $0 != "workspace.list" }, ["surface.send_text:a"], "no later write overtakes the slow one")

        await cmux.release("surface.send_text")
        var ids: [String] = []
        for _ in 0..<3 { if let response = try await nextResponse(from: channel) { ids.append(response.id) } }
        XCTAssertEqual(ids, ["1", "2", "3"])
        let all = await cmux.started
        XCTAssertEqual(all.filter { $0 != "workspace.list" },
                       ["surface.send_text:a", "surface.send_key:enter", "surface.send_text:\u{1B}[15~", "surface.send_text:b"])
        _ = try await channel.close()
    }

    func testSubscribingDoesNotReadTheScrollback() async throws {
        let cmux = GatedFacade()
        let (channel, manager) = try await makeChannel(cmux: cmux)
        try await attach(channel, manager)
        try await send(#"{"id":"sub","method":"surface.subscribe","params":{"workspace_id":"w","surface_id":"s","lines":40}}"#, to: channel)
        let response = try await nextResponse(from: channel)
        XCTAssertEqual(response?.id, "sub")
        XCTAssertEqual(response?.ok, true)
        try await Task.sleep(nanoseconds: 100_000_000)
        let started = await cmux.started
        XCTAssertEqual(started, [], "the scrollback is read when a history page is asked for")
        _ = try await channel.close()
    }

    func testInputFromOneViewerWakesEveryViewerOfTheTerminal() async throws {
        let reader = InputCountingReader()
        let manager = SessionManager(reader: reader, defaultFps: 15, idleFps: 5)
        let other = await manager.attach(deviceId: "desktop") { _ in }
        await other.subscribe(workspaceId: "w", surfaceId: "s", lines: 10)
        let (channel, _) = try await makeChannel(cmux: GatedFacade(), manager: manager)
        try await send(Self.hello, to: channel)
        for _ in 0..<200 where await manager.activeSessionCount < 2 { try await Task.sleep(nanoseconds: 5_000_000) }
        try await send(#"{"id":"sub","method":"surface.subscribe","params":{"workspace_id":"w","surface_id":"s","lines":40}}"#, to: channel)
        _ = try await nextResponse(from: channel)

        try await send(#"{"id":"p","method":"terminal.paste","params":{"workspace_id":"w","surface_id":"s","text":"hi"}}"#, to: channel)
        _ = try await nextResponse(from: channel)
        XCTAssertEqual(reader.inputs, ["s", "s"], "both subscribed sessions hear about the paste")
        await manager.detach(session: other)
        _ = try await channel.close()
    }
}

final class SurfaceKeyAliasTests: XCTestCase {
    func testSendKeyNamesCmuxDoesNotKnowAreTranslated() async throws {
        let cmux = GatedFacade()
        let machine = WSProtocolMachine(cmux: cmux)
        _ = await machine.processText(#"{"deviceId":"d","appVersion":"1","protocolVersion":1}"#)
        for key in ["pgdn", "enter", "shift-home", "ctrl-/"] {
            _ = await machine.processText(#"{"id":"1","method":"surface.send_key","params":{"workspace_id":"w","surface_id":"s","key":"\#(key)"}}"#)
        }
        let started = await cmux.started
        XCTAssertEqual(started, ["surface.send_key:pagedown", "surface.send_key:enter",
                                 "surface.send_text:\u{1B}[1;2H", "surface.send_text:\u{1F}"])
    }
}

// MARK: - Test doubles

private actor OrderLog {
    var entries: [String] = []
    func add(_ entry: String) { entries.append(entry) }
}

private struct BlankReader: SurfaceReader {
    func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        Screen(rev: 0, rows: [""], cols: 0, cursor: CursorPos(x: 0, y: 0))
    }
}

private final class InputCountingReader: SurfaceReader, @unchecked Sendable {
    private let lock = NSLock()
    private var noted: [String] = []
    var inputs: [String] { lock.withLock { noted } }
    func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        Screen(rev: 0, rows: [""], cols: 0, cursor: CursorPos(x: 0, y: 0))
    }
    func noteInput(surfaceId: String) { lock.withLock { noted.append(surfaceId) } }
}

/// Records each dispatch as it starts (`method` or `method:key-or-text`);
/// methods in `gated` wait until released.
private actor GatedFacade: CMUXFacade {
    private let gated: Set<String>
    private var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var released: Set<String> = []
    private(set) var started: [String] = []

    init(gated: Set<String> = []) { self.gated = gated }

    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        var label = method
        if case .object(let fields) = params {
            if case .string(let key)? = fields["key"] { label += ":\(key)" }
            else if case .string(let text)? = fields["text"] { label += ":\(text)" }
        }
        started.append(label)
        if gated.contains(method), !released.contains(method) {
            await withCheckedContinuation { waiting[method, default: []].append($0) }
        }
        return .object([:])
    }

    func release(_ method: String) {
        released.insert(method)
        for continuation in waiting.removeValue(forKey: method) ?? [] { continuation.resume() }
    }
}
