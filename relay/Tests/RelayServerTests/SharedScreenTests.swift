import XCTest
import CMUXClient
import RelayCore
import SharedKit
@testable import RelayServer

final class HybridScreenEchoTests: XCTestCase {
    private let green = "\u{1B}[32m$\u{1B}[0m"

    func testTheEchoIsSentAheadOfTheGridOnce() {
        var screen = HybridScreen()
        XCTAssertTrue(screen.acceptText(["$ l"], at: 10))
        screen.acceptGrid(rows: [green + " l"], cursor: CursorPos(x: 3, y: 0), at: 10)

        screen.noteInput(at: 11)
        XCTAssertFalse(screen.acceptText(["$ ls"], at: 11.016), "the echo goes out from the text read")
        XCTAssertTrue(screen.acceptText(["$ ls"], at: 11.05), "the grid follows on the next read")
        screen.acceptGrid(rows: [green + " ls"], cursor: CursorPos(x: 4, y: 0), at: 11.05)

        screen.noteInput(at: 12)
        XCTAssertFalse(screen.acceptText(["$ ls "], at: 12.016))
        XCTAssertTrue(screen.acceptText(["$ ls -"], at: 12.2), "a second change after the same input does get its grid")
    }

    func testOutputLongAfterInputIsNotHeldBack() {
        var screen = HybridScreen()
        _ = screen.acceptText(["$ make"], at: 10)
        screen.acceptGrid(rows: [green + " make"], cursor: nil, at: 10)
        screen.noteInput(at: 10.5)
        XCTAssertTrue(screen.acceptText(["$ make", "done"], at: 12), "streaming output reads its grid as before")
    }

    func testATypedRowKeepsTheColorsOfItsUnchangedStart() {
        var screen = HybridScreen()
        let text = ["one", "$ ls"]
        _ = screen.acceptText(text, at: 1)
        screen.acceptGrid(rows: ["one", green + " ls"], cursor: CursorPos(x: 4, y: 1), at: 1)
        screen.noteInput(at: 2)
        XCTAssertFalse(screen.acceptText(["one", "$ lsx"], at: 2.016))
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 5).rows, ["one", green + " lsx"])
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 5).cursor, CursorPos(x: 5, y: 1), "the cursor follows the typed character")
        _ = screen.acceptText(["one", "$ l"], at: 2.02)
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 5).rows, ["one", green + " l"], "a deletion too")
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 5).cursor, CursorPos(x: 3, y: 1))
    }

    func testTheCursorStaysPutWhenItWasNotAtTheEndOfTheLine() {
        var screen = HybridScreen()
        _ = screen.acceptText(["$ ls"], at: 1)
        screen.acceptGrid(rows: [green + " ls"], cursor: CursorPos(x: 2, y: 0), at: 1)
        screen.noteInput(at: 2)
        _ = screen.acceptText(["$ xls"], at: 2.016)
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 5).cursor, CursorPos(x: 2, y: 0), "an insertion mid-line waits for the grid")
    }

    func testColorsCarriedOverAStyledRunAreClosed() {
        let red = "\u{1B}[31mhello world\u{1B}[0m"
        XCTAssertEqual(HybridScreen.keepingColors(red, was: "hello world", now: "hello there"),
                       "\u{1B}[31mhello \u{1B}[0mthere")
        XCTAssertNil(HybridScreen.keepingColors(red, was: "hello world", now: "bye"), "nothing shared")
        XCTAssertNil(HybridScreen.keepingColors("plain", was: "plain", now: "plainer"), "no colors to keep")
    }

    func testAScrolledScreenDoesNotBorrowColorsFromUnrelatedRows() {
        var screen = HybridScreen()
        _ = screen.acceptText(["a1", "a2", "a3", "a4"], at: 1)
        screen.acceptGrid(rows: ["\u{1B}[31ma1\u{1B}[0m", "\u{1B}[31ma2\u{1B}[0m", "\u{1B}[31ma3\u{1B}[0m", "\u{1B}[31ma4\u{1B}[0m"], cursor: nil, at: 1)
        _ = screen.acceptText(["a5", "a6", "a7", "a8"], at: 1.05)
        XCTAssertEqual(screen.screen(maxRows: 10, cols: 2).rows, ["a5", "a6", "a7", "a8"])
    }
}

