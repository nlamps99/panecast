import Foundation

/// Only requests/problems and task completion belong in the inbox or push fanout.
/// The client and tmux relay share the same cases in notification-signals.json.
public enum NotificationSignal: String, Sendable {
    case attention, completed
    private static let requests = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "tool/requestUserInput", "item/tool/requestUserInput"]

    public static func from(_ event: EventFrame) -> NotificationSignal? {
        guard case .object(let p) = event.payload else { return nil }
        let name = event.name
        if matches(name, #"^notification\.(?!created$)"#) || name == "serverRequest/resolved" { return nil }
        if requests.contains(name) { return .attention }
        if matches(name, #"^(item/|message[./]|tool[./])|[./](delta|progress|started|updated)$"#) { return nil }
        let notification = event.category == .notification || name == "notification.created" || name == "notification"
        let lifecycle = matches(name, #"^(task|turn|agent)[./](completed|failed|error|blocked|status|status_changed|waiting)$"#)
        let inputEvent = matches(name, #"(^|[./])(needs[_-]input|permission_prompt|request_approval)$"#)
        guard notification || lifecycle || inputEvent || event.category == .hook || name == "error" else { return nil }
        let status = normalized(object(p["status"])["type"] ?? p["status"] ?? p["state"] ?? object(p["turn"])["status"])
        if ["cancelled", "canceled", "interrupted", "resolved", "idle", "running", "in progress", "inprogress", "working", "started", "retrying"].contains(status) { return nil }
        if p["willRetry"] == .bool(true) || p["will_retry"] == .bool(true) { return nil }
        if ["failed", "error", "blocked", "needs attention"].contains(status) || matches(name, #"[./](failed|error|blocked)$"#) || name == "error" { return .attention }
        if ["completed", "complete", "done", "succeeded", "success"].contains(status) || matches(name, #"^(task|turn|agent)[./]completed$"#) { return .completed }
        if p["needs_input"] == .bool(true) || inputEvent || ["needs input", "waiting for input", "awaiting input", "approval required", "waiting for approval"].contains(status) { return .attention }
        let title = normalized(p["title"] ?? p["headline"])
        let message = normalized(p["body"] ?? p["message"] ?? object(p["details"])["message"] ?? object(p["details"])["body"])
        let input = #"^(?:(?:codex|claude(?: code)?|openai|agent|cmux)\s+)?(?:needs (?:input|attention|your (?:input|attention|approval))|input needed|waiting for your input|approval required|permission prompt|需要你回应|需要你确认|等待回应|需要审批|等待确认|需要回答|等待回答)[.!。！:：]?$"#
        if matches(title, input) || matches(message, input) { return .attention }
        if notification || event.category == .hook {
            let completed = #"^(?:(?:task|turn|build|tests?|codex|claude(?: code)?)\s+)?(?:completed|complete|done|finished|succeeded|passed)(?:$|[.!:：])|^(?:任务|构建|测试|工作|本轮)(?:已)?完成(?:$|[。！!：:\s])|^测试(?:全部)?通过(?:$|[。！!：:\s])|^작업 완료$"#
            let problem = #"^(?:(?:task|turn|build|tests?|codex|claude(?: code)?)\s+)?(?:failed|error|blocked)(?:$|[.!:：\s])|^(?:任务失败|构建失败|测试失败|任务阻塞|发生错误)(?:$|[。！!：:\s])"#
            if matches(title, problem) { return .attention }
            if matches(title, completed) { return .completed }
        }
        return nil
    }

    public static func lifecycleId(_ event: EventFrame) -> String? {
        guard case .object(let p) = event.payload, let signal = from(event) else { return nil }
        if requests.contains(event.name), case .string(let request) = p["request_id"] ?? p["requestId"], !request.isEmpty {
            return "request:\(string(p["source_id"])):\(request)"
        }
        let identity = p["task_id"] ?? p["taskId"] ?? p["request_id"] ?? p["requestId"] ?? p["turn_id"] ?? p["turnId"] ?? object(p["turn"])["id"]
        guard case .string(let id) = identity, !id.isEmpty else { return nil }
        return "task-event:\(string(p["source_id"])):\(string(p["thread_id"] ?? p["threadId"])):\(id):\(signal.rawValue)"
    }

    private static func object(_ value: JSONValue?) -> [String: JSONValue] {
        if case .object(let p) = value { return p }; return [:]
    }
    private static func string(_ value: JSONValue?) -> String {
        if case .string(let s) = value { return s }; return ""
    }
    private static func normalized(_ value: JSONValue?) -> String {
        string(value).trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
    }
    private static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
}
