import XCTest
import Foundation
import SharedKit
@testable import RelayServer

final class ProjectServicesTests: XCTestCase {
    func testRejectsTraversalAndEscapingSymlinksAndReadsUTF8() async throws {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let root = temp.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        try Data("你好".utf8).write(to: root.appendingPathComponent("hello.txt"))
        try Data("outside".utf8).write(to: temp.appendingPathComponent("outside"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: temp.appendingPathComponent("outside"))
        XCTAssertThrowsError(try ProjectFiles.resolve(root: root, path: "../outside"))
        XCTAssertThrowsError(try ProjectFiles.resolve(root: root, path: "escape"))
        let result = try await ProjectFiles.dispatch(method: "project.read", root: root, path: "hello.txt")
        guard case .object(let object) = result else { return XCTFail("expected file") }
        XCTAssertEqual(object["text"], .string("你好"))
        XCTAssertEqual(object["data_base64"], .string(Data("你好".utf8).base64EncodedString()))
    }
    func testGitDiffIncludesStagedAndWorkingChangesWithoutExternalDiff() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func git(_ args: [String]) throws {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", root.path] + args
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit(); XCTAssertEqual(p.terminationStatus, 0)
        }
        try git(["init", "-q"])
        try Data("old\n".utf8).write(to: root.appendingPathComponent("a.txt")); try git(["add", "a.txt"])
        try Data("new\n".utf8).write(to: root.appendingPathComponent("a.txt")); try git(["config", "diff.external", "/usr/bin/false"])
        let result = try await ProjectFiles.dispatch(method: "project.diff", root: root, path: "")
        guard case .object(let object) = result, case .string(let working)? = object["working"], case .string(let staged)? = object["staged"] else { return XCTFail("expected diff") }
        XCTAssertTrue(working.contains("+new")); XCTAssertTrue(staged.contains("+old"))
    }
}
