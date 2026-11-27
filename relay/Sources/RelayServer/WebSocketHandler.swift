import Foundation
import NIOCore
import NIOWebSocket
import RelayCore
import SharedKit
import Logging

// MARK: - CMUX dispatch facade

/// Indirection so the WS handler can be wired against either the real
/// `CMUXClient` (M3.11) or a recording / throwing test double. The facade
/// owns "one round-trip RPC against the cmux daemon" — fan-out for events
/// is handled by EventStream + SessionManager.broadcastToAll.
public protocol CMUXFacade: Sendable {
    func dispatch(method: String, params: JSONValue) async throws -> JSONValue
}

// MARK: - Pure protocol machine

/// Pure WS protocol logic — Hello detection + RPC dispatch — separated
/// from the NIO channel so it can be unit-tested without an event loop.
/// The handler below applies the actions back onto the channel.
///
/// Plan task 10's tests used `EmbeddedChannel`, but the channel-bound
/// pattern hits the same `Task` drain deadlock we resolved for the
/// CMUXClient baseline tests. Splitting protocol-from-pipeline keeps
/// the unit suite fast and deterministic; the NIO glue is exercised
/// in M3.11's HTTPServer fixture and the M3.13 live smoke.
public actor WSProtocolMachine {
    public enum Action: Equatable, Sendable {
        case sendText(String)
        case close
        case attachSession(deviceId: String)
        case subscribe(responseId: String, workspaceId: String, surfaceId: String, lines: Int)
        case unsubscribe(responseId: String, surfaceId: String)
        case history(responseId: String, workspaceId: String, surfaceId: String, cursor: String?, tailLines: Int, limit: Int)
    }

    /// How long a new connection may take to send its hello. It was 100 ms,
    /// which dropped the local gateway's cmux source whenever the gateway was
    /// briefly busy, and broker sessions whose hello crosses an extra hop.
    /// The Node gateway already waits 5 s (37d25ac).
    public static let helloTimeoutMilliseconds: Int64 = 5_000

    /// Requests after which the terminal's screen should be read again soon.
    static let inputMethods: Set<String> = [
        "terminal.scroll", "surface.send_key", "surface.send_text", "surface.input",
        "terminal.paste", "terminal.input", "terminal.mouse", "terminal.paste_image",
    ]

    private let cmux: CMUXFacade
    private var helloed = false

    public init(cmux: CMUXFacade) { self.cmux = cmux }

    public var hasHelloed: Bool { helloed }

    /// Drive the machine with one inbound text frame. Returns the actions
    /// the handler should apply to the channel (in order).
    public func processText(_ text: String,
                            noteUserInput: (@Sendable (String) async -> Void)? = nil) async -> [Action] {
        let data = Data(text.utf8)
        if !helloed {
            guard let hello = try? JSONDecoder().decode(HelloFrame.self, from: data) else {
                return [.close]
            }
            helloed = true
            return [.attachSession(deviceId: hello.deviceId)]
        }

        guard let req = try? JSONDecoder().decode(RPCRequest.self, from: data) else {
            return []
        }
        return await Self.handle(req, cmux: cmux, noteUserInput: noteUserInput)
    }

    /// Answers one request that arrived after the hello. Static, so it runs
    /// off the machine's actor: requests on different lanes of a connection
    /// (and an upload chunk's decoding and disk write) proceed side by side.
    public static func handle(_ req: RPCRequest,
                              cmux: CMUXFacade,
                              noteUserInput: (@Sendable (String) async -> Void)? = nil) async -> [Action] {
        if let immediate = relayOwnedResponse(for: req) {
            return [.sendText(immediate)]
        }
        if let relayAction = relayOwnedAction(for: req) {
            return [relayAction]
        }

        if inputMethods.contains(req.method),
           case .object(let params) = req.params,
           case .string(let surfaceId)? = params["surface_id"] {
            await noteUserInput?(surfaceId)
        }

        if req.method == "surface.input" {
            return [.sendText(encode(await input(req, cmux: cmux)))]
        }

        let call = cmuxCall(for: req)
        do {
            let result = try await cmux.dispatch(method: call.method, params: call.params)
            let resp = RPCResponse(id: req.id, ok: true, result: result, error: nil)
            return [.sendText(encode(resp))]
        } catch {
            let err = RPCError(code: "internal_error",
                               message: String(describing: error))
            let resp = RPCResponse(id: req.id, ok: false, result: nil, error: err)
            return [.sendText(encode(resp))]
        }
    }

    /// `surface.send_key` with a name cmux does not know (`pgup`, `f5`,
    /// `shift-home`, …) becomes the cmux name, or the key's bytes as text.
    static func cmuxCall(for req: RPCRequest) -> (method: String, params: JSONValue) {
        guard req.method == "surface.send_key",
              case .object(var params) = req.params,
              case .string(let key)? = params["key"]
        else { return (req.method, req.params) }
        switch CmuxKeyNames.translate(key) {
        case .key(let name):
            guard name != key else { return (req.method, req.params) }
            params["key"] = .string(name)
            return ("surface.send_key", .object(params))
        case .text(let text):
            params["key"] = nil
            params["text"] = .string(text)
            return ("surface.send_text", .object(params))
        }
    }

    /// Everything typed while the previous request was in flight, sent to
    /// the named terminal in order: one network round trip instead of one
    /// per key. A failure reports how many items already arrived.
    private static func input(_ req: RPCRequest, cmux: CMUXFacade) async -> RPCResponse {
        guard case .object(let params) = req.params,
              case .string(let workspaceId)? = params["workspace_id"],
              case .string(let surfaceId)? = params["surface_id"],
              case .array(let items)? = params["items"],
              let parsed = Self.inputItems(items) else {
            return Self.errorResponse(id: req.id, code: "invalid_params", message: "surface.input requires a terminal and 1–512 items")
        }
        var sent: Int64 = 0
        for item in parsed {
            var call: [String: JSONValue] = ["workspace_id": .string(workspaceId), "surface_id": .string(surfaceId)]
            let method: String
            switch item {
            case .text(let text):
                method = "surface.send_text"; call["text"] = .string(text)
            case .key(let key):
                switch CmuxKeyNames.translate(key) {
                case .key(let name): method = "surface.send_key"; call["key"] = .string(name)
                case .text(let text): method = "surface.send_text"; call["text"] = .string(text)
                }
            }
            do {
                _ = try await cmux.dispatch(method: method, params: .object(call))
            } catch {
                return RPCResponse(id: req.id, ok: false, result: nil,
                                   error: RPCError(code: "internal_error", message: String(describing: error), data: .object(["sent": .int(sent)])))
            }
            sent += 1
        }
        return RPCResponse(id: req.id, ok: true, result: .object(["sent": .int(sent)]), error: nil)
    }

    enum InputItem: Equatable { case text(String), key(String) }

    static func inputItems(_ items: [JSONValue]) -> [InputItem]? {
        guard !items.isEmpty, items.count <= 512 else { return nil }
        var size = 0
        var parsed: [InputItem] = []
        for item in items {
            guard case .object(let fields) = item else { return nil }
            switch (fields["text"], fields["key"]) {
            case (.string(let text)?, nil) where !text.isEmpty:
                size += text.utf16.count
                guard size <= 256 * 1024 else { return nil }
                parsed.append(.text(text))
            case (nil, .string(let key)?) where (1...48).contains(key.count) && key.unicodeScalars.allSatisfy({ (0x20...0x7E).contains($0.value) }):
                parsed.append(.key(key))
            default:
                return nil
            }
        }
        return parsed
    }

    /// The hello timer fired. Returns `[.close]` if the peer never sent a
    /// hello, `[]` otherwise (handler will see nil and no-op).
    public func helloMissed() -> [Action] {
        helloed ? [] : [.close]
    }


    /// What this relay accepts, so a client can size uploads without guessing.
    /// Older relays forward the unknown method to cmux, which fails it; clients
    /// then fall back to the 1 MiB-safe sizes.
    static var relayInfo: JSONValue {
        .object([
            "max_message_bytes": .int(Int64(HTTPServer.maxWebSocketFrameBytes)),
            "max_upload_bytes": .int(Int64(RelayFileUploadService.maxBytes)),
            // Chunked `file.upload` calls have no total size limit.
            "upload_chunk_bytes": .int(Int64(RelayFileUploadService.chunkBytes)),
        ])
    }

    private static func relayOwnedResponse(for req: RPCRequest) -> String? {
        switch req.method {
        case "relay.info":
            return encode(RPCResponse(id: req.id, ok: true, result: relayInfo, error: nil))
        case "host.battery":
            return encode(RPCResponse(id: req.id, ok: true, result: HostBatteryService.snapshot().json, error: nil))
        case "file.upload":
            do {
                let uploaded = try RelayFileUploadService.receive(params: req.params)
                return encode(RPCResponse(id: req.id, ok: true, result: uploaded, error: nil))
            } catch {
                return encode(errorResponse(id: req.id, code: "upload_failed", message: String(describing: error)))
            }
        default:
            return nil
        }
    }

    private static func relayOwnedAction(for req: RPCRequest) -> Action? {
        guard case .object(let params) = req.params else { return nil }
        switch req.method {
        case "surface.subscribe":
            guard case .string(let workspaceId)? = params["workspace_id"],
                  case .string(let surfaceId)? = params["surface_id"]
            else {
                return .sendText(Self.encode(errorResponse(id: req.id, code: "invalid_params",
                                                           message: "surface.subscribe requires workspace_id and surface_id")))
            }
            let lines: Int
            if case .int(let value)? = params["lines"] { lines = max(1, Int(value)) }
            else { lines = 200 }
            return .subscribe(responseId: req.id, workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
        case "surface.unsubscribe":
            guard case .string(let surfaceId)? = params["surface_id"] else {
                return .sendText(Self.encode(errorResponse(id: req.id, code: "invalid_params",
                                                           message: "surface.unsubscribe requires surface_id")))
            }
            return .unsubscribe(responseId: req.id, surfaceId: surfaceId)
        case "surface.history":
            guard case .string(let workspaceId)? = params["workspace_id"],
                  case .string(let surfaceId)? = params["surface_id"]
            else {
                return .sendText(Self.encode(errorResponse(id: req.id, code: "invalid_params",
                                                           message: "surface.history requires workspace_id and surface_id")))
            }
            let cursor: String?
            if case .string(let value)? = params["cursor"], !value.isEmpty {
                cursor = value
            } else {
                cursor = nil
            }
            let tailLines: Int
            if case .int(let value)? = params["tail_lines"] {
                tailLines = min(max(1, Int(value)), 2_000)
            } else {
                tailLines = 120
            }
            let limit: Int
            if case .int(let value)? = params["limit"] {
                limit = min(max(1, Int(value)), SurfaceHistoryService.maximumPageLines)
            } else {
                limit = 200
            }
            return .history(
                responseId: req.id,
                workspaceId: workspaceId,
                surfaceId: surfaceId,
                cursor: cursor,
                tailLines: tailLines,
                limit: limit
            )
        default:
            return nil
        }
    }

    private static func okResponse(id: String) -> RPCResponse {
        RPCResponse(id: id, ok: true, result: .object([:]), error: nil)
    }

    private static func errorResponse(id: String, code: String, message: String) -> RPCResponse {
        RPCResponse(id: id, ok: false, result: nil, error: RPCError(code: code, message: message))
    }

    public static func encodeForHandler(_ resp: RPCResponse) -> String {
        encode(resp)
    }

    private static func encode(_ resp: RPCResponse) -> String {
        guard let data = try? JSONEncoder().encode(resp),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}

// MARK: - NIO channel handler

private final class WSChannelContext: @unchecked Sendable {
    private let context: ChannelHandlerContext

    init(_ context: ChannelHandlerContext) {
        self.context = context
    }

    func execute(_ operation: @escaping @Sendable (ChannelHandlerContext) -> Void) {
        context.eventLoop.execute { operation(self.context) }
    }
}

/// The connection's attached `Session`, shared by the event loop and the
/// lanes' tasks.
private final class WSSessionSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var session: Session?
    private var closed = false

    var current: Session? { lock.withLock { session } }

    /// False when the channel closed first: the caller detaches `session`.
    func attach(_ session: Session) -> Bool {
        lock.withLock {
            guard !closed else { return false }
            self.session = session
            return true
        }
    }

    /// Marks the channel closed and hands back the session to detach.
    func close() -> Session? {
        lock.withLock {
            closed = true
            defer { session = nil }
            return session
        }
    }
}

/// Thin NIO `ChannelInboundHandler` that drives `WSProtocolMachine` and
/// applies its actions on the channel's event loop. The hello deadline is an
/// `eventLoop.scheduleTask`; on hello the machine emits an `attachSession`
/// action that we map to `SessionManager.attach`, installing a `sendFrame`
/// closure that hops back onto the loop to write the WS text frame.
///
/// Frames are taken in arrival order by `intake`, which handles the hello
/// and then only decodes each request and hands it to its lane
/// (`WSRequestLane`): writes in order, never behind reads.
///
/// `@unchecked Sendable`: the hello timer state is touched only on the event loop;
/// the attached session lives in a locked `WSSessionSlot`.
public final class WebSocketHandler: ChannelInboundHandler, @unchecked Sendable {
    public typealias InboundIn = WebSocketFrame
    public typealias OutboundOut = WebSocketFrame

    public let deviceId: String
    private let deviceStore: DeviceStore
    private let sessionManager: SessionManager
    private let machine: WSProtocolMachine
    private let cmux: CMUXFacade
    private let history: SurfaceHistoryService
    private let helloTimeout: TimeAmount
    private let intake = SerialTaskQueue()
    private let lanes = RequestLanes()
    private let slot = WSSessionSlot()
    private let logger = Logger(label: "cmux-relay.ws")

    private var helloTimer: Scheduled<Void>?
    private var helloDeadlineArmed = false

    public init(deviceId: String,
                deviceStore: DeviceStore,
                sessionManager: SessionManager,
                cmuxClient: CMUXFacade,
                history: SurfaceHistoryService,
                helloTimeout: TimeAmount = .milliseconds(WSProtocolMachine.helloTimeoutMilliseconds))
    {
        self.deviceId = deviceId
        self.deviceStore = deviceStore
        self.sessionManager = sessionManager
        self.machine = WSProtocolMachine(cmux: cmuxClient)
        self.cmux = cmuxClient
        self.history = history
        self.helloTimeout = helloTimeout
    }

    /// The upgrader installs this handler on a channel that is already
    /// active, so `channelActive` never reaches it there; arm the hello
    /// deadline here instead.
    public func handlerAdded(context: ChannelHandlerContext) {
        if context.channel.isActive { armHelloDeadline(context) }
    }

    public func channelActive(context: ChannelHandlerContext) {
        armHelloDeadline(context)
        context.fireChannelActive()
    }

    private func armHelloDeadline(_ context: ChannelHandlerContext) {
        guard !helloDeadlineArmed else { return }
        helloDeadlineArmed = true
        let machine = self.machine
        let channel = WSChannelContext(context)
        helloTimer = context.eventLoop.scheduleTask(in: helloTimeout) { [weak self] in
            guard let self else { return }
            Task {
                let actions = await machine.helloMissed()
                channel.execute { self.apply(actions: actions, on: $0) }
            }
        }
    }

    public func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let frame = unwrapInboundIn(data)
        guard frame.opcode == .text else { return }
        let buf = frame.unmaskedData
        guard let text = buf.getString(at: buf.readerIndex,
                                       length: buf.readableBytes) else { return }

        let channel = WSChannelContext(context)
        intake.enqueue { [weak self] in
            await self?.receive(text, on: channel)
        }
    }

    public func channelInactive(context: ChannelHandlerContext) {
        helloTimer?.cancel()
        helloTimer = nil
        if let s = slot.close() {
            let mgr = sessionManager
            Task { await mgr.detach(session: s) }
        }
        context.fireChannelInactive()
    }

    /// Runs in `intake`, one frame at a time: the hello (attaching the
    /// session before any later frame is routed), then each request's lane.
    private func receive(_ text: String, on channel: WSChannelContext) async {
        if await !machine.hasHelloed {
            let actions = await machine.processText(text)
            await apply(actions: actions, on: channel)
            return
        }
        guard let request = try? JSONDecoder().decode(RPCRequest.self, from: Data(text.utf8)) else { return }
        let cmux = self.cmux
        let manager = sessionManager
        lanes.enqueue(WSRequestLane.of(method: request.method)) { [weak self] in
            let actions = await WSProtocolMachine.handle(request, cmux: cmux) { surfaceId in
                await manager.noteUserInput(surfaceId: surfaceId)
            }
            await self?.apply(actions: actions, on: channel)
        }
    }

    /// Async-side action applier — used after `processText`. Dispatches
    /// each action; for `attachSession`, the heavy work (calling
    /// SessionManager) happens on the actor, then the resulting Session
    /// is stored in the slot.
    private func apply(actions: [WSProtocolMachine.Action],
                       on channel: WSChannelContext) async
    {
        for action in actions {
            switch action {
            case .sendText(let text):
                channel.execute { self.writeText(text, on: $0) }
            case .close:
                channel.execute { $0.close(promise: nil) }
            case .attachSession:
                channel.execute { _ in
                    self.helloTimer?.cancel()
                    self.helloTimer = nil
                }
                let s = await sessionManager.attach(deviceId: deviceId) { [weak self] frame in
                    guard let self else { return }
                    channel.execute { self.writePushFrame(frame, on: $0) }
                }
                if !slot.attach(s) {
                    // The peer left while the session was being attached.
                    await sessionManager.detach(session: s)
                }
            case .subscribe(let responseId, let workspaceId, let surfaceId, let lines):
                guard let session = slot.current else {
                    let text = WSProtocolMachine.encodeForHandler(.init(
                        id: responseId, ok: false, result: nil,
                        error: RPCError(code: "session_not_attached", message: "hello required before subscribe")
                    ))
                    channel.execute { self.writeText(text, on: $0) }
                    continue
                }
                // Scrollback is read when the first `surface.history` page is
                // asked for, not on every subscribe (see SurfaceHistoryService).
                await session.subscribe(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
                let text = WSProtocolMachine.encodeForHandler(.init(id: responseId, ok: true, result: .object([:])))
                channel.execute { self.writeText(text, on: $0) }
            case .unsubscribe(let responseId, let surfaceId):
                guard let session = slot.current else {
                    let text = WSProtocolMachine.encodeForHandler(.init(
                        id: responseId, ok: false, result: nil,
                        error: RPCError(code: "session_not_attached", message: "hello required before unsubscribe")
                    ))
                    channel.execute { self.writeText(text, on: $0) }
                    continue
                }
                await session.unsubscribe(surfaceId: surfaceId)
                let text = WSProtocolMachine.encodeForHandler(.init(id: responseId, ok: true, result: .object([:])))
                channel.execute { self.writeText(text, on: $0) }
            case .history(let responseId, let workspaceId, let surfaceId, let cursor, let tailLines, let limit):
                do {
                    let result = try await history.page(
                        workspaceId: workspaceId,
                        surfaceId: surfaceId,
                        cursor: cursor,
                        tailLines: tailLines,
                        limit: limit
                    )
                    let text = WSProtocolMachine.encodeForHandler(.init(id: responseId, ok: true, result: result))
                    channel.execute { self.writeText(text, on: $0) }
                } catch {
                    let text = WSProtocolMachine.encodeForHandler(.init(
                        id: responseId,
                        ok: false,
                        result: nil,
                        error: RPCError(code: "history_unavailable", message: String(describing: error))
                    ))
                    channel.execute { self.writeText(text, on: $0) }
                }
            }
        }
    }

    /// Sync-side action applier — used from inside an `eventLoop.execute`
    /// callback (e.g. the hello-missed timer). Only handles actions that
    /// don't need async work.
    private func apply(actions: [WSProtocolMachine.Action],
                       on context: ChannelHandlerContext)
    {
        for action in actions {
            switch action {
            case .sendText(let text): writeText(text, on: context)
            case .close:              context.close(promise: nil)
            case .attachSession:      break
            case .subscribe, .unsubscribe, .history: break
            }
        }
    }

    private func writeText(_ text: String, on context: ChannelHandlerContext) {
        var buf = context.channel.allocator.buffer(capacity: text.utf8.count)
        buf.writeString(text)
        let frame = WebSocketFrame(fin: true, opcode: .text, data: buf)
        context.writeAndFlush(wrapOutboundOut(frame), promise: nil)
    }

    private func writePushFrame(_ push: PushFrame, on context: ChannelHandlerContext) {
        guard let body = try? JSONEncoder().encode(push),
              let s = String(data: body, encoding: .utf8) else { return }
        writeText(s, on: context)
    }
}
