import XCTest
@testable import CmuxRemote

final class AuthClientTests: XCTestCase {
    /// Convenience for asserting on the namespaced Keychain entries.
    private func stored(
        _ keychain: Keychain,
        _ kind: AuthClient.CredentialKind,
        for endpoint: RelayEndpoint
    ) throws -> String? {
        try keychain.get(
            AuthClient.keychainKey(kind, identity: try endpoint.credentialIdentity())
        )
    }

    func testSuccessfulRegistrationClearsOnlyTheConsumedPairingCode() throws {
        let suiteName = "pairing-code.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("pair-secret", forKey: "cmux.pairingCode")
        defaults.set("lan-secret", forKey: "cmux.lanPairingCode")

        // A tailnet host needs no code, so nothing is cleared.
        CmuxRemoteApp.clearStoredPairingCode(
            afterSuccessfulRegistrationWith: .direct(host: "mac.tailnet.ts.net", port: 4399),
            defaults: defaults
        )
        XCTAssertEqual(defaults.string(forKey: "cmux.pairingCode"), "pair-secret")
        XCTAssertEqual(defaults.string(forKey: "cmux.lanPairingCode"), "lan-secret")

        // A LAN host consumes only the LAN code.
        CmuxRemoteApp.clearStoredPairingCode(
            afterSuccessfulRegistrationWith: .direct(host: "192.168.1.42", port: 4399),
            defaults: defaults
        )
        XCTAssertNil(defaults.string(forKey: "cmux.lanPairingCode"))
        XCTAssertEqual(defaults.string(forKey: "cmux.pairingCode"), "pair-secret")

        CmuxRemoteApp.clearStoredPairingCode(
            afterSuccessfulRegistrationWith: .broker(
                baseURL: "https://relay.example.com",
                relayId: "home-mac"
            ),
            defaults: defaults
        )
        XCTAssertNil(defaults.string(forKey: "cmux.pairingCode"))
    }

