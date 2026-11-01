import Foundation
import Observation
import SharedKit

@MainActor
@Observable
public final class WorkspaceStore {
    public var workspaces: [Workspace] = []
    public var windows: [CmuxWindow] = []
    /// The window whose workspaces are currently listed. `nil` means "whatever
    /// cmux considers the key window", which is also the pre-window-support
    /// behaviour.
    public var selectedWindowId: String?
    public var selectedId: String?
    public var surfacesByWorkspaceId: [String: [Surface]] = [:]
    public var connection: ConnectionState = .disconnected
    /// How the app reached the relay for this connection. Surfaced on the
    /// workspace list because the two paths differ in latency and in whether the
    /// link is encrypted, so "which one am I on" is worth seeing at a glance —
    /// especially under `auto`, where the app picks without being asked.
    public var activeTransport: ActiveTransport?
    public var onWorkspaceAlert: (@MainActor (NotificationRecord) -> Void)?

    private let rpc: any RPCDispatch
    private var seenWorkspaceAlertIds: Set<String> = []

    public init(rpc: any RPCDispatch) {
        self.rpc = rpc
    }

    public func refresh() async {
        connection = .connecting
        do {
            await refreshWindows()
            let response = try await rpc.call(
                method: "workspace.list",
                params: .object(workspaceListParams())
            )
            let payload = try response.unwrapResult().decode(WorkspaceListPayload.self)
            let loaded = payload.workspaces.map(\.model).sorted { $0.index < $1.index }
            workspaces = loaded
            publishWorkspaceAlerts(from: payload.workspaces)
            if selectedId == nil || !loaded.contains(where: { $0.id == selectedId }) {
                selectedId = loaded.first?.id
            }
            for workspace in loaded {
                await refreshSurfaces(workspaceId: workspace.id)
            }
            connection = .connected
        } catch {
            connection = .error(String(describing: error))
        }
    }

    /// Enumerates cmux windows so the UI can scope the workspace list.
    ///
    /// A failure here is not fatal: older cmux builds may not implement
    /// `window.list`, and in that case the app keeps working exactly as before
    /// against the key window.
    private func refreshWindows() async {
        do {
            let response = try await rpc.call(method: "window.list", params: .object([:]))
            let payload = try response.unwrapResult().decode(WindowListPayload.self)
            windows = payload.windows.map(\.model).sorted { $0.index < $1.index }
        } catch {
            windows = []
        }
        guard !windows.isEmpty else {
            selectedWindowId = nil
            return
        }
        if let selectedWindowId, windows.contains(where: { $0.id == selectedWindowId }) {
            return
        }
        // Default to cmux's key window so the first load matches what the user
        // sees on the Mac.
        selectedWindowId = (windows.first(where: \.isKey) ?? windows[0]).id
    }

    /// Switches the listed window and reloads. Workspace selection is dropped
    /// because workspace ids belong to the window that owns them.
    public func selectWindow(id: String) async {
        guard selectedWindowId != id else { return }
        selectedWindowId = id
        selectedId = nil
        workspaces = []
        surfacesByWorkspaceId = [:]
        await refresh()
    }

    private func workspaceListParams() -> [String: JSONValue] {
        guard let selectedWindowId else { return [:] }
        return ["window_id": .string(selectedWindowId)]
    }

    public var selectedWindow: CmuxWindow? {
        guard let selectedWindowId else { return nil }
        return windows.first { $0.id == selectedWindowId }
    }

    public func refreshSurfaces(workspaceId: String) async {
        do {
            let response = try await rpc.call(
                method: "surface.list",
                params: .object(["workspace_id": .string(workspaceId)])
            )
            let payload = try response.unwrapResult().decode(SurfaceListPayload.self)
            surfacesByWorkspaceId[workspaceId] = payload.surfaces.map(\.model).sorted { $0.index < $1.index }
        } catch {
            surfacesByWorkspaceId[workspaceId] = []
        }
    }

