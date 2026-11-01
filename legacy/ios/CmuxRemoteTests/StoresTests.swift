import XCTest
import SharedKit
@testable import CmuxRemote

@MainActor
final class StoresTests: XCTestCase {
    /// cmux scopes `workspace.list` to one window. A second open window used to
    /// be invisible on iOS because the app never passed `window_id`.
    private func multiWindowStub() -> StubRPCDispatch {
        StubRPCDispatch(
            windows: [
                ("win-a-uuid", "window:1", false),
                ("win-b-uuid", "window:2", true),
            ],
            workspacesByWindow: [
                "win-a-uuid": [("wa1", "Alpha"), ("wa2", "Beta")],
                "win-b-uuid": [("wb1", "Gamma")],
            ]
        )
    }

    func testRefreshLoadsWindowsAndDefaultsToTheKeyWindow() async {
        let store = WorkspaceStore(rpc: multiWindowStub())

        await store.refresh()

        XCTAssertEqual(store.windows.map(\.ref), ["window:1", "window:2"])
        XCTAssertEqual(store.selectedWindowId, "win-b-uuid")
        XCTAssertEqual(store.selectedWindow?.ref, "window:2")
        XCTAssertEqual(store.workspaces.map(\.name), ["Gamma"])
    }

    func testWorkspaceListIsScopedToTheSelectedWindow() async {
        let rpc = multiWindowStub()
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()

        await store.selectWindow(id: "win-a-uuid")

        XCTAssertEqual(store.workspaces.map(\.name), ["Alpha", "Beta"])
        XCTAssertEqual(store.selectedId, "wa1")
        let scoped = await rpc.calls.filter { $0.method == "workspace.list" }
        guard case .object(let params) = scoped.last?.params,
              case .string(let windowId)? = params["window_id"]
        else { return XCTFail("workspace.list must carry window_id") }
        XCTAssertEqual(windowId, "win-a-uuid")
    }

    func testWindowCountsComeFromWindowList() async {
        let store = WorkspaceStore(rpc: multiWindowStub())
        await store.refresh()
        XCTAssertEqual(store.windows.map(\.workspaceCount), [2, 1])
        XCTAssertEqual(store.windows.map(\.isKey), [false, true])
    }

    /// Older cmux builds have no `window.list`. The app must keep listing the
    /// key window's workspaces with no `window_id` rather than showing nothing.
    func testMissingWindowListFallsBackToUnscopedWorkspaceList() async {
        let rpc = StubRPCDispatch()
        let store = WorkspaceStore(rpc: rpc)

        await store.refresh()

        XCTAssertTrue(store.windows.isEmpty)
        XCTAssertNil(store.selectedWindowId)
        XCTAssertEqual(store.workspaces.map(\.name), ["Demo"])
        XCTAssertEqual(store.connection, .connected)
        let listCalls = await rpc.calls.filter { $0.method == "workspace.list" }
        guard case .object(let params) = listCalls.first?.params else {
            return XCTFail("expected object params")
        }
        XCTAssertNil(params["window_id"])
    }

    func testCreateWorkspaceTargetsTheSelectedWindow() async throws {
        let rpc = multiWindowStub()
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()
        await store.selectWindow(id: "win-a-uuid")

        try await store.create(name: "New One")

        let creates = await rpc.calls.filter { $0.method == "workspace.create" }
        guard case .object(let params) = creates.first?.params,
              case .string(let windowId)? = params["window_id"]
        else { return XCTFail("workspace.create must carry window_id") }
        XCTAssertEqual(windowId, "win-a-uuid")
    }

    func testSwitchingWindowClearsStaleWorkspaceSelection() async {
        let store = WorkspaceStore(rpc: multiWindowStub())
        await store.refresh()
        XCTAssertEqual(store.selectedId, "wb1")

        await store.selectWindow(id: "win-a-uuid")

        // Workspace ids belong to their owning window, so a stale id must not
        // survive the switch.
        XCTAssertNotEqual(store.selectedId, "wb1")
        XCTAssertEqual(store.selectedId, "wa1")
    }

    func testWorkspaceRefreshLoadsSurfaces() async {
        let rpc = StubRPCDispatch()
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()
        XCTAssertEqual(store.workspaces.first?.name, "Demo")
        XCTAssertEqual(store.surfaceCount(for: "w1"), 1)
        XCTAssertEqual(store.connection, .connected)
    }


