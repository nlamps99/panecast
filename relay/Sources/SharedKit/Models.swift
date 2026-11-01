import Foundation

/// A cmux app window.
///
/// cmux scopes `workspace.list` to a single window: called without params it
/// returns only the current key window's workspaces, so a second open window is
/// invisible to the app unless it passes `window_id` explicitly. `window.list`
/// enumerates the windows to pick from.
public struct CmuxWindow: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// cmux's stable `window:N` reference, shown to disambiguate windows that
    /// have no user-facing name of their own.
    public var ref: String
    public var index: Int
    public var workspaceCount: Int
    /// True for the window cmux currently treats as key (frontmost).
    public var isKey: Bool

    public init(id: String, ref: String, index: Int, workspaceCount: Int, isKey: Bool) {
        self.id = id; self.ref = ref; self.index = index
        self.workspaceCount = workspaceCount; self.isKey = isKey
    }
}

/// Workspace as it crosses the relay → iOS boundary.
///
/// Slimmed v2 (2026-05-10): cmux's `workspace.list` does not expose `lastActivity`
/// or inline surfaces. We surface only the fields iOS actually renders. Sort by
/// `index` (cmux-defined ordering, mirrors `workspace:N` refs).
public struct Workspace: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var index: Int
    public init(id: String, name: String, index: Int) {
        self.id = id; self.name = name; self.index = index
    }
}

/// Surface as it crosses the relay → iOS boundary.
///
/// Slimmed v2 (2026-05-10): cmux's `surface.list` does not expose terminal grid
/// dimensions or `lastActivity`. Cols/rows of the live buffer come from
/// `surface.read_text` responses on the server side.
public struct Surface: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var index: Int
    public init(id: String, title: String, index: Int) {
        self.id = id; self.title = title; self.index = index
    }
}

public struct NotificationRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var surfaceId: String?
    public var title: String
    public var subtitle: String?
    public var body: String
    public var ts: Int64
    public var threadId: String
    public init(id: String, workspaceId: String, surfaceId: String?, title: String,
                subtitle: String?, body: String, ts: Int64, threadId: String) {
        self.id = id; self.workspaceId = workspaceId; self.surfaceId = surfaceId
        self.title = title; self.subtitle = subtitle; self.body = body
        self.ts = ts; self.threadId = threadId
    }
}

public struct BootInfo: Codable, Sendable, Equatable {
    public var bootId: String
    public var startedAt: Int64
    public init(bootId: String, startedAt: Int64) { self.bootId = bootId; self.startedAt = startedAt }
}

public enum EventCategory: String, Codable, Sendable, CaseIterable {
    case workspace, surface, notification, system, agent, hook, unknown

    public static var allCases: [EventCategory] {
        [.workspace, .surface, .notification, .system, .agent, .hook]
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = EventCategory(rawValue: rawValue) ?? .unknown
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
