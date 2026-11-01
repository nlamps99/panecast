import XCTest
import SharedKit
@testable import CmuxRemote

final class TransportSelectorTests: XCTestCase {
    private let lan = RelayEndpoint.direct(host: "192.168.1.42", port: 4399)
    private let broker = RelayEndpoint.broker(
        baseURL: "https://relay.example.com",
        relayId: "home-mac"
    )

    private func candidates() -> TransportCandidates {
        TransportCandidates(
            lan: lan,
            lanPairingCode: "lan-code",
            broker: broker,
            brokerPairingCode: "broker-code"
        )
    }

    /// Probe answers 200 only for the LAN health URL.
    private func selector(lanReachable: Bool, probes: LockBox<[String]>? = nil) -> TransportSelector {
        TransportSelector(http: MockHTTPClient { request in
            let url = request.url?.absoluteString ?? ""
            probes?.withValue { $0.append(url) }
            if url.hasPrefix("http://192.168.1.42:4399") {
                return lanReachable ? (Data(#"{"ok":true}"#.utf8), 200) : (Data(), 500)
            }
            return (Data(), 500)
        })
    }

    func testAutoPrefersLANWhenItAnswers() async {
        let selection = await selector(lanReachable: true)
            .select(preference: .auto, candidates: candidates())
        XCTAssertEqual(selection?.endpoint, lan)
        XCTAssertEqual(selection?.pairingCode, "lan-code")
    }

    func testAutoFallsBackToBrokerWhenLANIsSilent() async {
        let selection = await selector(lanReachable: false)
            .select(preference: .auto, candidates: candidates())
        XCTAssertEqual(selection?.endpoint, broker)
        XCTAssertEqual(selection?.pairingCode, "broker-code")
    }

    func testAutoProbesHealthEndpointOnLANOnly() async {
        let probes = LockBox<[String]>([])
        _ = await selector(lanReachable: true, probes: probes)
            .select(preference: .auto, candidates: candidates())
        XCTAssertEqual(probes.withValue { $0 }, ["http://192.168.1.42:4399/v1/health"])
    }

    /// An explicit preference must not spend time probing.
    func testExplicitPreferencesSkipTheProbe() async {
        let probes = LockBox<[String]>([])
        let selector = selector(lanReachable: true, probes: probes)

        let direct = await selector.select(preference: .direct, candidates: candidates())
        XCTAssertEqual(direct?.endpoint, lan)

        let server = await selector.select(preference: .broker, candidates: candidates())
        XCTAssertEqual(server?.endpoint, broker)

        XCTAssertTrue(probes.withValue { $0 }.isEmpty)
    }

    func testAutoWithNoBrokerStillReturnsLAN() async {
        let selection = await selector(lanReachable: false)
            .select(preference: .auto, candidates: TransportCandidates(lan: lan, lanPairingCode: "c"))
        XCTAssertEqual(selection?.endpoint, lan)
    }

    func testAutoWithNoLANUsesBroker() async {
        let selection = await selector(lanReachable: false).select(
            preference: .auto,
            candidates: TransportCandidates(broker: broker, brokerPairingCode: "broker-code")
        )
        XCTAssertEqual(selection?.endpoint, broker)
    }

    func testReturnsNilWhenNothingIsConfigured() async {
        let selection = await selector(lanReachable: false)
            .select(preference: .auto, candidates: TransportCandidates())
        XCTAssertNil(selection)

        let directOnly = await selector(lanReachable: false)
            .select(preference: .direct, candidates: TransportCandidates())
        XCTAssertNil(directOnly)
    }

    /// A relay that answers with a non-200 is not usable, so it must not win the
    /// probe just because it responded.
    func testNon200HealthResponseCountsAsUnreachable() async {
        let selector = TransportSelector(http: MockHTTPClient { _ in
            (Data(#"{"error":"nope"}"#.utf8), 503)
        })
        let selection = await selector.select(preference: .auto, candidates: candidates())
        XCTAssertEqual(selection?.endpoint, broker)
    }

    func testProbeFailureIsTreatedAsUnreachable() async {
        let selector = TransportSelector(http: ThrowingHTTPClient())
        let reachable = await selector.isReachable(lan)
        XCTAssertFalse(reachable)
    }

    /// A host the policy rejects can never be probed into use.
    func testDisallowedHostIsNotReachable() async {
        let reachable = await selector(lanReachable: true)
            .isReachable(.direct(host: "example.com", port: 4399))
        XCTAssertFalse(reachable)
    }
}

@MainActor
final class TransportCoordinatorTests: XCTestCase {
    private let lan = RelayEndpoint.direct(host: "192.168.1.42", port: 4399)
    private let broker = RelayEndpoint.broker(
        baseURL: "https://relay.example.com",
        relayId: "home-mac"
    )
    private var active: TransportCoordinator?

    override func tearDown() async throws {
        // `connected` starts a real NWPathMonitor under `auto`; stop it so it
        // does not outlive the test.
        active?.stop()
        active = nil
    }

    private func coordinator(
        preference: TransportPreference,
        lanReachable: Bool
    ) -> TransportCoordinator {
        let candidates = TransportCandidates(
            lan: lan,
            lanPairingCode: "lan-code",
            broker: broker,
            brokerPairingCode: "broker-code"
        )
        let selector = TransportSelector(http: MockHTTPClient { request in
            let url = request.url?.absoluteString ?? ""
            if url.hasPrefix("http://192.168.1.42:4399") {
                return lanReachable ? (Data(), 200) : (Data(), 500)
            }
            return (Data(), 500)
        })
        let coordinator = TransportCoordinator(
            selector: selector,
            settings: { (preference, candidates) }
        )
        active = coordinator
        return coordinator
    }

    func testSwitchesWhenLANDisappears() async {
        var switched = false
        let coordinator = coordinator(preference: .auto, lanReachable: false)
        coordinator.connected(to: lan) { switched = true }

        let moved = await coordinator.pathChanged()

        XCTAssertTrue(moved)
        XCTAssertTrue(switched)
    }

    func testDoesNotSwitchWhenSelectionIsUnchanged() async {
        var switched = false
        let coordinator = coordinator(preference: .auto, lanReachable: true)
        coordinator.connected(to: lan) { switched = true }

        let moved = await coordinator.pathChanged()

        XCTAssertFalse(moved)
        XCTAssertFalse(switched)
    }

    func testSwitchesBackToLANWhenItReturns() async {
        var switched = false
        let coordinator = coordinator(preference: .auto, lanReachable: true)
        coordinator.connected(to: broker) { switched = true }

        let moved = await coordinator.pathChanged()

        XCTAssertTrue(moved)
        XCTAssertTrue(switched)
    }

    /// With an explicit preference there is nothing to re-decide, so a path
    /// change must never interrupt a working session.
    func testExplicitPreferenceNeverSwitches() async {
        var switched = false
        let coordinator = coordinator(preference: .broker, lanReachable: true)
        coordinator.connected(to: broker) { switched = true }

        let moved = await coordinator.pathChanged()

        XCTAssertFalse(moved)
        XCTAssertFalse(switched)
    }
}

private final class ThrowingHTTPClient: HTTPClientFacade, @unchecked Sendable {
    struct Failure: Error {}
    func request(_ request: URLRequest) async throws -> (Data, Int) { throw Failure() }
}

/// Covers how stored settings and scanned QR payloads turn into a preference
/// plus candidate endpoints.
final class TransportSettingsTests: XCTestCase {
    private func makeDefaults() throws -> (UserDefaults, String) {
        let suiteName = "transport.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suiteName)), suiteName)
    }

    func testResolvesAutoWithBothCandidates() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("auto", forKey: "cmux.transportPreference")
        defaults.set("192.168.1.42", forKey: "cmux.host")
        defaults.set(4399, forKey: "cmux.port")
        defaults.set("lan-code", forKey: "cmux.lanPairingCode")
        defaults.set("https://relay.example.com", forKey: "cmux.brokerURL")
        defaults.set("home-mac", forKey: "cmux.relayId")
        defaults.set("broker-code", forKey: "cmux.pairingCode")

        let (preference, candidates) = CmuxRemoteApp.resolveTransportSettings(
            ProcessInfo.processInfo,
            defaults: defaults
        )

        XCTAssertEqual(preference, .auto)
        XCTAssertEqual(candidates.lan, .direct(host: "192.168.1.42", port: 4399))
        XCTAssertEqual(candidates.lanPairingCode, "lan-code")
        XCTAssertEqual(
            candidates.broker,
            .broker(baseURL: "https://relay.example.com", relayId: "home-mac")
        )
        XCTAssertEqual(candidates.brokerPairingCode, "broker-code")
    }

    /// Installs from before `auto` existed only stored `cmux.connectionMode`;
    /// upgrading must not silently change which transport is used.
    func testFallsBackToLegacyConnectionModeKey() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("broker", forKey: "cmux.connectionMode")
        defaults.set("https://relay.example.com", forKey: "cmux.brokerURL")
        defaults.set("home-mac", forKey: "cmux.relayId")

        let (preference, _) = CmuxRemoteApp.resolveTransportSettings(
            ProcessInfo.processInfo,
            defaults: defaults
        )

        XCTAssertEqual(preference, .broker)
    }

    func testDefaultsToDirectAndOmitsUnconfiguredCandidates() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let (preference, candidates) = CmuxRemoteApp.resolveTransportSettings(
            ProcessInfo.processInfo,
            defaults: defaults
        )

        XCTAssertEqual(preference, .direct)
        XCTAssertNil(candidates.lan)
        XCTAssertNil(candidates.broker)
    }

    func testUsesDefaultPortWhenUnset() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("mac.tailnet.ts.net", forKey: "cmux.host")

        let (_, candidates) = CmuxRemoteApp.resolveTransportSettings(
            ProcessInfo.processInfo,
            defaults: defaults
        )

        XCTAssertEqual(candidates.lan, .direct(host: "mac.tailnet.ts.net", port: 4399))
    }

