import Foundation
import SharedKit

public struct HostBatterySnapshot: Equatable, Sendable {
    public let available: Bool
    public let percent: Int?
    public let state: String?
    public let powerSource: String?

    public var isCharging: Bool? {
        guard let state else { return nil }
        return state == "charging" || state == "charged" || state == "finishing charge"
    }

    public var json: JSONValue {
        .object([
            "available": .bool(available),
            "percent": percent.map { .int(Int64($0)) } ?? .null,
            "state": state.map { .string($0) } ?? .null,
            "is_charging": isCharging.map { .bool($0) } ?? .null,
            "power_source": powerSource.map { .string($0) } ?? .null,
        ])
    }
}

public enum HostBatteryService {
    public static func snapshot() -> HostBatterySnapshot {
        let output = runPMSet()
        return parse(pmsetOutput: output)
    }

    public static func parse(pmsetOutput output: String) -> HostBatterySnapshot {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let powerSource = lines.first.flatMap { line -> String? in
            guard let start = line.firstIndex(of: "'"),
                  let end = line[line.index(after: start)...].firstIndex(of: "'")
            else { return nil }
            return String(line[line.index(after: start)..<end])
        }

        guard let batteryLine = lines.first(where: { $0.contains("%") }) else {
            return HostBatterySnapshot(available: false, percent: nil, state: nil, powerSource: powerSource)
        }

        let parts = batteryLine.split(separator: ";", omittingEmptySubsequences: true).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let percent = parts.first.flatMap { part -> Int? in
            guard let range = part.range(of: #"\d+(?=%)"#, options: .regularExpression) else { return nil }
            return Int(part[range])
        }
        let state = parts.dropFirst().first?.lowercased()
        return HostBatterySnapshot(available: percent != nil, percent: percent, state: state, powerSource: powerSource)
    }

    private static func runPMSet() -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        process.arguments = ["-g", "batt"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }
}

public struct UploadedFileResult: Equatable, Sendable {
    public let filename: String
    public let path: String
    public let bytes: Int
    public let mimeType: String

    public var json: JSONValue {
        .object([
            "filename": .string(filename),
            "path": .string(path),
            "bytes": .int(Int64(bytes)),
            "mime_type": .string(mimeType),
        ])
    }
}

public enum RelayFileUploadError: Error, CustomStringConvertible, Equatable {
    case invalidParams
    case invalidBase64
    case tooLarge(Int)
    case writeFailed(String)
    case interrupted
    case offsetMismatch(received: Int)

    public var description: String {
        switch self {
        case .invalidParams:
            return "file.upload requires filename, mime_type, and data_base64"
        case .invalidBase64:
            return "file.upload data_base64 is not valid base64"
        case .tooLarge(let limit):
            return "file.upload exceeds \(limit) bytes"
        case .writeFailed(let message):
            return "file.upload write failed: \(message)"
        case .interrupted:
            return "上传已中断，请重新上传"
        case .offsetMismatch:
            return "上传进度不一致，请重新上传"
        }
    }
}

/// `file.upload`, saved under `~/Downloads/cmux-remote/`.
///
/// Files of any size arrive in chunks: each call carries `upload_id`, the
/// byte `offset` it starts at and `done` on the last one. Chunks append to a
/// hidden part file named after the id, so no call depends on memory of the
/// earlier ones and a wrong offset is refused instead of corrupting the file.
/// The last chunk moves the part file into place. A call without `upload_id`
/// is the original single-message upload, limited to `maxBytes`.
public enum RelayFileUploadService {
    public static let maxBytes = 12 * 1024 * 1024
    /// The chunk size clients use; reported by `relay.info`.
    public static let chunkBytes = 4 * 1024 * 1024
    /// Part files nobody finished are removed when a later upload starts.
    static let staleAge: TimeInterval = 24 * 3600
    static let partPrefix = ".panecast-upload-"