final class CmuxSurfaceReaderSharingTests: XCTestCase {
    func testViewersWithDifferentLineCountsKeepTheirOwnScreens() async throws {
        let source = FakeScreenSource(rows: (1...10).map { "line \($0)" })
        let clock = TestClock()
        let reader = CmuxSurfaceReader(source: source, now: { clock.now })
        for _ in 0..<6 {
            let phone = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
            let desktop = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 4)
            XCTAssertEqual(phone.rows.count, 8, "the other viewer's read must not change this viewer's rows")
            XCTAssertEqual(desktop.rows.count, 4)
            XCTAssertEqual(phone.rows.last, "\u{1B}[31mline 10\u{1B}[0m")
            XCTAssertEqual(desktop.rows.last, "\u{1B}[31mline 10\u{1B}[0m")
            clock.advance(1)
        }
        XCTAssertEqual(source.gridReads, 2, "a quiet terminal is not re-read for colors every interval")
    }

    func testOneGridServesEveryViewerOnceTheyHaveAScreen() async throws {
        let source = FakeScreenSource(rows: ["$ a"])
        let clock = TestClock()
        let reader = CmuxSurfaceReader(source: source, now: { clock.now })
        _ = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
        _ = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 4)
        XCTAssertEqual(source.gridReads, 2)
        source.rows = ["$ a", "$ b"]
        clock.advance(1)
        _ = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
        clock.advance(0.01)
        let desktop = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 4)
        XCTAssertEqual(source.gridReads, 3, "the phone's grid colored the desktop's screen too")
        XCTAssertEqual(desktop.rows, ["\u{1B}[31m$ a\u{1B}[0m", "\u{1B}[31m$ b\u{1B}[0m"])
    }

    func testTheEchoArrivesWithoutWaitingForTheGrid() async throws {
        let source = FakeScreenSource(rows: ["$ "])
        let clock = TestClock()
        let reader = CmuxSurfaceReader(source: source, now: { clock.now })
        _ = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
        XCTAssertEqual(source.gridReads, 1)

        clock.advance(1)
        reader.noteInput(surfaceId: "s")
        source.rows = ["$ x"]
        clock.advance(0.016)
        let echo = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
        XCTAssertEqual(source.gridReads, 1, "the first read after the keystroke skips the grid")
        XCTAssertEqual(echo.rows, ["\u{1B}[31m$\u{1B}[0m x"], "showing the echo, the prompt's colors kept")

        clock.advance(0.034)
        let colored = try await reader.read(workspaceId: "w", surfaceId: "s", lines: 8)
        XCTAssertEqual(source.gridReads, 2)
        XCTAssertEqual(colored.rows, ["\u{1B}[31m$ x\u{1B}[0m"])
    }
}

final class CmuxSurfaceReaderEvictionTests: XCTestCase {
    private func read(_ reader: CmuxSurfaceReader, _ surface: String, lines: Int = 8) async throws -> Screen {
        try await reader.read(workspaceId: "w", surfaceId: surface, lines: lines)
    }

    func testTheLastViewerLeavingDropsOnlyThatScreen() async throws {
        let source = FakeScreenSource(rows: ["$ a"])
        let reader = CmuxSurfaceReader(source: source)
        reader.viewerStarted(surfaceId: "s", lines: 8)
        reader.viewerStarted(surfaceId: "s", lines: 8)
        reader.viewerStarted(surfaceId: "s", lines: 4)
        _ = try await read(reader, "s", lines: 8)
        _ = try await read(reader, "s", lines: 4)
        XCTAssertEqual(reader.trackedScreens, 2)

        reader.viewerStopped(surfaceId: "s", lines: 8)
        XCTAssertTrue(reader.isTracking(surfaceId: "s", lines: 8), "another subscriber still reads 8 lines")
        reader.viewerStopped(surfaceId: "s", lines: 8)
        XCTAssertFalse(reader.isTracking(surfaceId: "s", lines: 8))
        XCTAssertTrue(reader.isTracking(surfaceId: "s", lines: 4))

        let grids = source.gridReads
        let desktop = try await read(reader, "s", lines: 4)
        XCTAssertEqual(source.gridReads, grids, "the remaining viewer keeps its colors")
        XCTAssertEqual(desktop.rows, ["\u{1B}[31m$ a\u{1B}[0m"])
        reader.viewerStopped(surfaceId: "s", lines: 4)
        XCTAssertEqual(reader.trackedScreens, 0)
    }

