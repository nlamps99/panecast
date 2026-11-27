import XCTest
import SharedKit
@testable import RelayCore

final class PollScheduleTests: XCTestCase {
    private struct BlankReader: SurfaceReader {
        func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
            Screen(rev: 0, rows: ["a"], cols: 1, cursor: .init(x: 0, y: 0))
        }
    }

    private func engine(_ clock: FakeClock, fps: Int = 15, idleFps: Int = 5, reader: SurfaceReader = BlankReader()) -> DiffEngine {
        DiffEngine(reader: reader, fps: fps, idleFps: idleFps, workspaceId: "w", surfaceId: "s", lines: 1, clock: clock)
    }

    func testTheFirstReadIsImmediateThenTheRegularRate() async throws {
        let clock = FakeClock()
        let engine = engine(clock)
        let first = await engine.nextTickDelay()
        XCTAssertEqual(first, 0, "a new subscriber gets its screen at once")
        try await engine.tick()
        let next = await engine.nextTickDelay()
        XCTAssertEqual(next, 1.0 / 15, accuracy: 1e-9)
    }

    func testInputSchedulesABurstOfReadsInsteadOfWaitingOutTheIdleInterval() async throws {
        let clock = FakeClock()
        let engine = engine(clock, fps: 15, idleFps: 2)
        try await engine.tick()
        clock.advance(by: 3)
        try await engine.tick()
        let idle = await engine.nextTickDelay()
        XCTAssertEqual(idle, 0.5, accuracy: 1e-9, "a quiet screen is read twice a second")

        clock.advance(by: 0.1)
        await engine.noteUserInput()
        var delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 0.016, accuracy: 1e-9, "the echo is read 16 ms after the keystroke")

        clock.advance(by: delay)
        try await engine.tick()
        delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 0.05 - 0.016, accuracy: 1e-9)

        clock.advance(by: delay)
        try await engine.tick()
        delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 1.0 / 15, accuracy: 1e-9, "the active rate comes before the 120 ms burst read")

        clock.advance(by: 0.07)
        try await engine.tick()
        delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 1.0 / 15, accuracy: 1e-9, "after the burst, the active rate")
    }

    func testSteadyTypingCannotStarveReads() async throws {
        let clock = FakeClock()
        let engine = engine(clock, fps: 10, idleFps: 2)
        try await engine.tick()
        // A key every 10 ms keeps pushing the burst back; the regular rate
        // still bounds the wait.
        for _ in 0..<20 {
            clock.advance(by: 0.01)
            await engine.noteUserInput()
        }
        let delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 0, accuracy: 1e-9, "two intervals since the last read: read now")
    }

    func testAClockSteppingBackwardDoesNotStallReadsOrChecksums() async throws {
        let clock = FakeClock()
        let engine = engine(clock, fps: 15, idleFps: 5)
        let checksums = Counter()
        await engine.setOnChecksum { _, _ in checksums.add() }
        clock.advance(by: 100)
        try await engine.tick()
        XCTAssertEqual(checksums.value, 1)

        clock.advance(by: -50)
        var delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 1.0 / 15, accuracy: 1e-9, "not the 50 s until the old time comes round again")
        await engine.noteUserInput()
        delay = await engine.nextTickDelay()
        XCTAssertEqual(delay, 0.016, accuracy: 1e-9, "typing still gets its burst")

        clock.advance(by: 0.016)
        try await engine.tick()
        clock.advance(by: 5.1)
        try await engine.tick()
        XCTAssertEqual(checksums.value, 2, "checksums resume 5 s after the step, not 55 s")
    }

    func testNoDelayExceedsTheIdleInterval() async throws {
        let clock = FakeClock()
        let engine = engine(clock, fps: 15, idleFps: 4)
        clock.advance(by: 10)
        try await engine.tick()
        clock.advance(by: -9.9)
        // Whatever happened to the times, the wait is bounded.
        let delay = await engine.nextTickDelay()
        XCTAssertLessThanOrEqual(delay, 0.25)
    }

    func testTheDefaultClockNeverStepsBackward() async throws {
        let clock = MonotonicClock()
        var previous = clock.now
        for _ in 0..<5 {
            try await Task.sleep(nanoseconds: 1_000_000)
            let next = clock.now
            XCTAssertGreaterThanOrEqual(next, previous)
            previous = next
        }
        XCTAssertLessThan(clock.now, Date().timeIntervalSince1970, "seconds since boot, not wall time")
    }

    func testWaitForNextTickReturnsSoonAfterInputOnAnIdleScreen() async throws {
        let engine = DiffEngine(reader: BlankReader(), fps: 1, idleFps: 1, workspaceId: "w", surfaceId: "s", lines: 1)
        try await engine.tick()
        let started = Date()
        async let waited: Void = engine.waitForNextTick()
        try await Task.sleep(nanoseconds: 50_000_000)
        await engine.noteUserInput()
        await waited
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 0.5, "input cuts the one-second wait short")
        XCTAssertGreaterThanOrEqual(elapsed, 0.06, "and waits for the 16 ms echo read rather than reading before the input lands")
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

