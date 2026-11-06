import Foundation
import RelayCore
import SharedKit

/// Read-only project access, rooted in a surface reported by the terminal backend.
public final class HostFacade: CMUXFacade, @unchecked Sendable {
    private let backend: any CMUXFacade
    private let config: @Sendable () -> RelayConfig
    private let inbox: InboxJournal?
    public init(backend: any CMUXFacade, inbox: InboxJournal? = nil, config: @escaping @Sendable () -> RelayConfig) { self.backend = backend; self.inbox = inbox; self.config = config }
    public func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        if method == "inbox.sync", let inbox { return try await inbox.page(params: params) }
        if method == "relay.snippets" {
            return .object(["snippets": .array(config().snippets.map { .object(["label": .string($0.label), "text": .string($0.text)]) })])
        }
        if method == "relay.diagnostics" {
            do {
                _ = try await backend.dispatch(method: "workspace.list", params: .object([:]))
                return .object(["backend": .string("cmux"), "backend_ready": .bool(true), "project_access": .bool(true)])
            } catch { return .object(["backend": .string("cmux"), "backend_ready": .bool(false)]) }
        }
        if method.hasPrefix("project.") {
            guard case .object(let p) = params,
                  case .string(let workspace)? = p["workspace_id"], case .string(let surface)? = p["surface_id"] else { throw ProjectError.missingTarget }
            let root = try await projectRoot(workspace: workspace, surface: surface)
            let path: String
            if case .string(let value)? = p["path"] { path = value } else { path = "" }
            return try await ProjectFiles.dispatch(method: method, root: root, path: path)
        }
        return try await backend.dispatch(method: method, params: params)
    }
    private func projectRoot(workspace: String, surface: String) async throws -> URL {
        let result = try await backend.dispatch(method: "surface.list", params: .object(["workspace_id": .string(workspace)]))
        guard case .object(let object) = result, case .array(let surfaces)? = object["surfaces"],
              let found = surfaces.first(where: { if case .object(let s) = $0 { return s["id"] == .string(surface) }; return false }),
              case .object(let s) = found else { throw ProjectError.missingTarget }
        for key in ["current_directory", "working_directory", "cwd", "requested_working_directory"] {
            if case .string(let path)? = s[key], path.hasPrefix("/") { return URL(fileURLWithPath: path).resolvingSymlinksInPath() }
        }
        throw ProjectError.missingDirectory
    }
}

enum ProjectError: Error, CustomStringConvertible {
    case missingTarget, missingDirectory, outsideProject, tooLarge, unsupported, commandFailed
    var description: String {
        switch self {
        case .missingTarget: return "找不到当前终端，请重新选择"
        case .missingDirectory: return "终端未提供项目目录，请在电脑上打开项目后重试"
        case .outsideProject: return "只能查看当前项目目录内的文件"
        case .tooLarge: return "文件超过 4 MB，请在电脑上查看"
        case .unsupported: return "不支持这个项目操作"
        case .commandFailed: return "无法读取 Git 差异，请确认当前目录属于 Git 仓库"
        }
    }
}

enum ProjectFiles {
    static let maxBytes = 4 * 1024 * 1024
    static func resolve(root: URL, path: String) throws -> URL {
        guard !path.hasPrefix("/"), !path.contains("\0"), !path.split(separator: "/").contains("..") else { throw ProjectError.outsideProject }
        let root = root.resolvingSymlinksInPath().standardizedFileURL
        let file = root.appendingPathComponent(path).resolvingSymlinksInPath().standardizedFileURL
        guard file.path == root.path || file.path.hasPrefix(root.path + "/") else { throw ProjectError.outsideProject }
        return file
    }
    static func dispatch(method: String, root: URL, path: String) async throws -> JSONValue {
        let file = try resolve(root: root, path: path)
        if method == "project.diff" {
            let working = try await git(root: root, args: ["diff", "--no-ext-diff", "--no-textconv", "--color=never", "--", "."], limit: 256 * 1024)
            let staged = try await git(root: root, args: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--color=never", "--", "."], limit: 256 * 1024)
            return .object(["root": .string(root.path), "working": .string(working.text), "staged": .string(staged.text), "truncated": .bool(working.truncated || staged.truncated)])
        }
        if method == "project.list" {
            let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .fileSizeKey]
            let files = try FileManager.default.contentsOfDirectory(at: file, includingPropertiesForKeys: Array(keys)).filter { ![".git", "node_modules", ".build"].contains($0.lastPathComponent) }.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
            let entries: [JSONValue] = files.prefix(500).compactMap { entry in
                guard let safe = try? resolve(root: root, path: (path.isEmpty ? "" : path + "/") + entry.lastPathComponent), let attrs = try? safe.resourceValues(forKeys: keys), attrs.isDirectory == true || attrs.isRegularFile == true else { return nil }
                return .object(["name": .string(entry.lastPathComponent), "directory": .bool(attrs.isDirectory == true), "size": .int(Int64(attrs.fileSize ?? 0))])
            }
            return .object(["root": .string(root.path), "path": .string(path), "entries": .array(entries), "truncated": .bool(files.count > 500)])
        }
        if method == "project.read" {
            let attrs = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard attrs.isRegularFile == true else { throw ProjectError.unsupported }
            guard (attrs.fileSize ?? maxBytes + 1) <= maxBytes else { throw ProjectError.tooLarge }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
            guard data.count <= maxBytes else { throw ProjectError.tooLarge }
            let mime = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "pdf": "application/pdf"][file.pathExtension.lowercased()] ?? "application/octet-stream"
            var result: [String: JSONValue] = ["name": .string(file.lastPathComponent), "mime_type": .string(mime), "size": .int(Int64(data.count)), "data_base64": .string(data.base64EncodedString())]
            if !data.contains(0), let text = String(data: data, encoding: .utf8), data.count <= 512 * 1024 { result["text"] = .string(text) }
            return .object(result)
        }
        throw ProjectError.unsupported
    }
    private static func git(root: URL, args: [String], limit: Int) async throws -> (text: String, truncated: Bool) {
        try await Task.detached(priority: .utility) {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", root.path] + args
            process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
            defer { timeout.cancel(); try? pipe.fileHandleForReading.close() }
            var output = Data()
            while output.count <= limit, let chunk = try pipe.fileHandleForReading.read(upToCount: min(64 * 1024, limit + 1 - output.count)), !chunk.isEmpty { output.append(chunk) }
            let truncated = output.count > limit
            if truncated && process.isRunning { process.terminate() }
            process.waitUntilExit()
            guard truncated || process.terminationStatus == 0 else { throw ProjectError.commandFailed }
            return (String(decoding: output.prefix(limit), as: UTF8.self), truncated)
        }.value
    }
}
