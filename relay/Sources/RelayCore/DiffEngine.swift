import Foundation
import SharedKit

public protocol SurfaceReader: Sendable {
    func read(workspaceId: String, surfaceId: String, lines: Int) async throws -> Screen
    /// The user typed into this surface; readers that sample expensive state
    /// (colors, cursor) refresh it on the next read.
    func noteInput(surfaceId: String)
}

extension SurfaceReader {
    public func noteInput(surfaceId: String) {}
}

/// Per-surface diff polling state.
///
/// Actor-isolated so that `noteUserInput()` (called from the WS handler when a
/// device sends input) and `tick()` (called from the NIO event loop's polling
/// timer) cannot race on the mutable state — `lastInput`, `currentFps`,
/// `state`, `rev`, `lastChecksumAt`, and the two callback slots.
public actor DiffEngine {
    public nonisolated let workspaceId: String
    public nonisolated let surfaceId: String
    public nonisolated let lines: Int
    public nonisolated let activeFps: Int
    public nonisolated let idleFps: Int
    public nonisolated let idleAfter: TimeInterval = 1.5
    /// Reads after each input, in seconds after it: the echo usually lands
    /// within the first, a slow program's within the later ones. Between
    /// inputs the engine keeps its ordinary rate.
    public static let inputBurst: [TimeInterval] = [0.016, 0.05, 0.12]

    public private(set) var rev: Int = 0
    public private(set) var currentFps: Int

    /// Woken by `noteUserInput()`; the poll loop sleeps on it between reads.
    public nonisolated let waker = PollWaker()

    private let reader: SurfaceReader
    private let clock: Clock
    private var state = RowState()
    private var lastInput: TimeInterval
    private var burstAnchor: TimeInterval = -.infinity
    private var lastTickStarted: TimeInterval = -.infinity
    private var lastTickEnded: TimeInterval = -.infinity
    private var lastChange: TimeInterval = -.infinity
    private var lastChecksumAt: TimeInterval = 0
    private var onDiff: (@Sendable (Int, [DiffOp]) -> Void)?
    private var onChecksum: (@Sendable (String, Int) -> Void)?

    public init(reader: SurfaceReader,
                fps: Int, idleFps: Int,
                workspaceId: String, surfaceId: String, lines: Int,
                clock: Clock = SystemClock())
    {
        self.reader = reader
        self.activeFps = fps
        self.idleFps = idleFps
        self.currentFps = fps
        self.workspaceId = workspaceId
        self.surfaceId = surfaceId
        self.lines = lines
        self.clock = clock
        self.lastInput = clock.now
    }

    public func setOnDiff(_ handler: (@Sendable (Int, [DiffOp]) -> Void)?) {
        self.onDiff = handler
    }

    public func setOnChecksum(_ handler: (@Sendable (String, Int) -> Void)?) {
        self.onChecksum = handler
    }

    public func noteUserInput() {
        lastInput = clock.now
        burstAnchor = lastInput
        currentFps = activeFps
        reader.noteInput(surfaceId: surfaceId)
        waker.wake()
    }

    /// Seconds until the next read is due: one interval at the current rate
    /// after the last read ended, or sooner when an input burst read is
    /// pending. The first read is due at once.
    public func nextTickDelay() -> TimeInterval {
        let now = clock.now
        let interval = 1.0 / Double(max(1, currentFps))
        var due = lastTickEnded + interval
        // A read that started within 2 ms of a burst point served it.
        if let point = Self.inputBurst.lazy.map({ self.burstAnchor + $0 }).first(where: { $0 > self.lastTickStarted + 0.002 }) {
            due = min(due, point)
            // An overdue read right after the keystroke would only see the
            // screen from before it; wait for the first burst point, unless
            // input keeps arriving for two whole intervals.
            due = max(due, min(burstAnchor + Self.inputBurst[0], lastTickEnded + 2 * interval))
        }
        return max(0, due - now)
    }

    /// Waits until the next read is due. Input during the wait moves it
    /// earlier; cancelling the calling task ends the wait.
    public nonisolated func waitForNextTick() async {
        while !Task.isCancelled {
            let delay = await nextTickDelay()
            guard delay > 0 else { return }
            // Woken by input: the schedule changed, so look again.
            guard await waker.sleep(seconds: delay) else { return }
        }
    }

    /// Run one polling tick. `Session` runs these back to back, waiting
    /// `waitForNextTick()` between them.
    public func tick() async throws {
        lastTickStarted = clock.now
        defer { lastTickEnded = clock.now }
        // Streaming output (an agent writing, a build log) keeps the active
        // rate just like typing does; only a quiet screen slows down.
        if clock.now - max(lastInput, lastChange) > idleAfter { currentFps = idleFps }
        let snapshot = try await reader.read(workspaceId: workspaceId,
                                             surfaceId: surfaceId, lines: lines)
        let ops = state.ingest(snapshot: snapshot)
        if !ops.isEmpty {
            rev &+= 1
            lastChange = clock.now
            currentFps = activeFps
            onDiff?(rev, ops)
        }
        if clock.now - lastChecksumAt >= 5.0 {
            lastChecksumAt = clock.now
            onChecksum?(ScreenHasher.hash(snapshot), rev)
        }
    }
}
