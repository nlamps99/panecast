import XCTest
@testable import CMUXClient

final class CmuxSocketPathTests: XCTestCase {
    func testEnvOverrideWins() {
        let p = cmuxSocketPath(["CMUX_SOCKET_PATH": "/tmp/explicit.sock"])
        XCTAssertEqual(p, "/tmp/explicit.sock")
    }
    func testLegacyAliasFallback() {
        let p = cmuxSocketPath(["CMUX_SOCKET": "/tmp/legacy.sock"])
        XCTAssertEqual(p, "/tmp/legacy.sock")
    }
    func testDefaultsToStateDir() {
        // No markers anywhere → modern XDG state socket path is the fallback.
        let p = cmuxSocketPath(
            ["HOME": "/Users/x"],
            appSupportDirectory: URL(fileURLWithPath: "/Users/x/Library/Application Support"),
            stateDirectory: URL(fileURLWithPath: "/Users/x/.local/state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: noTmpDirectory()
        )
        XCTAssertEqual(p, "/Users/x/.local/state/cmux/cmux.sock")
    }

    func testFollowsTmpMarkerFirst() throws {
        let temp = freshTemp()
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let legacyDir = try makeCmuxDir(temp.appendingPathComponent("appsupport"))
        let tmpSocket = makeSocket(stateDir, "tmp-live.sock")
        let stateSocket = makeSocket(stateDir, "state-live.sock")
        let legacySocket = makeSocket(legacyDir, "legacy-live.sock")
        let tmpMarker = temp.appendingPathComponent("tmp-marker")
        try "\(tmpSocket)\n".write(to: tmpMarker, atomically: true, encoding: .utf8)
        try writeMarker(stateDir, to: stateSocket)
        try writeMarker(legacyDir, to: legacySocket)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: tmpMarker.path,
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, tmpSocket)
    }