    func testWorkspaceRefreshEmitsClaudeCodeNeedsInputAlertFromWorkspaceListStatus() async {
        let rpc = StubRPCDispatch(
            workspaces: [("w1", "말겨봐")],
            workspaceExtras: [
                "w1": [
                    "agent": .string("Claude Code"),
                    "status": .string("Claude is waiting for your input"),
                    "summary": .string("Claude needs your permission"),
                    "active_surface_id": .string("s1"),
                ],
            ]
        )
        let store = WorkspaceStore(rpc: rpc)
        var alerts: [NotificationRecord] = []
        store.onWorkspaceAlert = { alerts.append($0) }

        await store.refresh()

        XCTAssertEqual(alerts.count, 1)
        XCTAssertEqual(alerts.first?.workspaceId, "w1")
        XCTAssertEqual(alerts.first?.surfaceId, "s1")
        XCTAssertEqual(alerts.first?.title, "Claude Code needs input")
        XCTAssertEqual(alerts.first?.body, "Claude is waiting for your input")
        XCTAssertTrue(alerts.first?.id.contains("workspace-alert") ?? false)
    }

    func testEndpointPolicyAllowsTailnetAndPrivateLANHosts() {
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("mac.tailnet.ts.net"))
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("100.115.102.6"))
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("192.168.1.5"))
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("10.0.0.9"))
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("172.16.4.2"))
        XCTAssertTrue(EndpointPolicy.isAllowedRelayHost("mac.local"))
        XCTAssertFalse(EndpointPolicy.isAllowedRelayHost("example.com"))
        XCTAssertFalse(EndpointPolicy.isAllowedRelayHost("8.8.8.8"))
        XCTAssertFalse(EndpointPolicy.isAllowedRelayHost("172.32.0.1"))
    }

    /// Only LAN hosts need a pairing code; a tailnet host proves identity to the
    /// relay through Tailscale itself.
    func testPrivateLANHostClassification() {
        XCTAssertTrue(EndpointPolicy.isPrivateLANHost("192.168.1.5"))
        XCTAssertTrue(EndpointPolicy.isPrivateLANHost("169.254.3.4"))
        XCTAssertTrue(EndpointPolicy.isPrivateLANHost("MAC.LOCAL"))
        XCTAssertFalse(EndpointPolicy.isPrivateLANHost(".local"))
        XCTAssertFalse(EndpointPolicy.isPrivateLANHost("mac.tailnet.ts.net"))
        XCTAssertFalse(EndpointPolicy.isPrivateLANHost("100.115.102.6"))
        XCTAssertFalse(EndpointPolicy.isPrivateLANHost("127.0.0.1"))
        XCTAssertFalse(EndpointPolicy.isPrivateLANHost(""))
    }

    func testRequiresPairingCodeOnlyForLANAndBroker() {
        XCTAssertFalse(RelayEndpoint.direct(host: "mac.tailnet.ts.net", port: 4399).requiresPairingCode)
        XCTAssertTrue(RelayEndpoint.direct(host: "192.168.1.5", port: 4399).requiresPairingCode)
        XCTAssertTrue(
            RelayEndpoint.broker(baseURL: "https://relay.example.com", relayId: "m").requiresPairingCode
        )
    }

    /// The workspace list badge is driven by this mapping, and the plaintext flag
    /// is what marks the LAN path as unencrypted.
    func testActiveTransportMapping() {
        XCTAssertEqual(RelayEndpoint.direct(host: "192.168.1.5", port: 4399).activeTransport, .lan)
        XCTAssertEqual(RelayEndpoint.direct(host: "mac.local", port: 4399).activeTransport, .lan)
        XCTAssertEqual(
            RelayEndpoint.direct(host: "mac.tailnet.ts.net", port: 4399).activeTransport,
            .tailscale
        )
        XCTAssertEqual(RelayEndpoint.direct(host: "100.115.102.6", port: 4399).activeTransport, .tailscale)
        XCTAssertEqual(
            RelayEndpoint.broker(baseURL: "https://relay.example.com", relayId: "m").activeTransport,
            .broker
        )

        XCTAssertTrue(ActiveTransport.lan.isPlaintext)
        XCTAssertFalse(ActiveTransport.tailscale.isPlaintext)
        XCTAssertFalse(ActiveTransport.broker.isPlaintext)
    }

    func testResetClearsActiveTransport() async {
        let store = WorkspaceStore(rpc: OfflineRPCDispatch())
        store.activeTransport = .lan
        store.reset()
        XCTAssertNil(store.activeTransport)
    }

    func testEndpointPolicyRequiresTLSForPublicBroker() {
        XCTAssertTrue(EndpointPolicy.isAllowedBrokerURL("https://relay.example.com"))
        XCTAssertTrue(EndpointPolicy.isAllowedBrokerURL("wss://relay.example.com/cmux"))
        XCTAssertTrue(EndpointPolicy.isAllowedBrokerURL("http://localhost:4398"))
        XCTAssertFalse(EndpointPolicy.isAllowedBrokerURL("http://relay.example.com"))
        XCTAssertFalse(EndpointPolicy.isAllowedBrokerURL("relay.example.com"))
    }

    func testBrokerEndpointBuildsHTTPAndWebSocketRoutes() throws {
        let endpoint = RelayEndpoint.broker(
            baseURL: "https://relay.example.com/cmux/",
            relayId: "home mac"
        )
        XCTAssertEqual(
            try endpoint.registrationURL().absoluteString,
            "https://relay.example.com/cmux/v1/devices/me/register"
        )
        XCTAssertEqual(
            try endpoint.webSocketURL().absoluteString,
            "wss://relay.example.com/cmux/v1/ws?relay_id=home%20mac"
        )
        XCTAssertEqual(
            try endpoint.apnsURL().absoluteString,
            "https://relay.example.com/cmux/v1/devices/me/apns?relay_id=home%20mac"
        )
    }


    func testWorkspaceStoreCreatesSurfaceAndSelectsReturnedSurface() async throws {
        let rpc = StubRPCDispatch()
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()

        let surface = try await store.createSurface(workspaceId: "w1")

        XCTAssertEqual(surface.id, "s2")
        XCTAssertEqual(store.surfaceCount(for: "w1"), 2)
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.create",
                  case .object(let params) = call.params,
                  case .string("w1")? = params["workspace_id"],
                  case .string("terminal")? = params["type"]
            else { return false }
            return true
        })
    }

    func testWorkspaceStoreClosesSurfaceAndRefreshesList() async throws {
        let rpc = StubRPCDispatch(surfaces: [("s1", "shell"), ("s2", "logs")])
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()

        try await store.closeSurface(workspaceId: "w1", surfaceId: "s1")

        XCTAssertEqual(store.surfaces(for: "w1").map(\.id), ["s2"])
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.close",
                  case .object(let params) = call.params,
                  case .string("w1")? = params["workspace_id"],
                  case .string("s1")? = params["surface_id"]
            else { return false }
            return true
        })
    }


    func testWorkspaceStoreCreatesWorkspaceWithRequestedTitle() async throws {
        let rpc = StubRPCDispatch(workspaces: [("w1", "Demo")])
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()

        try await store.create(name: "요술마켓")

        XCTAssertEqual(store.workspaces.map(\.name), ["Demo", "요술마켓"])
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "workspace.create",
                  case .object(let params) = call.params,
                  case .string("요술마켓")? = params["title"]
            else { return false }
            return true
        })
    }

    func testWorkspaceStoreRenamesWorkspaceWithTitleParam() async throws {
        let rpc = StubRPCDispatch(workspaces: [("w1", "Demo"), ("w2", "Logs")])
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()

        try await store.rename(workspaceId: "w2", title: "빌드 로그")

        XCTAssertEqual(store.workspaces.map(\.name), ["Demo", "빌드 로그"])
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "workspace.rename",
                  case .object(let params) = call.params,
                  case .string("w2")? = params["workspace_id"],
                  case .string("빌드 로그")? = params["title"]
            else { return false }
            return true
        })
    }

    func testWorkspaceStoreClosesWorkspaceAndRefreshesSelection() async throws {
        let rpc = StubRPCDispatch(workspaces: [("w1", "Demo"), ("w2", "Logs")])
        let store = WorkspaceStore(rpc: rpc)
        await store.refresh()
        store.selectedId = "w1"

        try await store.close(workspaceId: "w1")

        XCTAssertEqual(store.workspaces.map(\.id), ["w2"])
        XCTAssertEqual(store.selectedId, "w2")
        XCTAssertNil(store.surfacesByWorkspaceId["w1"])
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "workspace.close",
                  case .object(let params) = call.params,
                  case .string("w1")? = params["workspace_id"]
            else { return false }
            return true
        })
    }

    func testStoresResetDisconnectState() async {
        let rpc = StubRPCDispatch()
        let workspaceStore = WorkspaceStore(rpc: rpc)
        await workspaceStore.refresh()
        workspaceStore.reset()
        XCTAssertEqual(workspaceStore.workspaces.count, 0)
        XCTAssertEqual(workspaceStore.connection, .disconnected)

        let surfaceStore = SurfaceStore(rpc: rpc)
        await surfaceStore.subscribe(workspaceId: "w1", surfaceId: "s1")
        surfaceStore.reset()
        XCTAssertNil(surfaceStore.subscribed)
        XCTAssertEqual(surfaceStore.grid.rows.count, 24)
    }

    func testSurfaceSubscribeRequestsBoundedTerminalHistory() async {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)

        await surfaceStore.subscribe(workspaceId: "w1", surfaceId: "s1")

        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.subscribe",
                  case .object(let params) = call.params,
                  case .int(let lines)? = params["lines"]
            else { return false }
            return lines == Int64(SurfaceStore.defaultSubscriptionLines)
        })
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.read_text",
                  case .object(let params) = call.params,
                  case .int(let lines)? = params["lines"]
            else { return false }
            return lines == Int64(SurfaceStore.defaultSubscriptionLines)
        })
    }

    func testSurfaceResubscribeRequestsBoundedTerminalHistory() async {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)
        surfaceStore.subscribedWorkspaceId = "w1"
        surfaceStore.subscribed = "s1"

        await surfaceStore.resubscribe()

        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.subscribe",
                  case .object(let params) = call.params,
                  case .int(let lines)? = params["lines"]
            else { return false }
            return lines == Int64(SurfaceStore.defaultSubscriptionLines)
        })
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.read_text",
                  case .object(let params) = call.params,
                  case .int(let lines)? = params["lines"]
            else { return false }
            return lines == Int64(SurfaceStore.defaultSubscriptionLines)
        })
    }

    func testChangingTerminalHistoryRefreshesTheActiveSubscription() async {
        let key = "cmux.terminalHistoryLines"
        let defaults = UserDefaults.standard
        let previousValue = defaults.object(forKey: key)
        defer {
            if let previousValue {
                defaults.set(previousValue, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
        defaults.set(240, forKey: key)

        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)
        await surfaceStore.subscribe(workspaceId: "w1", surfaceId: "s1")
        await surfaceStore.refreshSubscriptionPreferences()

        let calls = await rpc.calls
        XCTAssertEqual(calls.filter { $0.method == "surface.unsubscribe" }.count, 1)
        XCTAssertEqual(calls.filter { $0.method == "surface.subscribe" }.count, 2)
        XCTAssertTrue(calls.filter { $0.method == "surface.subscribe" }.allSatisfy { call in
            guard case .object(let params) = call.params,
                  case .int(let lines)? = params["lines"]
            else { return false }
            return lines == 240
        })
        XCTAssertEqual(surfaceStore.subscribedWorkspaceId, "w1")
        XCTAssertEqual(surfaceStore.subscribed, "s1")
    }

    func testCursorHistoryPrependsOlderRowsAndCanResumeLiveOutput() async {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)
        await surfaceStore.subscribe(workspaceId: "w1", surfaceId: "s1")

        await surfaceStore.loadOlderHistory()
        XCTAssertEqual(surfaceStore.historyRows, ["older-2"])
        XCTAssertEqual(surfaceStore.historyAnchorRows, ["fresh"])
        XCTAssertNotNil(surfaceStore.historyNextCursor)
        let originalTopPageID = surfaceStore.historyPages.first?.id
        XCTAssertEqual(surfaceStore.historyRestoreAnchorID, SurfaceStore.liveHistoryAnchorID)

        await surfaceStore.loadOlderHistory()
        XCTAssertEqual(surfaceStore.historyRows, ["older-1", "older-2"])
        XCTAssertNil(surfaceStore.historyNextCursor)
        XCTAssertEqual(surfaceStore.historyRestoreAnchorID, originalTopPageID)

        surfaceStore.resumeLiveHistory()
        XCTAssertTrue(surfaceStore.historyRows.isEmpty)
        XCTAssertNil(surfaceStore.historyAnchorRows)
    }

    func testSurfaceStoreSendsTextAndKeys() async throws {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)

        try await surfaceStore.sendText(workspaceId: "w1", surfaceId: "s1", text: "ls\n")
        try await surfaceStore.sendKey(workspaceId: "w1", surfaceId: "s1", key: .named("c", modifiers: [.ctrl]))

        let calls = await rpc.calls
        XCTAssertEqual(calls.map(\.method), ["surface.send_text", "surface.focus", "surface.send_key"])
        XCTAssertEqual(surfaceStore.inputStatus, .sent("Sent ctrl-c"))
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.send_text",
                  case .object(let params) = call.params,
                  case .string("ls\n")? = params["text"]
            else { return false }
            return true
        })
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.focus",
                  case .object(let params) = call.params,
                  case .string("w1")? = params["workspace_id"],
                  case .string("s1")? = params["surface_id"]
            else { return false }
            return true
        })
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.send_key",
                  case .object(let params) = call.params,
                  case .string("ctrl-c")? = params["key"]
            else { return false }
            return true
        })
    }

    func testSurfaceStoreSubmitsCommandAsTextThenEnter() async throws {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)

        try await surfaceStore.submitCommand(workspaceId: "w1", surfaceId: "s1", command: "pwd")

        let calls = await rpc.calls
        XCTAssertEqual(calls.suffix(2).map(\.method), ["surface.send_text", "surface.send_key"])
        XCTAssertEqual(surfaceStore.inputStatus, .sent("Sent pwd"))
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.send_text",
                  case .object(let params) = call.params,
                  case .string("pwd")? = params["text"]
            else { return false }
            return true
        })
        XCTAssertTrue(calls.contains { call in
            guard call.method == "surface.send_key",
                  case .object(let params) = call.params,
                  case .string("enter")? = params["key"]
            else { return false }
            return true
        })
    }

    func testSurfaceStoreUploadsFileAndReportsPath() async throws {
        let rpc = StubRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)

        let payload = try await surfaceStore.uploadFile(
            data: Data([0x01, 0x02, 0x03]),
            filename: "photo.jpg",
            mimeType: "image/jpeg"
        )

        XCTAssertEqual(payload.path, "/Users/demo/Downloads/cmux-remote/photo.jpg")
        XCTAssertEqual(surfaceStore.inputStatus, .sent("Attached photo.jpg"))
        let calls = await rpc.calls
        XCTAssertTrue(calls.contains { call in
            guard call.method == "file.upload",
                  case .object(let params) = call.params,
                  case .string("photo.jpg")? = params["filename"],
                  case .string("image/jpeg")? = params["mime_type"],
                  case .string(Data([0x01, 0x02, 0x03]).base64EncodedString())? = params["data_base64"]
            else { return false }
            return true
        })
    }

    func testHostStatusStoreRefreshesBattery() async {
        let rpc = StubRPCDispatch()
        let store = HostStatusStore(rpc: rpc)

        await store.refreshBattery()

        XCTAssertEqual(store.battery.percent, 88)
        XCTAssertEqual(store.battery.displayText, "88% ↯")
    }

    func testSurfaceStoreReportsInputDispatchFailure() async {
        let rpc = FailingRPCDispatch()
        let surfaceStore = SurfaceStore(rpc: rpc)

        do {
            try await surfaceStore.sendText(workspaceId: "w1", surfaceId: "s1", text: "ls\n")
            XCTFail("Expected sendText to throw")
        } catch {
            guard case .failed(let message) = surfaceStore.inputStatus else {
                return XCTFail("Expected failed status, got \(surfaceStore.inputStatus)")
            }
            XCTAssertTrue(message.contains("closed") || message.contains("offline"))
        }
    }


    func testNotificationStoreIngestsFullNotificationEvent() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object([
                "id": .string("n1"),
                "workspace_id": .string("w1"),
                "surface_id": .string("s1"),
                "title": .string("작업 완료"),
                "subtitle": .string("요술마켓"),
                "body": .string("테스트가 끝났습니다."),
                "ts": .int(42),
                "thread_id": .string("th1"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.id, "n1")
        XCTAssertEqual(store.items.first?.workspaceId, "w1")
        XCTAssertEqual(store.items.first?.surfaceId, "s1")
        XCTAssertEqual(store.items.first?.title, "작업 완료")
    }

    func testNotificationStoreKeepsPartialCmuxNotificationEventsVisible() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object([
                "id": .string("n-partial"),
                "workspace_id": .string("w1"),
                "message": .string("새 알림이 도착했습니다."),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.id, "n-partial")
        XCTAssertEqual(store.items.first?.workspaceId, "w1")
        XCTAssertEqual(store.items.first?.title, "cmux 알림")
        XCTAssertEqual(store.items.first?.body, "새 알림이 도착했습니다.")
        XCTAssertEqual(store.items.first?.threadId, "workspace-w1")
    }

    func testNotificationStoreStoresGenericNotificationCreatedWithoutOnNew() {
        let store = NotificationStore()
        var observed: [NotificationRecord] = []
        store.onNew = { record in observed.append(record) }
        let frame = PushFrame.event(EventFrame(
            category: .notification,
            name: "notification.created",
            payload: .object([
                "id": .string("generic-1"),
                "workspace_id": .string("w1"),
                "title": .string("Build finished"),
                "body": .string("Generic notification"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertEqual(observed.count, 0)
    }

    func testNotificationStoreSuppressesLocalCallbackWhenDisabled() {
        let store = NotificationStore()
        store.localNotificationsEnabled = false
        var observed: [NotificationRecord] = []
        store.onNew = { record in observed.append(record) }
        let frame = PushFrame.event(EventFrame(
            category: .surface,
            name: "claude.needs_input",
            payload: .object([
                "id": .string("need-disabled"),
                "workspace_id": .string("w1"),
                "surface_id": .string("s1"),
                "title": .string("Claude Code"),
                "body": .string("needs input"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertEqual(observed.count, 0)
    }

    func testNotificationStoreFiresLocalCallbackForNeedsInputWhenEnabled() {
        let store = NotificationStore()
        var observed: [NotificationRecord] = []
        store.onNew = { record in observed.append(record) }
        let frame = PushFrame.event(EventFrame(
            category: .surface,
            name: "claude.needs_input",
            payload: .object([
                "id": .string("need-enabled"),
                "workspace_id": .string("w1"),
                "surface_id": .string("s1"),
                "title": .string("Claude Code"),
                "body": .string("needs input"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertEqual(observed.map(\.id), ["need-enabled"])
    }

    func testNotificationStoreMarkAllReadClearsUnreadCounts() {
        let store = NotificationStore()
        store.append(NotificationRecord(id: "n1", workspaceId: "w1", surfaceId: nil, title: "t1", subtitle: nil, body: "b1", ts: 1, threadId: "th1"))
        store.append(NotificationRecord(id: "n2", workspaceId: "w2", surfaceId: nil, title: "t2", subtitle: nil, body: "b2", ts: 2, threadId: "th2"))

        XCTAssertEqual(store.unreadCount, 2)

        store.markAllRead()

        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertTrue(store.unreadByWorkspace.isEmpty)
    }

    func testNotificationStoreDefaultAppendIsInboxOnly() {
        let store = NotificationStore()
        var observed: [NotificationRecord] = []
        store.onNew = { record in observed.append(record) }

        store.append(NotificationRecord(id: "demo-1", workspaceId: "w1", surfaceId: nil, title: "demo", subtitle: nil, body: "inbox only", ts: 1, threadId: "th1"))

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertTrue(observed.isEmpty)
    }

    func testNotificationStoreIgnoresNonNotificationEvents() {
        let store = NotificationStore()
        store.ingest(.event(EventFrame(
            category: .workspace,
            name: "workspace.updated",
            payload: .object(["id": .string("w1")])
        )))

        XCTAssertTrue(store.items.isEmpty)
    }

    func testNotificationStoreIngestsClaudeNeedsInputEvent() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .surface,
            name: "claude.needs_input",
            payload: .object([
                "workspace_id": .string("w1"),
                "surface_id": .string("s1"),
                "title": .string("Claude Code"),
                "body": .string("needs input"),
                "id": .string("need-1"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.id, "need-1")
        XCTAssertEqual(store.items.first?.workspaceId, "w1")
        XCTAssertEqual(store.items.first?.surfaceId, "s1")
        XCTAssertEqual(store.items.first?.title, "Claude Code")
        XCTAssertEqual(store.items.first?.body, "needs input")
    }

    func testNotificationStoreDedupesNeedsInputWithoutExplicitId() {
        let store = NotificationStore()
        var fired: [String] = []
        store.onNew = { record in fired.append(record.id) }
        let frame = PushFrame.event(EventFrame(
            category: .unknown,
            name: "surface.needs-input",
            payload: .object([
                "workspaceId": .string("w1"),
                "surfaceId": .string("s1"),
                "source": .string("Claude Code"),
                "status": .string("needs input"),
            ])
        ))

        store.ingest(frame)
        store.ingest(frame)

        XCTAssertEqual(store.items.count, 2)
        XCTAssertEqual(fired.count, 1)
        XCTAssertEqual(store.items.first?.id, fired.first)
        XCTAssertEqual(store.items.first?.title, "Claude Code needs input")
        XCTAssertEqual(store.items.first?.body, "needs input")
    }

    func testNotificationStoreIngestsNestedClaudeNeedsAttentionEvent() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .unknown,
            name: "notification",
            payload: .object([
                "workspace": .string("w2"),
                "surface": .string("s2"),
                "details": .object([
                    "message": .string("Claude Code needs your attention"),
                ]),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.workspaceId, "w2")
        XCTAssertEqual(store.items.first?.surfaceId, "s2")
        XCTAssertEqual(store.items.first?.title, "Claude Code needs input")
        XCTAssertEqual(store.items.first?.body, "Claude Code needs your attention")
    }

    func testNotificationStoreIngestsCodexHookPermissionPromptEvent() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .hook,
            name: "codex.permission_prompt",
            payload: .object([
                "workspace_id": .string("w3"),
                "surface_id": .string("s3"),
                "source": .string("Codex"),
                "message": .string("approval required"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.workspaceId, "w3")
        XCTAssertEqual(store.items.first?.surfaceId, "s3")
        XCTAssertEqual(store.items.first?.title, "Codex needs input")
        XCTAssertEqual(store.items.first?.body, "approval required")
    }

    func testNotificationStoreDoesNotAlarmGenericApprovalNoise() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .workspace,
            name: "workspace.updated",
            payload: .object([
                "workspace_id": .string("w4"),
                "source": .string("billing"),
                "message": .string("approval required"),
            ])
        ))

        store.ingest(frame)

        XCTAssertTrue(store.items.isEmpty)
    }

    func testNotificationStoreLabelsUnknownHookNeedsInputAsCmuxHook() {
        let store = NotificationStore()
        let frame = PushFrame.event(EventFrame(
            category: .hook,
            name: "surface.needs-input",
            payload: .object([
                "workspace_id": .string("w5"),
                "message": .string("needs input"),
            ])
        ))

        store.ingest(frame)

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items.first?.title, "cmux hook needs input")
        XCTAssertEqual(store.items.first?.body, "needs input")
    }

    func testNotificationStoreFiresOnNewOnceForRepeatedNeedsInputId() {
        let store = NotificationStore()
        var fired: [String] = []
        store.onNew = { record in fired.append(record.id) }

        let frame = PushFrame.event(EventFrame(
            category: .surface,
            name: "surface.needs-input",
            payload: .object([
                "id": .string("dup-1"),
                "workspace_id": .string("w1"),
                "source": .string("Claude Code"),
                "body": .string("needs input"),
            ])
        ))

        store.ingest(frame)
        store.ingest(frame)

        XCTAssertEqual(fired, ["dup-1"])
    }

    func testNotificationStoreCapsNewestFirst() {
        let store = NotificationStore()
        for i in 0..<205 {
            store.append(NotificationRecord(id: "n\(i)", workspaceId: "w", surfaceId: nil, title: "t\(i)", subtitle: nil, body: "b", ts: Int64(i), threadId: "th"))
        }
        XCTAssertEqual(store.items.count, 200)
        XCTAssertEqual(store.items.first?.id, "n204")
        XCTAssertEqual(store.items.last?.id, "n5")
    }

    func testNotificationStoreUnreadCountDropsWhenWorkspaceSeen() {
        let store = NotificationStore()
        store.append(NotificationRecord(id: "n1", workspaceId: "w1", surfaceId: nil, title: "t1", subtitle: nil, body: "b1", ts: 1, threadId: "th1"))
        store.append(NotificationRecord(id: "n2", workspaceId: "w2", surfaceId: nil, title: "t2", subtitle: nil, body: "b2", ts: 2, threadId: "th2"))

        XCTAssertEqual(store.unreadCount, 2)

        store.markWorkspaceSeen("w1")

        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertNil(store.unreadByWorkspace["w1"])
        XCTAssertEqual(store.unreadByWorkspace["w2"], 1)
    }
}

private actor FailingRPCDispatch: RPCDispatch {
    func call(method: String, params: JSONValue) async throws -> RPCResponse {
        throw RPCClientError.closed
    }
}