final class PollWakerTests: XCTestCase {
    func testWakeBeforeSleepEndsTheNextSleepAtOnce() async {
        let waker = PollWaker()
        waker.wake()
        let woken = await waker.sleep(seconds: 5)
        XCTAssertTrue(woken)
    }

    func testWakeDuringSleep() async throws {
        let waker = PollWaker()
        let started = Date()
        async let woken = waker.sleep(seconds: 5)
        try await Task.sleep(nanoseconds: 20_000_000)
        waker.wake()
        let result = await woken
        XCTAssertTrue(result)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testTimeRunsOut() async {
        let waker = PollWaker()
        let woken = await waker.sleep(seconds: 0.01)
        XCTAssertFalse(woken)
    }

    func testCancellingTheSleeperEndsItPromptly() async throws {
        let waker = PollWaker()
        let started = Date()
        let task = Task { await waker.sleep(seconds: 5) }
        try await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        let woken = await task.value
        XCTAssertFalse(woken)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }
}

final class SessionWakeTests: XCTestCase {
    private final class CountingReader: SurfaceReader, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private var noted = 0
        var reads: Int { lock.withLock { count } }
        var inputs: Int { lock.withLock { noted } }
        func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
            lock.withLock { count += 1 }
            return Screen(rev: 0, rows: ["a"], cols: 1, cursor: .init(x: 0, y: 0))
        }
        func noteInput(surfaceId: String) { lock.withLock { noted += 1 } }
    }

    func testInputTriggersReadsWithinMillisecondsAtAnIdleRate() async throws {
        let reader = CountingReader()
        let session = Session(deviceId: "d", reader: reader, defaultFps: 1, idleFps: 1)
        await session.subscribe(workspaceId: "w", surfaceId: "s", lines: 1)
        for _ in 0..<100 where reader.reads == 0 { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertEqual(reader.reads, 1, "the first read is immediate")

        await session.noteUserInput(surfaceId: "s")
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertGreaterThanOrEqual(reader.reads, 3, "burst reads at 16, 50 and 120 ms, not one second later")
        await session.close()
    }

    private final class ViewerRecordingReader: SurfaceReader, @unchecked Sendable {
        private let lock = NSLock()
        private var log: [String] = []
        var events: [String] { lock.withLock { log } }
        func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen {
            Screen(rev: 0, rows: ["a"], cols: 1, cursor: .init(x: 0, y: 0))
        }
        func viewerStarted(surfaceId: String, lines: Int) { lock.withLock { log.append("+\(surfaceId)/\(lines)") } }
        func viewerStopped(surfaceId: String, lines: Int) { lock.withLock { log.append("-\(surfaceId)/\(lines)") } }
    }

    func testSubscriptionsTellTheReaderWhenTheyStartAndStop() async {
        let reader = ViewerRecordingReader()
        let session = Session(deviceId: "d", reader: reader, defaultFps: 5, idleFps: 1)
        await session.subscribe(workspaceId: "w", surfaceId: "s", lines: 10)
        await session.subscribe(workspaceId: "w", surfaceId: "s", lines: 99)
        await session.subscribe(workspaceId: "w", surfaceId: "t", lines: 40)
        await session.unsubscribe(surfaceId: "s")
        await session.unsubscribe(surfaceId: "s")
        await session.close()
        XCTAssertEqual(reader.events, ["+s/10", "+t/40", "-s/10", "-t/40"])
    }

    func testTheManagerWakesEverySessionShowingTheTerminal() async {
        let reader = CountingReader()
        let manager = SessionManager(reader: reader, defaultFps: 5, idleFps: 1)
        let phone = await manager.attach(deviceId: "phone") { _ in }
        let desktop = await manager.attach(deviceId: "desktop") { _ in }
        let elsewhere = await manager.attach(deviceId: "other") { _ in }
        await phone.subscribe(workspaceId: "w", surfaceId: "s", lines: 10)
        await desktop.subscribe(workspaceId: "w", surfaceId: "s", lines: 40)
        await elsewhere.subscribe(workspaceId: "w", surfaceId: "t", lines: 10)

        await manager.noteUserInput(surfaceId: "s")
        XCTAssertEqual(reader.inputs, 2)
        for session in [phone, desktop, elsewhere] { await manager.detach(session: session) }
    }
}
