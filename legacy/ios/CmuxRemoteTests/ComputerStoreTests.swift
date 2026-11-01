import XCTest
@testable import CmuxRemote

@MainActor
final class ComputerStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    private var keychain: Keychain!

    override func setUp() async throws {
        suite = "computers.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        keychain = Keychain(service: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try keychain.wipe()
    }

    func testMigratesLegacyComputerAndCredentialsOnce() throws {
        defaults.set("Mac.ts.net", forKey: "cmux.host")
        defaults.set(4400, forKey: "cmux.port")
        try keychain.set("Mac.ts.net", for: "relay_host")
        try keychain.set("device", for: "device_id")
        try keychain.set("token", for: "bearer")
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        try store.migrateLegacyCredentials()
        XCTAssertEqual(store.selected?.endpoint, RelayEndpoint(host: "mac.ts.net", port: 4400))
        let auth = AuthClient(host: "mac.ts.net", port: 4400, keychain: keychain, http: URLSessionHTTP())
        XCTAssertEqual(try auth.storedCredentials()?.token, "token")
        XCTAssertNil(try keychain.get("bearer"))
        XCTAssertEqual(defaults.string(forKey: "cmux.host"), "Mac.ts.net")
        let reloaded = ComputerStore(defaults: defaults, keychain: keychain)
        try reloaded.migrateLegacyCredentials()
        XCTAssertEqual(reloaded.computers, store.computers)
        XCTAssertEqual(reloaded.selectedID, store.selectedID)
    }

    func testDoesNotAssignLegacyTokenToDifferentHost() throws {
        defaults.set("new.ts.net", forKey: "cmux.host")
        try keychain.set("old.ts.net", for: "relay_host")
        try keychain.set("device", for: "device_id")
        try keychain.set("token", for: "bearer")
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        try store.migrateLegacyCredentials()
        let auth = AuthClient(host: "new.ts.net", port: 4399, keychain: keychain, http: URLSessionHTTP())
        XCTAssertNil(try auth.storedCredentials())
    }

    func testSelectionPersistsAndRemovingCurrentSelectsRemainingComputer() throws {
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        let first = Computer(name: "Office", host: "office.ts.net")
        let second = Computer(name: "Home", host: "home.ts.net")
        try store.save(first)
        try store.save(second)
        store.select(second.id)
        let reloaded = ComputerStore(defaults: defaults, keychain: keychain)
        XCTAssertEqual(reloaded.selected, second)
        try reloaded.remove(second)
        XCTAssertEqual(reloaded.selected, first)
        try reloaded.remove(first)
        XCTAssertNil(reloaded.selectedID)
        XCTAssertTrue(ComputerStore(defaults: defaults, keychain: keychain).computers.isEmpty)
    }

    func testUpgradeFromFirstMultiComputerBuildKeepsComputerAndToken() throws {
        let id = UUID()
        let data = try JSONSerialization.data(withJSONObject: [
            "computers": [["id": id.uuidString, "name": "Office", "endpoint": ["host": "office.ts.net", "port": 4399]]],
            "selectedID": id.uuidString,
        ])
        defaults.set(data, forKey: ComputerStore.storageKey)
        try keychain.set(#"{"device_id":"d1","token":"existing-token"}"#, for: "relay.credentials.http://office.ts.net:4399")
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        try store.migrateLegacyCredentials()
        store.activateSelected()
        XCTAssertEqual(store.selectedID, id)
        XCTAssertEqual(defaults.string(forKey: "cmux.host"), "office.ts.net")
        let auth = AuthClient(host: "office.ts.net", port: 4399, keychain: keychain, http: URLSessionHTTP())
        XCTAssertEqual(try auth.storedCredentials()?.token, "existing-token")
        XCTAssertNil(try keychain.get("relay.credentials.http://office.ts.net:4399"))
    }

    func testSwitchingComputersRestoresBothTransportsAndSeparatePairingCodes() throws {
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        let office = Computer(name: "Office", endpoint: .direct(host: "office.local", port: 4399),
                              brokerEndpoint: .broker(baseURL: "https://relay.example.com", relayId: "office"), preference: .auto)
        let home = Computer(name: "Home", endpoint: .broker(baseURL: "https://relay.example.com", relayId: "home"), preference: .broker)
        try store.save(office, codes: ComputerPairingCodes(lan: "office-lan-secret", broker: "office-broker-secret"))
        try store.save(home, codes: ComputerPairingCodes(broker: "home-secret"))
        store.select(office.id)
        XCTAssertEqual(defaults.string(forKey: "cmux.transportPreference"), "auto")
        XCTAssertEqual(defaults.string(forKey: "cmux.host"), "office.local")
        XCTAssertEqual(defaults.string(forKey: "cmux.relayId"), "office")
        XCTAssertEqual(defaults.string(forKey: "cmux.lanPairingCode"), "office-lan-secret")
        try store.clearPairingCode(for: office.broker!)
        store.select(home.id)
        XCTAssertEqual(defaults.string(forKey: "cmux.host"), "")
        XCTAssertEqual(defaults.string(forKey: "cmux.pairingCode"), "home-secret")
        store.select(office.id)
        XCTAssertEqual(defaults.string(forKey: "cmux.pairingCode"), "")
        XCTAssertEqual(defaults.string(forKey: "cmux.lanPairingCode"), "office-lan-secret")
        let saved = String(decoding: try XCTUnwrap(defaults.data(forKey: ComputerStore.storageKey)), as: UTF8.self)
        XCTAssertFalse(saved.contains("secret"))
    }

    func testScannedNewComputerDoesNotReplaceExistingComputer() throws {
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        let office = Computer(name: "Office", host: "office.ts.net")
        try store.save(office)
        store.select(office.id)
        defaults.set("", forKey: "cmux.host")
        defaults.set("https://relay.example.com", forKey: "cmux.brokerURL")
        defaults.set("home", forKey: "cmux.relayId")
        defaults.set("broker", forKey: "cmux.transportPreference")
        defaults.set("home-secret", forKey: "cmux.pairingCode")
        store.pendingNewComputer = true
        try store.saveCurrentSettings()
        XCTAssertEqual(store.computers.count, 2)
        XCTAssertEqual(store.computers.first, office)
        XCTAssertEqual(store.selected?.broker?.relayId, "home")
        XCTAssertFalse(store.pendingNewComputer)
    }

    func testValidatesEndpointsAndRejectsDuplicateAfterNormalization() throws {
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        try store.save(Computer(name: "Office", host: " Office.TS.NET \n"))
        XCTAssertThrowsError(try store.save(Computer(name: "Duplicate", host: "office.ts.net")))
        XCTAssertThrowsError(try store.save(Computer(name: "Invalid", host: "https://office.ts.net")))
        XCTAssertThrowsError(try store.save(Computer(name: "Invalid", host: "office.ts.net", port: 0)))
        try store.save(Computer(name: "Other port", host: "office.ts.net", port: 4400))
        XCTAssertEqual(store.computers.count, 2)
    }

    func testRenameKeepsCredentialsAndEndpointEditOnlyClearsOldEndpoint() async throws {
        let store = ComputerStore(defaults: defaults, keychain: keychain)
        var first = Computer(name: "Office", host: "office.ts.net")
        let second = Computer(name: "Home", host: "home.ts.net")
        let http = MockHTTPClient { _ in (Data(#"{"device_id":"d1","token":"abc"}"#.utf8), 200) }
        let office = AuthClient(host: first.endpoint.host, port: 4399, keychain: keychain, http: http)
        let home = AuthClient(host: second.endpoint.host, port: 4399, keychain: keychain, http: http)
        try store.save(first)
        try store.save(second)
        try await office.registerIfNeeded()
        try await home.registerIfNeeded()
        first.name = "Work Mac"
        try store.save(first)
        XCTAssertEqual(try office.storedCredentials()?.token, "abc")
        first.endpoint = RelayEndpoint(host: "new-office.ts.net")
        try store.save(first)
        XCTAssertNil(try office.storedCredentials())
        XCTAssertEqual(try home.storedCredentials()?.token, "abc")
        try store.remove(first)
        XCTAssertEqual(try home.storedCredentials()?.token, "abc")
        try store.unpairSelected()
        XCTAssertNil(try home.storedCredentials())
        XCTAssertEqual(store.computers, [second])
    }
}