    /// Answers one `file.upload` call, single message or chunk.
    public static func receive(
        params: JSONValue,
        date: Date = Date(),
        directory overrideDirectory: URL? = nil
    ) throws -> JSONValue {
        guard case .object(let object) = params, object["upload_id"] != nil else {
            return try save(params: params, date: date, directory: overrideDirectory).json
        }
        guard case .string(let id)? = object["upload_id"], validID(id),
              case .int(let rawOffset)? = object["offset"], rawOffset >= 0,
              case .string(let base64)? = object["data_base64"]
        else { throw RelayFileUploadError.invalidParams }
        guard let data = Data(base64Encoded: base64) else { throw RelayFileUploadError.invalidBase64 }
        let offset = Int(rawOffset)
        let directory = overrideDirectory ?? defaultDirectory
        let manager = FileManager.default
        let part = directory.appendingPathComponent(partPrefix + id + ".part", isDirectory: false)
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
            if offset == 0 {
                sweep(directory, now: date)
                guard manager.createFile(atPath: part.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                    throw RelayFileUploadError.writeFailed("cannot create \(part.lastPathComponent)")
                }
            } else {
                guard let size = (try? manager.attributesOfItem(atPath: part.path))?[.size] as? Int else {
                    throw RelayFileUploadError.interrupted
                }
                guard size == offset else { throw RelayFileUploadError.offsetMismatch(received: size) }
                let handle = try FileHandle(forWritingTo: part)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            }
            let received = offset + data.count
            guard case .bool(true)? = object["done"] else {
                return .object(["upload_id": .string(id), "received": .int(Int64(received))])
            }
            var mimeType = "application/octet-stream"
            if case .string(let value)? = object["mime_type"] ?? object["mimeType"] { mimeType = value }
            var requested = ""
            if case .string(let value)? = object["filename"] { requested = value }
            let destination = available(directory.appendingPathComponent(uniqueFilename(requested, mimeType: mimeType, date: date), isDirectory: false))
            try manager.moveItem(at: part, to: destination)
            return UploadedFileResult(filename: destination.lastPathComponent, path: destination.path, bytes: received, mimeType: mimeType).json
        } catch let error as RelayFileUploadError {
            throw error
        } catch {
            throw RelayFileUploadError.writeFailed(String(describing: error))
        }
    }

    public static func save(
        params: JSONValue,
        date: Date = Date(),
        directory overrideDirectory: URL? = nil
    ) throws -> UploadedFileResult {
        guard case .object(let object) = params,
              case .string(let requestedFilename)? = object["filename"],
              case .string(let mimeType)? = object["mime_type"] ?? object["mimeType"],
              case .string(let base64)? = object["data_base64"] ?? object["dataBase64"]
        else { throw RelayFileUploadError.invalidParams }
        guard let data = Data(base64Encoded: base64) else { throw RelayFileUploadError.invalidBase64 }
        guard data.count <= maxBytes else { throw RelayFileUploadError.tooLarge(maxBytes) }

        let directory = overrideDirectory ?? defaultDirectory
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = uniqueFilename(requestedFilename, mimeType: mimeType, date: date)
            let url = directory.appendingPathComponent(filename, isDirectory: false)
            try data.write(to: url, options: .atomic)
            return UploadedFileResult(filename: filename, path: url.path, bytes: data.count, mimeType: mimeType)
        } catch let error as RelayFileUploadError {
            throw error
        } catch {
            throw RelayFileUploadError.writeFailed(String(describing: error))
        }
    }

    private static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Downloads", isDirectory: true)
            .appendingPathComponent("cmux-remote", isDirectory: true)
    }

    static func validID(_ id: String) -> Bool {
        (8...64).contains(id.count) && id.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-" || $0 == "_"
        }
    }

    /// `name.ext`, or `name-2.ext` and so on when two files land in the same second.
    private static func available(_ url: URL) -> URL {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        let folder = url.deletingLastPathComponent()
        for index in 2... {
            let candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base)-\(index)" : "\(base)-\(index).\(ext)", isDirectory: false)
            if !manager.fileExists(atPath: candidate.path) { return candidate }
        }
        return url
    }

    private static func sweep(_ directory: URL, now: Date) {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasPrefix(partPrefix) && name.hasSuffix(".part") {
            let path = directory.appendingPathComponent(name).path
            if let modified = (try? manager.attributesOfItem(atPath: path))?[.modificationDate] as? Date,
               now.timeIntervalSince(modified) > staleAge {
                try? manager.removeItem(atPath: path)
            }
        }
    }

    private static func uniqueFilename(_ requested: String, mimeType: String, date: Date) -> String {
        let safeBase = sanitize(requested)
        let ext = fileExtension(for: mimeType)
        let base: String
        if safeBase.isEmpty {
            base = ext.map { "iphone-image.\($0)" } ?? "file"
        } else if let ext, (safeBase as NSString).pathExtension.isEmpty {
            base = safeBase + ".\(ext)"
        } else {
            base = safeBase
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "\(formatter.string(from: date))-\(base)"
    }

    private static func sanitize(_ name: String) -> String {
        let last = URL(fileURLWithPath: name).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        return last.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }.reduce(into: "") { $0.append($1) }
    }

    /// Images from the photo picker may come without an extension; other
    /// files keep the name they were picked with.
    private static func fileExtension(for mimeType: String) -> String? {
        switch mimeType.lowercased() {
        case "image/png": return "png"
        case "image/heic", "image/heif": return "heic"
        case "image/jpeg", "image/jpg", "": return "jpg"
        default: return mimeType.lowercased().hasPrefix("image/") ? "jpg" : nil
        }
    }
}
