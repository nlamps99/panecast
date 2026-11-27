import Foundation
import SharedKit

extension CMUXClient {
    public func workspaceList() async throws -> [Workspace] {
        let resp = try await call(method: "workspace.list", params: .object([:]))
        let raw = try resp.unwrapResult().decode(CMUXWorkspaceListRaw.self)
        return raw.workspaces.map { $0.toWorkspace() }
    }

    public func workspaceCreate(name: String) async throws -> Workspace {
        let resp = try await call(method: "workspace.create",
                                  params: .object(["title": .string(name)]))
        let raw = try resp.unwrapResult().decode(CMUXWorkspaceCreateRaw.self)
        return raw.workspace.toWorkspace()
    }

    public func workspaceRename(id: String, title: String) async throws {
        _ = try await call(method: "workspace.rename",
                           params: .object([
                               "workspace_id": .string(id),
                               "title": .string(title),
                           ])).requireOk()
    }

    public func workspaceSelect(id: String) async throws {
        _ = try await call(method: "workspace.select",
                           params: .object(["workspace_id": .string(id)])).requireOk()
    }

    public func workspaceClose(id: String) async throws {
        _ = try await call(method: "workspace.close",
                           params: .object(["workspace_id": .string(id)])).requireOk()
    }

    public func surfaceList(workspaceId: String) async throws -> [Surface] {
        let resp = try await call(method: "surface.list",
                                  params: .object(["workspace_id": .string(workspaceId)]))
        let raw = try resp.unwrapResult().decode(CMUXSurfaceListRaw.self)
        return raw.surfaces.map { $0.toSurface() }
    }

    public func surfaceSendText(workspaceId: String, surfaceId: String, text: String) async throws {
        _ = try await call(method: "surface.send_text",
                           params: .object([
                               "workspace_id": .string(workspaceId),
                               "surface_id": .string(surfaceId),
                               "text": .string(text),
                           ])).requireOk()
    }

    public func surfaceSendKey(workspaceId: String, surfaceId: String, key: Key) async throws {
        var params: [String: JSONValue] = [
            "workspace_id": .string(workspaceId),
            "surface_id": .string(surfaceId),
        ]
        let method: String
        switch CmuxKeyNames.translate(KeyEncoder.encode(key)) {
        case .key(let name): method = "surface.send_key"; params["key"] = .string(name)
        case .text(let text): method = "surface.send_text"; params["text"] = .string(text)
        }
        _ = try await call(method: method, params: .object(params)).requireOk()
    }

    public nonisolated func surfaceReadText(workspaceId: String, surfaceId: String, lines: Int)
        async throws -> Screen
    {
        // `rev` is a relay-internal counter (DiffEngine bumps per tick); the
        // cmux response has no equivalent, so we hand back 0 here and let
        // callers stamp their own rev.
        try await surfaceReadTextRaw(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines).toScreen(rev: 0)
    }

    /// The terminal's text as cmux sent it, newline-joined. Decoded straight
    /// from the response; the base64 mirror cmux adds is skipped.
    public nonisolated func surfaceReadTextString(workspaceId: String, surfaceId: String, lines: Int)
        async throws -> String
    {
        try await surfaceReadTextRaw(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines).text
    }

    nonisolated func surfaceReadTextRaw(workspaceId: String, surfaceId: String, lines: Int)
        async throws -> CMUXReadTextRaw
    {
        try await call(method: "surface.read_text",
                       params: .object([
                           "workspace_id": .string(workspaceId),
                           "surface_id": .string(surfaceId),
                           "lines": .int(Int64(lines)),
                       ]),
                       result: CMUXReadTextRaw.self)
    }

    public func notificationCreate(workspaceId: String, surfaceId: String?, title: String,
                                   subtitle: String?, body: String) async throws
    {
        var params: [String: JSONValue] = [
            "workspace_id": .string(workspaceId),
            "title": .string(title),
            "body": .string(body),
        ]
        if let s = surfaceId { params["surface_id"] = .string(s) }
        if let s = subtitle  { params["subtitle"]  = .string(s) }
        _ = try await call(method: "notification.create", params: .object(params)).requireOk()
    }
}

extension RPCResponse {
    public func requireOk() throws -> RPCResponse {
        if let e = error { throw CMUXClientError.rpc(e) }
        return self
    }

    public func unwrapResult() throws -> JSONValue {
        if let e = error { throw CMUXClientError.rpc(e) }
        guard let r = result else {
            throw CMUXClientError.decoding("ok=true but result is nil for id=\(id)")
        }
        return r
    }
}

extension JSONValue {
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try SharedKitJSON.deterministicEncoder.encode(self)
        return try SharedKitJSON.snakeCaseDecoder.decode(T.self, from: data)
    }
}
