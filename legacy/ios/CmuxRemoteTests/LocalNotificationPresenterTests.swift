import XCTest
import UserNotifications
import SharedKit
@testable import CmuxRemote

@MainActor
final class LocalNotificationPresenterTests: XCTestCase {
    func testNotificationsWithSameIDOnDifferentRelaysStayDistinct() async {
        let center = FakeNotificationCenter()
        center.status = .authorized
        let delivered = expectation(description: "Both notifications delivered")
        delivered.expectedFulfillmentCount = 2
        center.onAdd = { delivered.fulfill() }
        let presenter = LocalNotificationPresenter(notificationCenter: center)
        let record = NotificationRecord(id: "same-id", workspaceId: "same-workspace", surfaceId: nil,
                                        title: "Needs input", subtitle: nil, body: "", ts: 1, threadId: "same-thread")
        presenter.present(record, relayEndpoint: "http://office.ts.net:4399")
        presenter.present(record, relayEndpoint: "http://home.ts.net:4399")
        await fulfillment(of: [delivered], timeout: 2)
        XCTAssertEqual(Set(center.addedRequests.map(\.identifier)).count, 2)
        XCTAssertEqual(Set(center.addedRequests.map { $0.content.threadIdentifier }).count, 2)
        XCTAssertEqual(Set(center.addedRequests.compactMap { $0.content.userInfo["relay_endpoint"] as? String }),
                       ["http://office.ts.net:4399", "http://home.ts.net:4399"])
    }

    func testConcurrentAuthorizationCallsShareInFlightPromptResult() async {
        let notificationCenter = FakeNotificationCenter()
        let presenter = LocalNotificationPresenter(notificationCenter: notificationCenter)

        async let first = presenter.requestAuthorizationIfNeeded()
        await notificationCenter.waitUntilRequestStarted()

        async let second = presenter.requestAuthorizationIfNeeded()
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(notificationCenter.requestCount, 1)
        notificationCenter.grantAuthorization()

        let results = await (first, second)
        XCTAssertTrue(results.0)
        XCTAssertTrue(results.1)
        XCTAssertEqual(notificationCenter.requestCount, 1)
    }
}

@MainActor
private final class FakeNotificationCenter: NotificationCenterFacade {
    var status: UNAuthorizationStatus = .notDetermined
    private(set) var requestCount = 0
    private var requestStartedContinuation: CheckedContinuation<Void, Never>?
    private var authorizationContinuation: CheckedContinuation<Bool, Never>?
    private(set) var addedRequests: [UNNotificationRequest] = []
    var onAdd: (() -> Void)?

    func authorizationStatus() async -> UNAuthorizationStatus {
        status
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        requestCount += 1
        requestStartedContinuation?.resume()
        requestStartedContinuation = nil
        return await withCheckedContinuation { continuation in
            authorizationContinuation = continuation
        }
    }

    func add(_ request: UNNotificationRequest) async throws {
        addedRequests.append(request)
        onAdd?()
    }

    func waitUntilRequestStarted() async {
        if requestCount > 0 { return }
        await withCheckedContinuation { continuation in
            requestStartedContinuation = continuation
        }
    }

    func grantAuthorization() {
        status = .authorized
        authorizationContinuation?.resume(returning: true)
        authorizationContinuation = nil
    }
}
