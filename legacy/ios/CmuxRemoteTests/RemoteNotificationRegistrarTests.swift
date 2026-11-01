import Foundation
import XCTest
import UserNotifications
import UIKit
@testable import CmuxRemote

@MainActor
final class RemoteNotificationRegistrarTests: XCTestCase {
    func testDeviceTokenDataConvertsToLowercaseHex() {
        let data = Data([0x00, 0x0f, 0x10, 0xab, 0xff])

        XCTAssertEqual(RemoteNotificationRegistrar.tokenHex(from: data), "000f10abff")
    }

    func testRegisterForRemoteNotificationsContinuesWhenSettingsAreStillNotDetermined() async {
        let center = FakeRemoteNotificationAuthorizationCenter(status: .notDetermined)
        let application = FakeRemoteNotificationApplication()
        let registrar = RemoteNotificationRegistrar(notificationCenter: center, application: application)

        await registrar.registerForRemoteNotifications()

        XCTAssertEqual(application.registerCallCount, 1)
    }

    func testRegisterForRemoteNotificationsSkipsDeniedAuthorization() async {
        let center = FakeRemoteNotificationAuthorizationCenter(status: .denied)
        let application = FakeRemoteNotificationApplication()
        let registrar = RemoteNotificationRegistrar(notificationCenter: center, application: application)

        await registrar.registerForRemoteNotifications()

        XCTAssertEqual(application.registerCallCount, 0)
    }

    func testSwitchingRelayForwardsCachedAPNsTokenWithItsOwnBearer() async throws {
        let center = FakeRemoteNotificationAuthorizationCenter(status: .authorized)
        let application = FakeRemoteNotificationApplication()
        let registrar = RemoteNotificationRegistrar(notificationCenter: center, application: application)
        let keychain = Keychain(service: "apns-switch.\(UUID().uuidString)")
        defer { try? keychain.wipe() }
        let officePosted = expectation(description: "Office token registered")
        let homePosted = expectation(description: "Home token registered")
        let http = MockHTTPClient { request in
            let host = request.url!.host!
            if request.url!.path.hasSuffix("/register") {
                return (Data("{\"device_id\":\"d1\",\"token\":\"\(host)\"}".utf8), 200)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(host)")
            let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
            XCTAssertEqual(body["apns_token"], "00ff")
            if host == "office.ts.net" { officePosted.fulfill() } else { homePosted.fulfill() }
            return (Data(), 204)
        }
        let office = AuthClient(host: "office.ts.net", port: 4399, keychain: keychain, http: http)
        let home = AuthClient(host: "home.ts.net", port: 4399, keychain: keychain, http: http)
        try await office.registerIfNeeded()
        try await home.registerIfNeeded()
        registrar.application(UIApplication.shared, didRegisterForRemoteNotificationsWithDeviceToken: Data([0x00, 0xff]))
        registrar.configure(authClient: office)
        await fulfillment(of: [officePosted], timeout: 2)
        registrar.configure(authClient: nil)
        registrar.configure(authClient: home)
        await fulfillment(of: [homePosted], timeout: 2)
        registrar.configure(authClient: nil)
    }
}

@MainActor
private final class FakeRemoteNotificationAuthorizationCenter: RemoteNotificationAuthorizationCenter {
    var delegate: UNUserNotificationCenterDelegate?
    var status: UNAuthorizationStatus

    init(status: UNAuthorizationStatus) {
        self.status = status
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        status
    }
}

@MainActor
private final class FakeRemoteNotificationApplication: RemoteNotificationApplication {
    private(set) var registerCallCount = 0

    func registerForRemoteNotifications() {
        registerCallCount += 1
    }
}
