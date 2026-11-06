import Foundation
import RelayCore
import SharedKit

/// A bounded durable journal. The live frame is published only after its
/// sequence has reached disk; replay and live delivery carry the same identity.
public actor InboxJournal {
    private struct Entry: Codable { var seq: Int; var event: EventFrame }
    private struct State: Codable { var epoch: String; var sequence: Int; var events: [Entry] }
    private let url: URL
    private let limit: Int
    private var state: State
    public init(url: URL, limit: Int = 2000) {
        self.url = url; self.limit = max(1, limit)
        if let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode(State.self, from: data) {
            self.state = .init(epoch: decoded.epoch, sequence: decoded.sequence, events: Array(decoded.events.suffix(max(1, limit))))
        } else { self.state = .init(epoch: UUID().uuidString, sequence: 0, events: []) }
    }
    public func append(_ frame: EventFrame) throws -> EventFrame? {
        guard case .object(let p) = frame.payload else { return nil }
        let resolution = Self.isResolution(frame)
        guard InboxNotification.isInboxEvent(frame) || resolution else { return nil }
        let seq = state.sequence + 1, cursor = "\(state.epoch):\(seq)"
        let fields = Set(["id", "notification_id", "workspace_id", "surface_id", "title", "subtitle", "body", "message", "source", "source_id", "thread_id", "threadId", "task_id", "taskId", "request_id", "requestId", "turn_id", "turnId", "status", "state", "needs_input", "resolved", "resolves_notification_id", "ts"])
        var payload = p.filter { fields.contains($0.key) }
        if case .object(let turn)? = p["turn"], let id = turn["id"] { payload["turn_id"] = id }
        if let signal = NotificationSignal.from(frame) {
            // Keep failures distinct when a turn/completed callback reports an error.
            if signal == .completed { payload["status"] = .string("completed") }
            else if frame.name == "turn/completed" { payload["status"] = .string("failed") }
            else { payload["status"] = .string("needs input") }
            payload["needs_input"] = .bool(signal == .attention)
            if payload["id"] == nil, let id = NotificationSignal.lifecycleId(frame) { payload["id"] = .string(id) }
        }
        for (key, value) in payload { if case .string(let text) = value { payload[key] = .string(String(text.prefix(["body", "message"].contains(key) ? 2000 : 300))) } }
        payload["panecast_event_id"] = .string(cursor); payload["panecast_cursor"] = .string(cursor)
        if resolution { payload["resolved"] = .bool(true) }
        if payload["id"] == nil && payload["notification_id"] == nil && !resolution { payload["notification_id"] = .string("event:\(cursor)") }
        let event = EventFrame(category: frame.category, name: frame.name, payload: .object(payload))
        let next = State(epoch: state.epoch, sequence: seq, events: Array((state.events + [Entry(seq: seq, event: event)]).suffix(limit)))
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        state = next; return event
    }
    public func page(params: JSONValue) throws -> JSONValue {
        let p: [String: JSONValue]; if case .object(let object) = params { p = object } else { p = [:] }
        func cursor(_ key: String) -> Int? {
            guard case .string(let value)? = p[key], let split = value.lastIndex(of: ":"), String(value[..<split]) == state.epoch,
                  let seq = Int(value[value.index(after: split)...]), seq >= 0, seq <= state.sequence else { return nil }
            return seq
        }
        let oldest = state.events.first?.seq ?? state.sequence + 1, parsed = cursor("cursor")
        let reset = p["cursor"] != nil && (parsed == nil || parsed! < oldest - 1)
        let start = reset ? oldest - 1 : parsed ?? oldest - 1, head = cursor("until_cursor") ?? state.sequence
        let count: Int; if case .int(let n)? = p["limit"] { count = Int(min(200, max(1, n))) } else { count = 100 }
        let events = Array(state.events.filter { $0.seq > start && $0.seq <= head }.prefix(count))
        let end = events.last?.seq ?? max(start, head)
        let encoded = try events.map { entry -> JSONValue in
            let data = try JSONEncoder().encode(PushFrame.event(entry.event)); return try JSONDecoder().decode(JSONValue.self, from: data)
        }
        return .object(["events": .array(encoded), "next_cursor": .string("\(state.epoch):\(end)"), "head_cursor": .string("\(state.epoch):\(head)"), "has_more": .bool(end < head), "reset": .bool(reset), "retained_events": .int(Int64(limit))])
    }
    public static func isResolution(_ event: EventFrame) -> Bool {
        if event.name.range(of: #"^(item[./]|tool[./]|message[./])|[./](delta|progress|started|updated)$|^notification\.(?!created$|resolved$)"#, options: .regularExpression) != nil { return false }
        guard case .object(let p) = event.payload else { return false }
        let names = ["notification.resolved", "task.completed", "task.failed", "task.cancelled", "agent.completed", "turn/completed", "serverRequest/resolved"]
        let states = ["completed", "complete", "resolved", "failed", "cancelled", "canceled", "interrupted", "done", "succeeded", "success"]
        let turn: [String: JSONValue]; if case .object(let value)? = p["turn"] { turn = value } else { turn = [:] }
        let state: JSONValue?; if case .object(let value)? = p["status"] { state = value["type"] } else { state = p["status"] ?? p["state"] ?? turn["status"] }
        let status: String; if case .string(let text) = state { status = text.lowercased() } else { status = "" }
        let identified = turn["id"] != nil || (event.name == "notification.resolved" && p["id"] != nil) || ["notification_id", "resolves_notification_id", "task_id", "taskId", "request_id", "requestId", "turn_id", "turnId"].contains { p[$0] != nil }
        return identified && (names.contains(event.name) || states.contains(status) || p["resolved"] == .bool(true))
    }
}
