import Foundation
import SharedKit

public struct NotificationPreferences: Codable, Sendable, Equatable {
    public struct QuietHours: Codable, Sendable, Equatable {
        public var enabled: Bool
        public var startMinutes: Int
        public var endMinutes: Int
        public var timeZone: String
        enum CodingKeys: String, CodingKey { case enabled, startMinutes = "start_minutes", endMinutes = "end_minutes", timeZone = "time_zone" }
        public init(enabled: Bool = false, startMinutes: Int = 1320, endMinutes: Int = 480, timeZone: String = "UTC") {
            self.enabled = enabled; self.startMinutes = min(1439, max(0, startMinutes)); self.endMinutes = min(1439, max(0, endMinutes))
            self.timeZone = TimeZone(identifier: timeZone) == nil ? "UTC" : timeZone
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(enabled: try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false,
                startMinutes: try c.decodeIfPresent(Int.self, forKey: .startMinutes) ?? 1320,
                endMinutes: try c.decodeIfPresent(Int.self, forKey: .endMinutes) ?? 480,
                timeZone: try c.decodeIfPresent(String.self, forKey: .timeZone) ?? "UTC")
        }
    }
    public var needsInputOnly: Bool
    public var mutedWorkspaces: [String]
    public var quietHours: QuietHours
    public var dedupeSeconds: Int
    enum CodingKeys: String, CodingKey { case needsInputOnly = "needs_input_only", mutedWorkspaces = "muted_workspaces", quietHours = "quiet_hours", dedupeSeconds = "dedupe_seconds" }
    public init(needsInputOnly: Bool = false, mutedWorkspaces: [String] = [], quietHours: QuietHours = .init(), dedupeSeconds: Int = 60) {
        self.needsInputOnly = needsInputOnly; self.mutedWorkspaces = Array(mutedWorkspaces.filter { $0.count <= 300 }.prefix(200))
        self.quietHours = quietHours; self.dedupeSeconds = min(3600, max(0, dedupeSeconds))
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(needsInputOnly: try c.decodeIfPresent(Bool.self, forKey: .needsInputOnly) ?? false,
            mutedWorkspaces: try c.decodeIfPresent([String].self, forKey: .mutedWorkspaces) ?? [],
            quietHours: try c.decodeIfPresent(QuietHours.self, forKey: .quietHours) ?? .init(),
            dedupeSeconds: try c.decodeIfPresent(Int.self, forKey: .dedupeSeconds) ?? 60)
    }
    public func allows(workspaceId: String, needsInput: Bool, at: Date = Date()) -> Bool {
        if mutedWorkspaces.contains(workspaceId) || (needsInputOnly && !needsInput) { return false }
        let q = quietHours
        guard q.enabled else { return true }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: q.timeZone) ?? TimeZone(secondsFromGMT: 0)!
        let parts = calendar.dateComponents([.hour, .minute], from: at), minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if q.startMinutes == q.endMinutes { return false }
        let quiet = q.startMinutes < q.endMinutes ? minute >= q.startMinutes && minute < q.endMinutes : minute >= q.startMinutes || minute < q.endMinutes
        return !quiet
    }
}

public final class NotificationDedupe: @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String: Date] = [:]
    private var identities: [String] = []
    private var inFlight = Set<String>()
    public init() {}
    public func allow(device: String, notification: NotificationRecord, seconds: Int, needsInput: Bool = false, at: Date = Date()) -> Bool {
        let task = notification.id.hasPrefix("task-event:") ? notification.id : ""
        let parts = [device, notification.workspaceId, notification.surfaceId ?? "", notification.threadId, task, String(needsInput), notification.title, notification.body]
        let key = parts.map { "\($0.utf8.count):\($0)" }.joined()
        lock.lock(); defer { lock.unlock() }
        let identity = "\(device.utf8.count):\(device)\(needsInput):\(notification.id)"
        if identities.contains(identity) || inFlight.contains(identity) { return false }
        if seconds > 0 {
            sent = sent.filter { at.timeIntervalSince($0.value) < 3600 }
            if let previous = sent[key], at.timeIntervalSince(previous) < Double(seconds) { return false }
            sent[key] = at
        }
        inFlight.insert(identity)
        return true
    }
    public func recordDelivered(device: String, notification: NotificationRecord, needsInput: Bool) {
        lock.lock(); defer { lock.unlock() }
        identities.append("\(device.utf8.count):\(device)\(needsInput):\(notification.id)")
        if identities.count > 2000 { identities.removeFirst(identities.count - 2000) }
    }
    public func finishAttempt(device: String, notification: NotificationRecord, needsInput: Bool) {
        lock.lock(); defer { lock.unlock() }
        inFlight.remove("\(device.utf8.count):\(device)\(needsInput):\(notification.id)")
    }
}
