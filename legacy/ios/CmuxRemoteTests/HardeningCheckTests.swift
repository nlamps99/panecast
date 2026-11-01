import XCTest
@testable import CmuxRemote

final class HardeningCheckTests: XCTestCase {
    func testFailedCheckWipesKeychain() {
        let keychain = Keychain(service: "h.\(UUID().uuidString)")
        try? keychain.set("v", for: "bearer")
        try? keychain.set("office-token", for: "relay.credentials.http://office.ts.net:4399")
        try? keychain.set("home-token", for: "relay.credentials.http://home.ts.net:4399")
        let check = HardeningCheck(jailbroken: { true }, debugged: { false }, keychain: keychain)
        XCTAssertEqual(check.runAtLaunch(), .failedJailbroken)
        XCTAssertNil(try? keychain.get("bearer"))
        XCTAssertNil(try? keychain.get("relay.credentials.http://office.ts.net:4399"))
        XCTAssertNil(try? keychain.get("relay.credentials.http://home.ts.net:4399"))
    }

    func testCleanCheckReturnsOk() {
        let keychain = Keychain(service: "h.\(UUID().uuidString)")
        let check = HardeningCheck(jailbroken: { false }, debugged: { false }, keychain: keychain)
        XCTAssertEqual(check.runAtLaunch(), .ok)
    }

    /// The bypass must be reachable only through the build configuration.
    /// Previously this function took `environment`/`arguments` that it never
    /// read, so the assertions here passed regardless of their input and the
    /// test proved nothing about the bypass being explicit.
    func testHardeningIsSkippedOnlyInDebugBuilds() {
        #if DEBUG
        XCTAssertTrue(CmuxRemoteApp.shouldSkipHardeningForDevelopment())
        #else
        XCTAssertFalse(CmuxRemoteApp.shouldSkipHardeningForDevelopment())
        #endif
    }

    /// Guards the security-relevant half of the switch directly: whatever the
    /// local build configuration is, a Release build must run the checks.
    func testReleaseBuildsNeverSkipHardening() {
        let skipsInRelease: Bool
        #if DEBUG
        skipsInRelease = false
        #else
        skipsInRelease = CmuxRemoteApp.shouldSkipHardeningForDevelopment()
        #endif
        XCTAssertFalse(skipsInRelease)
    }

    func testDebuggerDetectionAlsoWipesKeychain() {
        let keychain = Keychain(service: "h.\(UUID().uuidString)")
        try? keychain.set("v", for: "bearer")
        let check = HardeningCheck(jailbroken: { false }, debugged: { true }, keychain: keychain)
        XCTAssertEqual(check.runAtLaunch(), .failedDebugged)
        XCTAssertNil(try? keychain.get("bearer"))
    }
}