    func testStateMarkerPreferredOverLegacy() throws {
        let temp = freshTemp()
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let legacyDir = try makeCmuxDir(temp.appendingPathComponent("appsupport"))
        let stateSocket = makeSocket(stateDir, "state-live.sock")
        let legacySocket = makeSocket(legacyDir, "legacy-live.sock")
        try writeMarker(stateDir, to: stateSocket)
        try writeMarker(legacyDir, to: legacySocket)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, stateSocket)
    }

    func testFollowsLegacyMarkerWhenNewerAbsent() throws {
        let temp = freshTemp()
        let legacyDir = try makeCmuxDir(temp.appendingPathComponent("appsupport"))
        let legacySocket = makeSocket(legacyDir, "cmux-501.sock")
        try writeMarker(legacyDir, to: legacySocket)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("empty-state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, legacySocket)
    }

    func testRespectsXdgStateHomeForStateMarker() throws {
        let temp = freshTemp()
        let xdg = temp.appendingPathComponent("xdgstate")
        let stateDir = try makeCmuxDir(xdg)
        let stateSocket = makeSocket(stateDir, "xdg-live.sock")
        try writeMarker(stateDir, to: stateSocket)

        let p = cmuxSocketPath(
            ["XDG_STATE_HOME": xdg.path],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, stateSocket)
    }

    func testSkipsStaleMarkersAndFallsBackToStateSocket() throws {
        let temp = freshTemp()
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let legacyDir = try makeCmuxDir(temp.appendingPathComponent("appsupport"))
        // Every marker points at a socket that no longer exists.
        let tmpMarker = temp.appendingPathComponent("tmp-marker")
        try "/tmp/no-such-tmp.sock\n".write(to: tmpMarker, atomically: true, encoding: .utf8)
        try writeMarker(stateDir, to: "/tmp/no-such-state.sock")
        try writeMarker(legacyDir, to: "/tmp/no-such-legacy.sock")

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: tmpMarker.path,
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, stateDir.appendingPathComponent("cmux.sock").path)
    }

    func testEnvOverrideWinsOverMarkers() throws {
        let temp = freshTemp()
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let stateSocket = makeSocket(stateDir, "state-live.sock")
        let tmpMarker = temp.appendingPathComponent("tmp-marker")
        try "\(stateSocket)\n".write(to: tmpMarker, atomically: true, encoding: .utf8)
        try writeMarker(stateDir, to: stateSocket)

        let p = cmuxSocketPath(
            ["CMUX_SOCKET_PATH": "/tmp/explicit.sock"],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: tmpMarker.path,
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, "/tmp/explicit.sock")
    }

    func testFindsTaggedDevBuildMarkerInTmp() throws {
        // cmux DR2 (`com.cmuxterm.app.debug.dr2.selfhost`) is a tagged dev build.
        let temp = freshTemp()
        let tmp = temp.appendingPathComponent("tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let socket = makeSocket(tmp, "cmux-debug-dr2-selfhost.sock")
        try "\(socket)\n".write(to: tmp.appendingPathComponent("cmux-dev-dr2-selfhost-last-socket-path"),
                                atomically: true, encoding: .utf8)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: tmp.path
        )

        XCTAssertEqual(p, socket)
    }

    func testFindsVariantMarkerInStateDirectory() throws {
        let temp = freshTemp()
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let socket = makeSocket(stateDir, "nightly.sock")
        try "\(socket)\n".write(to: stateDir.appendingPathComponent("nightly-last-socket-path"),
                                atomically: true, encoding: .utf8)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: noTmpDirectory()
        )

        XCTAssertEqual(p, socket)
    }

    func testStableMarkerWinsOverVariantMarkers() throws {
        let temp = freshTemp()
        let tmp = temp.appendingPathComponent("tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let stable = makeSocket(stateDir, "cmux-501.sock")
        try writeMarker(stateDir, to: stable)
        let dev = makeSocket(tmp, "cmux-debug-dr2-selfhost.sock")
        try "\(dev)\n".write(to: tmp.appendingPathComponent("cmux-dev-dr2-selfhost-last-socket-path"),
                             atomically: true, encoding: .utf8)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: tmp.path
        )

        XCTAssertEqual(p, stable)
    }

    func testNewestLiveVariantMarkerWinsAndStaleOnesAreSkipped() throws {
        let temp = freshTemp()
        let tmp = temp.appendingPathComponent("tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let older = makeSocket(tmp, "cmux-rc.sock")
        let newer = makeSocket(tmp, "cmux-debug-other.sock")
        let olderMarker = tmp.appendingPathComponent("cmux-rc-last-socket-path")
        let newerMarker = tmp.appendingPathComponent("cmux-dev-other-last-socket-path")
        let staleMarker = tmp.appendingPathComponent("cmux-staging-last-socket-path")
        let unrelated = tmp.appendingPathComponent("cmux-last-debug-log-path")
        try "\(older)\n".write(to: olderMarker, atomically: true, encoding: .utf8)
        try "\(newer)\n".write(to: newerMarker, atomically: true, encoding: .utf8)
        try "/tmp/no-such-staging.sock\n".write(to: staleMarker, atomically: true, encoding: .utf8)
        try "\(older)\n".write(to: unrelated, atomically: true, encoding: .utf8)
        let now = Date()
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-60)], ofItemAtPath: olderMarker.path)
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-30)], ofItemAtPath: newerMarker.path)
        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: staleMarker.path)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: tmp.path
        )

        XCTAssertEqual(p, newer)
    }

    func testLiveVariantWinsOverLeftoverStableSocket() throws {
        // The stable app quit uncleanly and left cmux.sock behind; DR2 is running.
        let temp = freshTemp()
        let tmp = temp.appendingPathComponent("tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let stateDir = try makeCmuxDir(temp.appendingPathComponent("state"))
        let leftover = makeSocket(stateDir, "cmux.sock")
        try writeMarker(stateDir, to: leftover)
        let dr2 = makeSocket(tmp, "cmux-debug-dr2-selfhost.sock")
        try "\(dr2)\n".write(to: tmp.appendingPathComponent("cmux-dev-dr2-selfhost-last-socket-path"),
                             atomically: true, encoding: .utf8)

        let p = cmuxSocketPath(
            [:],
            appSupportDirectory: temp.appendingPathComponent("appsupport"),
            stateDirectory: temp.appendingPathComponent("state"),
            tmpMarkerPath: noTmpMarker(),
            tmpDirectory: tmp.path,
            isListening: { $0 == dr2 }
        )

        XCTAssertEqual(p, dr2)
    }

    func testListeningProbeDistinguishesLiveSocketsFromLeftoverFiles() throws {
        let path = "/tmp/cmuxrelay-probe-\(UUID().uuidString.prefix(8)).sock"
        defer { unlink(path) }
        XCTAssertFalse(unixSocketAcceptsConnections(path), "missing")
        XCTAssertTrue(FileManager.default.createFile(atPath: path, contents: Data()))
        XCTAssertFalse(unixSocketAcceptsConnections(path), "a plain file")
        unlink(path)

        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            let bytes = Array(path.utf8)
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(listener, 4), 0)
        XCTAssertTrue(unixSocketAcceptsConnections(path), "listening")
        close(listener)
        XCTAssertFalse(unixSocketAcceptsConnections(path), "left behind after the listener closed")
    }

    func testSocketPasswordEnvWins() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("cmux", isDirectory: true), withIntermediateDirectories: true)
        try "file-secret\n".write(to: temp.appendingPathComponent("cmux/socket-control-password"), atomically: true, encoding: .utf8)

        let password = cmuxSocketPassword(
            ["CMUX_SOCKET_PASSWORD": " env-secret\n"],
            appSupportDirectory: temp,
            stateDirectory: temp.appendingPathComponent("state")
        )

        XCTAssertEqual(password, "env-secret")
    }

    func testSocketPasswordFallsBackToCmuxPasswordFile() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("cmux", isDirectory: true), withIntermediateDirectories: true)
        try "file-secret\n".write(to: temp.appendingPathComponent("cmux/socket-control-password"), atomically: true, encoding: .utf8)

        let password = cmuxSocketPassword(
            [:],
            appSupportDirectory: temp,
            stateDirectory: temp.appendingPathComponent("state")
        )

        XCTAssertEqual(password, "file-secret")
    }

    func testSocketPasswordIgnoresMissingOrBlankValues() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("cmux", isDirectory: true), withIntermediateDirectories: true)
        try "\n".write(to: temp.appendingPathComponent("cmux/socket-control-password"), atomically: true, encoding: .utf8)

        let password = cmuxSocketPassword(
            ["CMUX_SOCKET_PASSWORD": "   "],
            appSupportDirectory: temp,
            stateDirectory: temp.appendingPathComponent("state")
        )

        XCTAssertNil(password)
    }

    func testSocketPasswordPrefersStateDirectoryOverLegacyFile() throws {
        let temp = freshTemp()
        let state = temp.appendingPathComponent("state")
        let appSupport = temp.appendingPathComponent("appsupport")
        try makeCmuxDir(state)
        try makeCmuxDir(appSupport)
        try "state-secret\n".write(
            to: state.appendingPathComponent("cmux/socket-control-password"),
            atomically: true,
            encoding: .utf8
        )
        try "legacy-secret\n".write(
            to: appSupport.appendingPathComponent("cmux/socket-control-password"),
            atomically: true,
            encoding: .utf8
        )

        let password = cmuxSocketPassword(
            [:],
            appSupportDirectory: appSupport,
            stateDirectory: state
        )

        XCTAssertEqual(password, "state-secret")
    }

    func testSocketCapabilityEnvWinsOverFile() throws {
        let directory = freshTemp()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let capabilityFile = directory.appendingPathComponent("socket-capability")
        try "file-capability\n".write(to: capabilityFile, atomically: true, encoding: .utf8)

        let capability = cmuxSocketCapability(
            ["CMUX_SOCKET_CAPABILITY": " env-capability\n"],
            capabilityFile: capabilityFile
        )

        XCTAssertEqual(capability, "env-capability")
    }

    func testSocketCapabilityFallsBackToRelayFile() throws {
        let directory = freshTemp()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let capabilityFile = directory.appendingPathComponent("socket-capability")
        try "v1.nonce.signature\n".write(to: capabilityFile, atomically: true, encoding: .utf8)

        let capability = cmuxSocketCapability([:], capabilityFile: capabilityFile)

        XCTAssertEqual(capability, "v1.nonce.signature")
    }

    func testSocketCapabilityRejectsWhitespaceInsideToken() throws {
        let directory = freshTemp()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let capabilityFile = directory.appendingPathComponent("socket-capability")
        try "invalid capability\n".write(to: capabilityFile, atomically: true, encoding: .utf8)

        XCTAssertNil(cmuxSocketCapability([:], capabilityFile: capabilityFile))
        XCTAssertNil(cmuxSocketCapability(
            ["CMUX_SOCKET_CAPABILITY": "  "],
            capabilityFile: directory.appendingPathComponent("missing-capability")
        ))
    }

    // MARK: - Helpers
    //
    // cmuxSocketPath() defaults read real machine paths (/tmp/cmux-last-socket-path,
    // ~/.local/state, ~/Library/Application Support). Every test isolates all
    // three marker tiers so results never depend on the host's live cmux.

    private func freshTemp() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
    }

    /// A directory guaranteed not to exist, to neutralize variant-marker scanning.
    private func noTmpDirectory() -> String {
        "/tmp/cmux-iphone-tests-no-such-dir-\(UUID().uuidString)"
    }

    /// A `/tmp` marker path guaranteed not to exist, to neutralize that tier.
    private func noTmpMarker() -> String {
        "/tmp/cmux-iphone-tests-no-such-marker-\(UUID().uuidString)"
    }

    /// Creates `<root>/cmux` and returns it.
    @discardableResult
    private func makeCmuxDir(_ root: URL) throws -> URL {
        let dir = root.appendingPathComponent("cmux", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Creates an empty file standing in for a live socket; returns its path.
    private func makeSocket(_ dir: URL, _ name: String) -> String {
        let socket = dir.appendingPathComponent(name, isDirectory: false)
        _ = FileManager.default.createFile(atPath: socket.path, contents: Data())
        return socket.path
    }

    /// Writes a `last-socket-path` marker inside `dir` pointing at `target`.
    private func writeMarker(_ dir: URL, to target: String) throws {
        try "\(target)\n".write(
            to: dir.appendingPathComponent("last-socket-path", isDirectory: false),
            atomically: true,
            encoding: .utf8
        )
    }

}
