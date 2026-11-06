import Foundation
import SharedKit

public final class InboxPushFanout: @unchecked Sendable {
    private let deviceStore: DeviceStore
    private let sender: any APNsSending
    private let config: @Sendable () -> RelayConfig.APNs
    private let dedupe = NotificationDedupe()

    public init(
        deviceStore: DeviceStore,
        sender: any APNsSending,
        config: @escaping @Sendable () -> RelayConfig.APNs
    ) {
        self.deviceStore = deviceStore
        self.sender = sender
        self.config = config
    }

    public func deliver(event: EventFrame, excluding tokens: Set<String> = []) async {
        guard let notification = InboxNotification.record(from: event) else { return }
        let needsInput = InboxNotification.requiresUserInput(event)
        let currentConfig = config()
        guard currentConfig.env == "sandbox" || currentConfig.env == "prod" else { return }

        for device in deviceStore.allDevices() {
            guard let token = device.apnsToken, !token.isEmpty, !tokens.contains(token),
                  let env = device.apnsEnv, env == currentConfig.env else { continue }
            let preferences = device.notificationPreferences ?? .init()
            guard preferences.allows(workspaceId: notification.workspaceId, needsInput: needsInput),
                  dedupe.allow(device: token, notification: notification, seconds: preferences.dedupeSeconds, needsInput: needsInput) else { continue }
            defer { dedupe.finishAttempt(device: token, notification: notification, needsInput: needsInput) }
            do {
                let result = try await sender.send(APNsPushAlert(
                    deviceToken: token,
                    environment: env,
                    notification: notification,
                    needsInput: needsInput
                ))
                if case .delivered = result { dedupe.recordDelivered(device: token, notification: notification, needsInput: needsInput) }
                if case .invalidToken = result {
                    try? deviceStore.clearAPNsToken(deviceId: device.deviceId)
                }
            } catch {
                continue
            }
        }
    }
}