    func testRegisterStoresBearer() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.direct(host: "mac.tailnet.ts.net", port: 4399)
        let mock = MockHTTPClient { request in
            XCTAssertEqual(request.url?.absoluteString, "http://mac.tailnet.ts.net:4399/v1/devices/me/register")
            // A tailnet host pairs through whois, so no body is sent.
            XCTAssertNil(request.httpBody)
            return (Data(#"{"device_id":"d1","token":"abc"}"#.utf8), 200)
        }
        let client = AuthClient(host: "mac.tailnet.ts.net", port: 4399, keychain: keychain, http: mock)
        try await client.registerIfNeeded()
        XCTAssertEqual(try stored(keychain, .deviceId, for: endpoint), "d1")
        XCTAssertEqual(try stored(keychain, .bearer, for: endpoint), "abc")
        let credentials = try XCTUnwrap(try client.storedCredentials())
        XCTAssertEqual(credentials.token, "abc")
        XCTAssertEqual(credentials.deviceId, "d1")
    }

    /// A private-LAN host cannot be recognised by tailscaled, so it pairs with
    /// the relay's `lan.pairing_code` instead.
    func testLANDirectRegisterSendsPairingBodyWithoutRelayId() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.direct(host: "192.168.1.42", port: 4399)
        let mock = MockHTTPClient { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "http://192.168.1.42:4399/v1/devices/me/register"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try! XCTUnwrap(request.httpBody)
            let object = try! JSONSerialization.jsonObject(with: body) as! [String: String]
            XCTAssertEqual(object["pairing_code"], "lan-secret")
            XCTAssertEqual(object["client_id"], "phone-client")
            XCTAssertEqual(object["device_name"], "My iPhone")
            XCTAssertNil(object["relay_id"])
            return (Data(#"{"device_id":"d-lan","token":"lan-token"}"#.utf8), 200)
        }
        let client = AuthClient(
            endpoint: endpoint,
            keychain: keychain,
            http: mock,
            pairingCode: "lan-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        try await client.registerIfNeeded()

        XCTAssertEqual(try stored(keychain, .bearer, for: endpoint), "lan-token")
    }

    func testLANDirectRegisterRequiresPairingCodeBeforeNetwork() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in
            XCTFail("network should not be hit")
            return (Data(), 500)
        }
        let client = AuthClient(
            endpoint: .direct(host: "192.168.1.42", port: 4399),
            keychain: keychain,
            http: mock,
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        do {
            try await client.registerIfNeeded()
            XCTFail("expected missingPairingCode")
        } catch AuthError.missingPairingCode {}
    }

    func testBrokerRegisterSendsPairingPayloadAndStoresScopedCredentials() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.broker(
            baseURL: "https://relay.example.com/cmux",
            relayId: "home-mac"
        )
        let mock = MockHTTPClient { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://relay.example.com/cmux/v1/devices/me/register"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try! XCTUnwrap(request.httpBody)
            let object = try! JSONSerialization.jsonObject(with: body) as! [String: String]
            XCTAssertEqual(object["relay_id"], "home-mac")
            XCTAssertEqual(object["pairing_code"], "pair-secret")
            XCTAssertEqual(object["client_id"], "phone-client")
            XCTAssertEqual(object["device_name"], "My iPhone")
            return (Data(#"{"device_id":"d-server","token":"server-token"}"#.utf8), 200)
        }
        let client = AuthClient(
            endpoint: endpoint,
            keychain: keychain,
            http: mock,
            pairingCode: "pair-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        try await client.registerIfNeeded()

        XCTAssertEqual(try stored(keychain, .deviceId, for: endpoint), "d-server")
        XCTAssertEqual(try stored(keychain, .bearer, for: endpoint), "server-token")
    }

    /// The whole point of namespacing: a phone that alternates between the LAN
    /// relay and the broker must keep both bearers, because the two mint tokens
    /// from separate device stores and the broker's pairing code is consumed on
    /// first use.
    func testLANAndBrokerCredentialsCoexist() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let lan = RelayEndpoint.direct(host: "192.168.1.42", port: 4399)
        let broker = RelayEndpoint.broker(baseURL: "https://relay.example.com", relayId: "home-mac")

        let lanClient = AuthClient(
            endpoint: lan,
            keychain: keychain,
            http: MockHTTPClient { _ in (Data(#"{"device_id":"d-lan","token":"lan-token"}"#.utf8), 200) },
            pairingCode: "lan-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )
        try await lanClient.registerIfNeeded()

        let brokerClient = AuthClient(
            endpoint: broker,
            keychain: keychain,
            http: MockHTTPClient { _ in (Data(#"{"device_id":"d-br","token":"br-token"}"#.utf8), 200) },
            pairingCode: "pair-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )
        try await brokerClient.registerIfNeeded()

        XCTAssertEqual(try stored(keychain, .bearer, for: lan), "lan-token")
        XCTAssertEqual(try stored(keychain, .bearer, for: broker), "br-token")

        // Reconnecting to the LAN endpoint must not need the network again.
        let hits = LockBox(0)
        let again = AuthClient(
            endpoint: lan,
            keychain: keychain,
            http: MockHTTPClient { _ in
                hits.withValue { $0 += 1 }
                return (Data(), 200)
            },
            pairingCode: "",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )
        try await again.registerIfNeeded()
        XCTAssertEqual(hits.withValue { $0 }, 0)
    }

    /// Upgrading from a build that stored one flat `bearer` must not silently
    /// re-pair — for the broker that would be fatal, since the pairing code has
    /// already been cleared.
    func testMigratesLegacyFlatCredentials() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.broker(baseURL: "https://relay.example.com", relayId: "home-mac")
        try keychain.set("legacy-device", for: "device_id")
        try keychain.set("legacy-token", for: "bearer")
        try keychain.set(try endpoint.credentialIdentity(), for: "relay_endpoint")

        let hits = LockBox(0)
        let client = AuthClient(
            endpoint: endpoint,
            keychain: keychain,
            http: MockHTTPClient { _ in
                hits.withValue { $0 += 1 }
                return (Data(), 500)
            },
            pairingCode: "",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        try await client.registerIfNeeded()

        XCTAssertEqual(hits.withValue { $0 }, 0)
        XCTAssertEqual(try stored(keychain, .bearer, for: endpoint), "legacy-token")
        XCTAssertEqual(try stored(keychain, .deviceId, for: endpoint), "legacy-device")
        XCTAssertNil(try keychain.get("bearer"))
        XCTAssertNil(try keychain.get("relay_endpoint"))
    }

    /// Legacy credentials belonging to a different endpoint must not be adopted.
    func testDoesNotMigrateLegacyCredentialsFromAnotherEndpoint() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let other = RelayEndpoint.broker(baseURL: "https://old.example.com", relayId: "old-mac")
        try keychain.set("legacy-device", for: "device_id")
        try keychain.set("legacy-token", for: "bearer")
        try keychain.set(try other.credentialIdentity(), for: "relay_endpoint")

        let endpoint = RelayEndpoint.broker(baseURL: "https://relay.example.com", relayId: "home-mac")
        let client = AuthClient(
            endpoint: endpoint,
            keychain: keychain,
            http: MockHTTPClient { _ in
                (Data(#"{"device_id":"fresh","token":"fresh-token"}"#.utf8), 200)
            },
            pairingCode: "pair-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        try await client.registerIfNeeded()

        XCTAssertEqual(try stored(keychain, .bearer, for: endpoint), "fresh-token")
    }

    func testBrokerRegisterRequiresPairingCodeBeforeNetwork() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in
            XCTFail("network should not be hit")
            return (Data(), 500)
        }
        let client = AuthClient(
            endpoint: .broker(baseURL: "https://relay.example.com", relayId: "home-mac"),
            keychain: keychain,
            http: mock,
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        do {
            try await client.registerIfNeeded()
            XCTFail("expected missingPairingCode")
        } catch AuthError.missingPairingCode {}
    }

    func testBrokerRejectsInsecurePublicURLBeforeNetwork() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in
            XCTFail("network should not be hit")
            return (Data(), 500)
        }
        let client = AuthClient(
            endpoint: .broker(baseURL: "http://relay.example.com", relayId: "home-mac"),
            keychain: keychain,
            http: mock,
            pairingCode: "pair-secret",
            clientId: "phone-client",
            deviceName: "My iPhone"
        )

        do {
            try await client.registerIfNeeded()
            XCTFail("expected insecureBrokerURL")
        } catch AuthError.insecureBrokerURL {}
    }

    func testNoOpWhenAlreadyRegistered() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.direct(host: "x.ts.net", port: 4399)
        let identity = try endpoint.credentialIdentity()
        try keychain.set("d1", for: AuthClient.keychainKey(.deviceId, identity: identity))
        try keychain.set("abc", for: AuthClient.keychainKey(.bearer, identity: identity))
        let hitCount = LockBox(0)
        let mock = MockHTTPClient { _ in
            hitCount.withValue { $0 += 1 }
            return (Data(), 200)
        }
        let client = AuthClient(host: "x.ts.net", port: 4399, keychain: keychain, http: mock)
        try await client.registerIfNeeded()
        XCTAssertEqual(hitCount.withValue { $0 }, 0)
    }

    func testRejectsPublicHostBeforeSendingBearer() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in XCTFail("network should not be hit"); return (Data(), 500) }
        let client = AuthClient(host: "example.com", port: 4399, keychain: keychain, http: mock)
        do {
            try await client.registerIfNeeded()
            XCTFail("expected disallowedHost")
        } catch AuthError.disallowedHost {}
    }

    /// Switching hosts now registers the new one without disturbing the old
    /// entry, so returning to the previous host does not have to re-pair.
    func testHostChangeRegistersSeparatelyAndKeepsBoth() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let old = RelayEndpoint.direct(host: "old.ts.net", port: 4399)
        let oldIdentity = try old.credentialIdentity()
        try keychain.set("old", for: AuthClient.keychainKey(.deviceId, identity: oldIdentity))
        try keychain.set("old-token", for: AuthClient.keychainKey(.bearer, identity: oldIdentity))

        let mock = MockHTTPClient { _ in
            (Data(#"{"device_id":"new","token":"new-token"}"#.utf8), 200)
        }
        let client = AuthClient(host: "new.ts.net", port: 4399, keychain: keychain, http: mock)
        try await client.registerIfNeeded()

        let new = RelayEndpoint.direct(host: "new.ts.net", port: 4399)
        XCTAssertEqual(try stored(keychain, .bearer, for: new), "new-token")
        XCTAssertEqual(try stored(keychain, .bearer, for: old), "old-token")
    }

    func testRegisterAPNsTokenPostsBearerAndPayload() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.direct(host: "mac.tailnet.ts.net", port: 4399)
        let identity = try endpoint.credentialIdentity()
        try keychain.set("d1", for: AuthClient.keychainKey(.deviceId, identity: identity))
        try keychain.set("abc", for: AuthClient.keychainKey(.bearer, identity: identity))
        let mock = MockHTTPClient { request in
            XCTAssertEqual(request.url?.absoluteString, "http://mac.tailnet.ts.net:4399/v1/devices/me/apns")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try! XCTUnwrap(request.httpBody)
            let object = try! JSONSerialization.jsonObject(with: body) as! [String: String]
            XCTAssertEqual(object["apns_token"], "00ff10")
            XCTAssertEqual(object["env"], "sandbox")
            return (Data(), 204)
        }
        let client = AuthClient(host: "mac.tailnet.ts.net", port: 4399, keychain: keychain, http: mock)

        try await client.registerAPNsTokenHex("00ff10", environment: .sandbox)
    }

    func testRegisterAPNsTokenRequiresBearerBeforeNetwork() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in XCTFail("network should not be hit"); return (Data(), 500) }
        let client = AuthClient(host: "mac.tailnet.ts.net", port: 4399, keychain: keychain, http: mock)

        do {
            try await client.registerAPNsTokenHex("00ff10", environment: .sandbox)
            XCTFail("expected missingBearer")
        } catch AuthError.missingBearer {}
    }

    func testRegisterAPNsTokenRejectsDisallowedHostBeforeNetwork() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let mock = MockHTTPClient { _ in XCTFail("network should not be hit"); return (Data(), 500) }
        let client = AuthClient(host: "example.com", port: 4399, keychain: keychain, http: mock)

        do {
            try await client.registerAPNsTokenHex("00ff10", environment: .sandbox)
            XCTFail("expected disallowedHost")
        } catch AuthError.disallowedHost {}
    }

    func testBrokerAPNsRegistrationUsesRelayScopedHTTPSRoute() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        let endpoint = RelayEndpoint.broker(
            baseURL: "https://relay.example.com",
            relayId: "home-mac"
        )
        let identity = try endpoint.credentialIdentity()
        try keychain.set("d1", for: AuthClient.keychainKey(.deviceId, identity: identity))
        try keychain.set("abc", for: AuthClient.keychainKey(.bearer, identity: identity))
        let mock = MockHTTPClient { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://relay.example.com/v1/devices/me/apns?relay_id=home-mac"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
            return (Data(), 204)
        }
        let client = AuthClient(endpoint: endpoint, keychain: keychain, http: mock)

        try await client.registerAPNsTokenHex("00ff10", environment: .sandbox)
    }
    func testSameHostDifferentPortsHaveIndependentTokens() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        defer { try? keychain.wipe() }
        let http = MockHTTPClient { request in
            let token = String(request.url!.port!)
            return (Data("{\"device_id\":\"d1\",\"token\":\"\(token)\"}".utf8), 200)
        }
        let first = AuthClient(host: "mac.ts.net", port: 4399, keychain: keychain, http: http)
        let second = AuthClient(host: "mac.ts.net", port: 4400, keychain: keychain, http: http)
        try await first.registerIfNeeded()
        try await second.registerIfNeeded()
        XCTAssertEqual(try first.storedCredentials()?.token, "4399")
        XCTAssertEqual(try second.storedCredentials()?.token, "4400")
    }

    func testFailedRegistrationDoesNotDeleteOtherComputerCredentials() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        defer { try? keychain.wipe() }
        let first = AuthClient(host: "mac.ts.net", port: 4399, keychain: keychain,
                               http: MockHTTPClient { _ in (Data(#"{"device_id":"d1","token":"abc"}"#.utf8), 200) })
        try await first.registerIfNeeded()
        let second = AuthClient(host: "offline.ts.net", port: 4399, keychain: keychain,
                                http: MockHTTPClient { _ in (Data(), 503) })
        do {
            try await second.registerIfNeeded()
            XCTFail("Expected registration failure")
        } catch AuthError.relayRejected(503) {}
        XCTAssertEqual(try first.storedCredentials()?.token, "abc")
        XCTAssertNil(try second.storedCredentials())
    }

    func testCancelledRegistrationCannotRestoreRemovedCredentials() async throws {
        let keychain = Keychain(service: "auth.\(UUID().uuidString)")
        defer { try? keychain.wipe() }
        let started = expectation(description: "Registration started")
        let http = SuspendedRegistrationHTTP { started.fulfill() }
        let auth = AuthClient(host: "office.ts.net", port: 4399, keychain: keychain, http: http)
        let task = Task { try await auth.registerIfNeeded() }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        try auth.wipe()
        await http.finish()
        do {
            try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {}
        XCTAssertNil(try auth.storedCredentials())
    }
}

private actor SuspendedRegistrationHTTP: HTTPClientFacade {
    let onStart: @Sendable () -> Void
    private var continuation: CheckedContinuation<(Data, Int), Never>?

    init(onStart: @escaping @Sendable () -> Void) { self.onStart = onStart }

    func request(_ request: URLRequest) async throws -> (Data, Int) {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            onStart()
        }
    }

    func finish() {
        continuation?.resume(returning: (Data(#"{"device_id":"d1","token":"late-token"}"#.utf8), 200))
        continuation = nil
    }
}

final class MockHTTPClient: HTTPClientFacade, @unchecked Sendable {
    let handler: @Sendable (URLRequest) -> (Data, Int)
    init(handler: @escaping @Sendable (URLRequest) -> (Data, Int)) { self.handler = handler }
    func request(_ request: URLRequest) async throws -> (Data, Int) { handler(request) }
}

final class LockBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func withValue<R>(_ body: (inout T) -> R) -> R {
        lock.lock(); defer { lock.unlock() }
        return body(&value)
    }
}