    func testPastTheCapOnlyTheLeastRecentlyUsedScreenGoes() async throws {
        let source = FakeScreenSource(rows: ["$ a"])
        let reader = CmuxSurfaceReader(source: source, maxTracked: 3)
        for surface in ["a", "b", "c"] { _ = try await read(reader, surface) }
        _ = try await read(reader, "a")
        _ = try await read(reader, "d")
        XCTAssertEqual(reader.trackedScreens, 3)
        XCTAssertFalse(reader.isTracking(surfaceId: "b", lines: 8))
        let grids = source.gridReads
        for surface in ["a", "c", "d"] {
            let screen = try await read(reader, surface)
            XCTAssertEqual(screen.rows, ["\u{1B}[31m$ a\u{1B}[0m"], "\(surface) kept its colors")
        }
        XCTAssertEqual(source.gridReads, grids)
    }

    func testUnwatchedScreensGoBeforeWatchedOnes() async throws {
        let source = FakeScreenSource(rows: ["$ a"])
        let reader = CmuxSurfaceReader(source: source, maxTracked: 2)
        reader.viewerStarted(surfaceId: "watched", lines: 8)
        _ = try await read(reader, "watched")
        _ = try await read(reader, "stray")
        _ = try await read(reader, "new")
        XCTAssertTrue(reader.isTracking(surfaceId: "watched", lines: 8), "older, but someone is subscribed")
        XCTAssertFalse(reader.isTracking(surfaceId: "stray", lines: 8))
        XCTAssertTrue(reader.isTracking(surfaceId: "new", lines: 8))
    }

    func testAReadWhoseScreenWasDroppedMidwayStillReturnsItsText() async throws {
        let source = FakeScreenSource(rows: ["$ a", "$ b"])
        let reader = CmuxSurfaceReader(source: source)
        reader.viewerStarted(surfaceId: "s", lines: 8)
        source.onGrid = { _ in reader.viewerStopped(surfaceId: "s", lines: 8) }
        let screen = try await read(reader, "s")
        XCTAssertEqual(screen.rows, ["$ a", "$ b"], "plain text, not an empty screen")
        XCTAssertFalse(reader.isTracking(surfaceId: "s", lines: 8), "not re-tracked for a viewer that left")
    }
}

final class SurfaceHistoryReadSharingTests: XCTestCase {
    func testOverlappingRequestsShareOneScrollbackRead() async throws {
        let facade = SlowHistoryFacade(rows: (0..<10).map { "row \($0)" })
        let service = SurfaceHistoryService(cmux: facade)
        async let prewarm: Void = service.prewarm(workspaceId: "w", surfaceId: "s")
        async let first = service.page(workspaceId: "w", surfaceId: "s", cursor: nil, tailLines: 2, limit: 3)
        try await Task.sleep(nanoseconds: 50_000_000)
        await facade.release()
        _ = await prewarm
        let page = try await first
        guard case .object(let values) = page, case .array(let rows)? = values["rows"] else { return XCTFail("no rows") }
        XCTAssertEqual(rows, ["row 5", "row 6", "row 7"].map(JSONValue.string))
        let calls = await facade.calls
        XCTAssertEqual(calls, 1)
    }

    func testAFailedReadIsNotReusedByTheNextRequest() async throws {
        let facade = SlowHistoryFacade(rows: ["a"], failFirst: true)
        let service = SurfaceHistoryService(cmux: facade)
        await facade.release()
        do {
            _ = try await service.page(workspaceId: "w", surfaceId: "s", cursor: nil, tailLines: 1, limit: 1)
            XCTFail("expected the first read to fail")
        } catch {}
        _ = try await service.page(workspaceId: "w", surfaceId: "s", cursor: nil, tailLines: 1, limit: 1)
        let calls = await facade.calls
        XCTAssertEqual(calls, 2)
    }
}

