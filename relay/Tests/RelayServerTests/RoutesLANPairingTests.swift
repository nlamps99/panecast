import XCTest
import NIOHTTP1
@testable import RelayServer
@testable import RelayCore

/// Covers the LAN pairing path added so a phone on the same Wi-Fi can register
/// without being known to tailscaled.
final class RoutesLANPairingTests: XCTestCase {
    private let lanCode = "lan-secret-code"

    private func makeRoutes(
        _ store: DeviceStore,
        lan: RelayConfig.LAN? = nil,
        limiter: PairingAttemptLimiter = PairingAttemptLimiter()
    ) -> Routes {
        var cfg = RelayConfig.testValue
        cfg.lan = lan
        // Empty peer table: whois rejects everything, so any success below must
        // have come from the LAN path rather than falling through to Tailscale.
        return Routes(deviceStore: store,
                      config: cfg,
                      auth: MockAuthService(peers: [:]),
                      allowLocalhost: false,
                      pairingLimiter: limiter)
    }

    private func body(code: String, clientId: String = "client-1") -> Data {
        Data(#"{"pairing_code":"\#(code)","client_id":"\#(clientId)","device_name":"iPhone"}"#.utf8)
    }

    private struct Registered: Decodable {
        let deviceId: String
        let token: String
        enum CodingKeys: String, CodingKey {
            case deviceId = "device_id", token
        }
    }

    func testRegistersPhoneFromPrivateLANWithCorrectCode() async throws {
        let store = try DeviceStore.empty()
        let routes = makeRoutes(store, lan: .init(pairingCode: lanCode))
        let resp = await routes.handle(method: .POST,
                                       path: "/v1/devices/me/register",
                                       body: body(code: lanCode),
                                       deviceId: nil,
                                       remoteAddr: "192.168.1.42")
        XCTAssertEqual(resp.status, .ok)
        let registered = try JSONDecoder().decode(Registered.self, from: resp.body ?? Data())
        XCTAssertFalse(registered.token.isEmpty)
        XCTAssertTrue(store.validate(deviceId: registered.deviceId, token: registered.token))
    }

    func testRejectsWrongPairingCode() async throws {
        let routes = makeRoutes(try DeviceStore.empty(), lan: .init(pairingCode: lanCode))
        let resp = await routes.handle(method: .POST,
                                       path: "/v1/devices/me/register",
                                       body: body(code: "wrong"),
                                       deviceId: nil,
                                       remoteAddr: "192.168.1.42")
        XCTAssertEqual(resp.status, .forbidden)
    }

    /// The shared code must not be usable from off-LAN: a caller that reached
    /// the port through a port forward is not on the local segment.
    func testRejectsCorrectCodeFromNonPrivateAddress() async throws {
        let routes = makeRoutes(try DeviceStore.empty(), lan: .init(pairingCode: lanCode))
        for address in ["203.0.113.9", "100.64.0.5", "127.0.0.1"] {
            let resp = await routes.handle(method: .POST,
                                           path: "/v1/devices/me/register",
                                           body: body(code: lanCode),
                                           deviceId: nil,
                                           remoteAddr: address)
            XCTAssertEqual(resp.status, .forbidden, "expected \(address) to be rejected")
        }
    }

    func testRejectsWhenLANPairingNotConfigured() async throws {
        let resp = await makeRoutes(try DeviceStore.empty(), lan: nil)
            .handle(method: .POST, path: "/v1/devices/me/register",
                    body: body(code: lanCode), deviceId: nil,
                    remoteAddr: "192.168.1.42")
        XCTAssertEqual(resp.status, .forbidden)
    }

    func testRejectsWhenPairingCodeIsEmpty() async throws {
        let resp = await makeRoutes(try DeviceStore.empty(), lan: .init(pairingCode: ""))
            .handle(method: .POST, path: "/v1/devices/me/register",
                    body: body(code: ""), deviceId: nil,
                    remoteAddr: "192.168.1.42")
        XCTAssertEqual(resp.status, .forbidden)
    }

    func testRateLimitsRepeatedGuesses() async throws {
        let limiter = PairingAttemptLimiter(limit: 3, window: 60, clock: FakeClock())
        let routes = makeRoutes(try DeviceStore.empty(),
                                lan: .init(pairingCode: lanCode),
                                limiter: limiter)
        for _ in 0..<3 {
            let resp = await routes.handle(method: .POST, path: "/v1/devices/me/register",
                                           body: body(code: "guess"), deviceId: nil,
                                           remoteAddr: "192.168.1.42")
            XCTAssertEqual(resp.status, .forbidden)
        }
        let throttled = await routes.handle(method: .POST, path: "/v1/devices/me/register",
                                            body: body(code: "guess"), deviceId: nil,
                                            remoteAddr: "192.168.1.42")
        XCTAssertEqual(throttled.status, .tooManyRequests)
    }

    /// Re-pairing the same handset must land on the same device id, so the Mac's
    /// device list does not grow an entry per reconnect.
    func testSameClientIdIsIdempotent() async throws {
        let store = try DeviceStore.empty()
        let routes = makeRoutes(store, lan: .init(pairingCode: lanCode))
        var ids: [String] = []
        for _ in 0..<2 {
            let resp = await routes.handle(method: .POST, path: "/v1/devices/me/register",
                                           body: body(code: lanCode), deviceId: nil,
                                           remoteAddr: "192.168.1.42")
            XCTAssertEqual(resp.status, .ok)
            ids.append(try JSONDecoder().decode(Registered.self, from: resp.body ?? Data()).deviceId)
        }
        XCTAssertEqual(ids[0], ids[1])
        XCTAssertEqual(store.allDevices().count, 1)
    }

    /// A body that is not a pairing request must fall through to whois rather
    /// than being treated as an anonymous LAN attempt.
    func testUnparseableBodyFallsThroughToWhois() async throws {
        let routes = makeRoutes(try DeviceStore.empty(), lan: .init(pairingCode: lanCode))
        let resp = await routes.handle(method: .POST, path: "/v1/devices/me/register",
                                       body: Data(#"{"unrelated":true}"#.utf8),
                                       deviceId: nil, remoteAddr: "192.168.1.42")
        XCTAssertEqual(resp.status, .forbidden)
    }

    /// Tailscale pairing sends no body and must be unaffected by the LAN branch.
    func testTailnetPairingStillWorksWithLANConfigured() async throws {
        let store = try DeviceStore.empty()
        var cfg = RelayConfig.testValue
        cfg.lan = .init(pairingCode: lanCode)
        cfg.allowLogin = ["a@b"]
        let routes = Routes(
            deviceStore: store,
            config: cfg,
            auth: MockAuthService(peers: [
                "100.64.0.5": .init(loginName: "a@b", hostname: "iPhone", os: "ios", nodeKey: "nk1"),
            ]),
            allowLocalhost: false
        )
        let resp = await routes.handle(method: .POST, path: "/v1/devices/me/register",
                                       body: nil, deviceId: nil, remoteAddr: "100.64.0.5")
        XCTAssertEqual(resp.status, .ok)
    }

    func testSecretsMatchIsLengthAndContentSensitive() {
        XCTAssertTrue(Routes.secretsMatch("abc123", "abc123"))
        XCTAssertFalse(Routes.secretsMatch("abc123", "abc124"))
        XCTAssertFalse(Routes.secretsMatch("abc123", "abc1234"))
        XCTAssertFalse(Routes.secretsMatch("", ""))
    }
}