    public func surfaces(for workspaceId: String) -> [Surface] {
        surfacesByWorkspaceId[workspaceId] ?? []
    }

    public func surfaceCount(for workspaceId: String) -> Int {
        surfaces(for: workspaceId).count
    }

    public func create(name: String) async throws {
        // Without `window_id` cmux creates the workspace in its key window,
        // which is not necessarily the window being browsed here.
        var params: [String: JSONValue] = ["title": .string(name)]
        if let selectedWindowId { params["window_id"] = .string(selectedWindowId) }
        _ = try await rpc.call(method: "workspace.create", params: .object(params)).requireOk()
        await refresh()
    }

    public func rename(workspaceId: String, title: String) async throws {
        _ = try await rpc.call(
            method: "workspace.rename",
            params: .object([
                "workspace_id": .string(workspaceId),
                "title": .string(title),
            ])
        ).requireOk()
        await refresh()
    }

    public func close(workspaceId: String) async throws {
        _ = try await rpc.call(
            method: "workspace.close",
            params: .object(["workspace_id": .string(workspaceId)])
        ).requireOk()
        surfacesByWorkspaceId[workspaceId] = nil
        if selectedId == workspaceId {
            selectedId = nil
        }
        await refresh()
    }

    public func createSurface(workspaceId: String) async throws -> Surface {
        let response = try await rpc.call(
            method: "surface.create",
            params: .object([
                "workspace_id": .string(workspaceId),
                "type": .string("terminal"),
                "focus": .bool(true),
            ])
        )
        let payload = try response.unwrapResult().decode(SurfaceMutationPayload.self)
        await refreshSurfaces(workspaceId: workspaceId)
        if let surface = surfaces(for: workspaceId).first(where: { $0.id == payload.surfaceId }) {
            return surface
        }
        return Surface(id: payload.surfaceId, title: "terminal", index: surfaces(for: workspaceId).count)
    }

    public func closeSurface(workspaceId: String, surfaceId: String) async throws {
        _ = try await rpc.call(
            method: "surface.close",
            params: .object([
                "workspace_id": .string(workspaceId),
                "surface_id": .string(surfaceId),
            ])
        ).requireOk()
        await refreshSurfaces(workspaceId: workspaceId)
    }

    public func reset() {
        workspaces = []
        windows = []
        selectedWindowId = nil
        selectedId = nil
        surfacesByWorkspaceId = [:]
        connection = .disconnected
        activeTransport = nil
        seenWorkspaceAlertIds = []
    }

    private func publishWorkspaceAlerts(from payloads: [WorkspacePayload]) {
        guard let onWorkspaceAlert else { return }
        for payload in payloads {
            guard let notification = payload.needsInputNotification else { continue }
            guard seenWorkspaceAlertIds.insert(notification.id).inserted else { continue }
            onWorkspaceAlert(notification)
        }
    }
}

public enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case error(String)
}

/// The transport a live connection is actually using.
///
/// Deliberately coarser than `RelayEndpoint`: the header needs to answer "LAN or
/// internet, encrypted or not", not to echo the address back at the user.
public enum ActiveTransport: Equatable, Sendable {
    /// Plain HTTP over the local network — fastest, but not encrypted.
    case lan
    /// WireGuard-encrypted peer-to-peer over the tailnet.
    case tailscale
    /// TLS to the self-hosted broker, which relays to the Mac.
    case broker

    public var shortLabel: String {
        switch self {
        case .lan: return L10n.string("LAN")
        case .tailscale: return L10n.string("TAILSCALE")
        case .broker: return L10n.string("VPS")
        }
    }

    /// True when the link carries terminal traffic in the clear, so the UI can
    /// mark it rather than letting it look equivalent to the encrypted paths.
    public var isPlaintext: Bool { self == .lan }

    public var accessibilityDescription: String {
        switch self {
        case .lan: return L10n.string("Connected over the local network, not encrypted")
        case .tailscale: return L10n.string("Connected over Tailscale, encrypted")
        case .broker: return L10n.string("Connected through the server, encrypted")
        }
    }
}