    /// A QR carrying LAN details should leave the phone in `auto`, which is the
    /// whole point of putting them in the code.
    func testPersistingPayloadWithLANSelectsAuto() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        CmuxRemoteApp.persist(
            PairingPayload(
                serverURL: "https://relay.example.com",
                relayId: "home-mac",
                pairingCode: "broker-code",
                lanURL: "http://192.168.1.42:4399",
                lanPairingCode: "lan-code"
            ),
            defaults: defaults
        )

        XCTAssertEqual(defaults.string(forKey: "cmux.transportPreference"), "auto")
        XCTAssertEqual(defaults.string(forKey: "cmux.host"), "192.168.1.42")
        XCTAssertEqual(defaults.integer(forKey: "cmux.port"), 4399)
        XCTAssertEqual(defaults.string(forKey: "cmux.lanPairingCode"), "lan-code")
        XCTAssertEqual(defaults.string(forKey: "cmux.brokerURL"), "https://relay.example.com")
        XCTAssertEqual(defaults.string(forKey: "cmux.pairingCode"), "broker-code")
    }

    func testPersistingBrokerOnlyPayloadSelectsServer() throws {
        let (defaults, suite) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        CmuxRemoteApp.persist(
            PairingPayload(
                serverURL: "https://relay.example.com",
                relayId: "home-mac",
                pairingCode: "broker-code"
            ),
            defaults: defaults
        )

        XCTAssertEqual(defaults.string(forKey: "cmux.transportPreference"), "broker")
        XCTAssertNil(defaults.string(forKey: "cmux.host"))
        XCTAssertNil(defaults.string(forKey: "cmux.lanPairingCode"))
    }
}