final class RemoteSessionBridgeLaneTests: XCTestCase {
    func testAHelloSecondsAfterTheSessionOpensIsAccepted() async throws {
        let manager = SessionManager(reader: StaticTextReader(), defaultFps: 15, idleFps: 5)
        let bridge = RemoteSessionBridge(sessionManager: manager, cmux: NoOpCMUXFacade()) { _ in }
        await bridge.receive(.open(sessionId: "slow", deviceId: "device"))
        try await Task.sleep(nanoseconds: 300_000_000)
        await bridge.receive(.text(sessionId: "slow", text: #"{"deviceId":"device","appVersion":"1","protocolVersion":1}"#))
        let attached = await manager.activeSessionCount
        XCTAssertEqual(attached, 1, "the old 100 ms deadline dropped broker sessions behind an extra hop")
        await bridge.disconnectAll()
    }

    func testABrokerSessionsKeystrokeDoesNotWaitForItsRead() async throws {
        let manager = SessionManager(reader: StaticTextReader(), defaultFps: 15, idleFps: 5)
        let cmux = BlockingReadFacade()
        let sent = SentTexts()
        let bridge = RemoteSessionBridge(sessionManager: manager, cmux: cmux) { envelope in
            if let text = envelope.text { await sent.add(text) }
        }
        await bridge.receive(.open(sessionId: "s1", deviceId: "device"))
        await bridge.receive(.text(sessionId: "s1", text: #"{"deviceId":"device","appVersion":"1","protocolVersion":1}"#))
        await bridge.receive(.text(sessionId: "s1", text: #"{"id":"read","method":"surface.read_text","params":{"surface_id":"x"}}"#))
        await bridge.receive(.text(sessionId: "s1", text: #"{"id":"key","method":"surface.send_key","params":{"surface_id":"x","key":"enter"}}"#))
        let early = await sent.waitFor(count: 1)
        XCTAssertEqual(early.count, 1)
        XCTAssertTrue(early.first?.contains(#""id":"key""#) == true, "\(early)")
        await cmux.release()
        let all = await sent.waitFor(count: 2)
        XCTAssertTrue(all.last?.contains(#""id":"read""#) == true, "\(all)")
        await bridge.disconnectAll()
    }
}

// MARK: - Test doubles

/// Text is the last `lines` rows; the grid colors the last three rows red.
private final class FakeScreenSource: CmuxScreenSource, @unchecked Sendable {
    private let lock = NSLock()
    private var current: [String]
    private var grids = 0

    init(rows: [String]) { current = rows }

    var rows: [String] {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
    var gridReads: Int { lock.withLock { grids } }

    private var gridHook: (@Sendable (String) async -> Void)?
    /// Runs inside each grid read, before it returns.
    var onGrid: (@Sendable (String) async -> Void)? {
        get { lock.withLock { gridHook } }
        set { lock.withLock { gridHook = newValue } }
    }

    func readText(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        let rows = Array(self.rows.suffix(lines))
        return Screen(rev: 0, rows: rows, cols: rows.map(\.count).max() ?? 0, cursor: CursorPos(x: 0, y: 0))
    }

    func renderGrid(workspaceId: String, surfaceId: String) async throws -> CMUXRenderGrid {
        let visible = Array(rows.suffix(3))
        lock.withLock { grids += 1 }
        await onGrid?(surfaceId)
        let spans = visible.enumerated().map { CMUXRenderGrid.Span(row: $0.offset, column: 0, styleID: 1, text: $0.element, cellWidth: $0.element.count) }
        return CMUXRenderGrid(columns: 40, rows: visible.count, cursor: nil,
                              styles: [.init(id: 1, foregroundSource: "palette", foregroundPaletteIndex: 1)],
                              rowSpans: spans)
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var time = Date(timeIntervalSinceReferenceDate: 1_000)
    var now: Date { lock.withLock { time } }
    func advance(_ seconds: TimeInterval) { lock.withLock { time = time.addingTimeInterval(seconds) } }
}

private actor SlowHistoryFacade: CMUXFacade {
    private let rows: [String]
    private var failFirst: Bool
    private var released = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private(set) var calls = 0

    init(rows: [String], failFirst: Bool = false) {
        self.rows = rows
        self.failFirst = failFirst
    }

    func release() {
        released = true
        waiting.forEach { $0.resume() }
        waiting.removeAll()
    }

    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        calls += 1
        if !released { await withCheckedContinuation { waiting.append($0) } }
        if failFirst {
            failFirst = false
            throw ThrowingCMUXFacade.Boom()
        }
        return .object(["text": .string(rows.joined(separator: "\n"))])
    }
}

private struct StaticTextReader: SurfaceReader {
    func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
        Screen(rev: 0, rows: [" "], cols: 1, cursor: CursorPos(x: 0, y: 0))
    }
}

private actor BlockingReadFacade: CMUXFacade {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var released = false

    func release() {
        released = true
        waiting.forEach { $0.resume() }
        waiting.removeAll()
    }

    func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        if method == "surface.read_text", !released { await withCheckedContinuation { waiting.append($0) } }
        return .object([:])
    }
}

private actor SentTexts {
    private var texts: [String] = []
    func add(_ text: String) { texts.append(text) }

    func waitFor(count: Int) async -> [String] {
        for _ in 0..<200 where texts.count < count {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return texts
    }
}
