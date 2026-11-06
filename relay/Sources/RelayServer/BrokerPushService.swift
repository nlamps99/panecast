import Foundation
import RelayCore
import SharedKit

/// Push registrations received only over the authenticated broker tunnel.
/// The broker renews a device allow-list every 15 seconds. A disconnected or
/// revoked phone cannot keep receiving pushes from a stale on-disk registration.
public actor BrokerPushService {
    private struct Registration: Codable { var token: String; var env: String; var preferences: NotificationPreferences? }
    private let url: URL
    private let relayId: String
    private let sender: any APNsSending
    private let config: @Sendable () -> RelayConfig.APNs
    private let now: @Sendable () -> Date
    private var registrations: [String: Registration]
    private var allowed = Set<String>()
    private var validUntil = Date.distantPast
    private let dedupe = NotificationDedupe()

    public init(url: URL, relayId: String, sender: any APNsSending,
                config: @escaping @Sendable () -> RelayConfig.APNs,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url; self.relayId = relayId; self.sender = sender; self.config = config; self.now = now
        self.registrations = (try? JSONDecoder().decode([String: Registration].self, from: Data(contentsOf: url))) ?? [:]
    }

    public func suspend() { allowed = []; validUntil = .distantPast }

    public func receive(_ envelope: BrokerEnvelope) async -> BrokerEnvelope? {
        if envelope.type == .pushSync {
            guard let text = envelope.text, let ids = try? JSONDecoder().decode([String].self, from: Data(text.utf8)), ids.count <= 5000 else { return nil }
            allowed = Set(ids)
            validUntil = now().addingTimeInterval(45)
            let retained = registrations.filter { allowed.contains($0.key) }
            if retained.count != registrations.count { registrations = retained; try? persist() }
            return nil
        }
        guard envelope.type == .pushRegister || envelope.type == .pushTest else { return nil }
        guard let id = envelope.deviceId, allowed.contains(id), now() < validUntil else {
            return response(envelope, ["ok": false, "error": "device_not_authorized"])
        }
        if envelope.type == .pushRegister {
            struct Body: Decodable { var apns_token: String; var env: String; var preferences: NotificationPreferences? }
            guard let text = envelope.text,
                  let body = try? JSONDecoder().decode(Body.self, from: Data(text.utf8)),
                  !body.apns_token.isEmpty, body.apns_token.count <= 512, body.apns_token.count % 2 == 0,
                  body.apns_token.allSatisfy({ $0.isASCII && $0.isHexDigit }),
                  ["sandbox", "prod"].contains(body.env) else {
                return response(envelope, ["ok": false, "error": "invalid_apns_registration"])
            }
            registrations[id] = Registration(token: body.apns_token, env: body.env, preferences: body.preferences)
            do { try persist() }
            catch { return response(envelope, ["ok": false, "error": "push_storage_failed"]) }
            let c = config()
            let enabled = !c.keyPath.isEmpty && !c.keyId.isEmpty && !c.teamId.isEmpty && !c.topic.isEmpty && c.env == body.env
            return response(envelope, ["ok": true, "forwarded": true, "push_enabled": enabled, "preferences_applied": true])
        }
        guard let registration = registrations[id] else { return response(envelope, ["ok": false, "error": "push_not_registered"]) }
        let notification = NotificationRecord(id: "test-\(UUID().uuidString)", workspaceId: "unknown", surfaceId: nil,
            title: "Panecast", subtitle: nil, body: "推送测试", ts: Int64(now().timeIntervalSince1970), threadId: "panecast-test")
        do {
            let result = try await sender.send(APNsPushAlert(deviceToken: registration.token, environment: registration.env, notification: notification, relayId: relayId))
            switch result {
            case .delivered: return response(envelope, ["ok": true, "accepted": true])
            case .disabled: return response(envelope, ["ok": false, "error": "apns_not_configured"])
            case .invalidToken:
                registrations.removeValue(forKey: id); try? persist()
                return response(envelope, ["ok": false, "error": "invalid_push_token_or_topic"])
            case .failed(let status, let reason, _): return response(envelope, ["ok": false, "error": reason ?? "apns_rejected", "status": status])
            }
        } catch { return response(envelope, ["ok": false, "error": "apns_request_failed_check_relay_config"]) }
    }

    /// Returns accepted tokens, to avoid also sending the LAN registration's copy.
    public func deliver(event: EventFrame) async -> Set<String> {
        guard now() < validUntil, let notification = InboxNotification.record(from: event) else { return [] }
        let needsInput = InboxNotification.requiresUserInput(event)
        var accepted = Set<String>()
        for (id, registration) in registrations {
            guard now() < validUntil, allowed.contains(id), !accepted.contains(registration.token) else { continue }
            let preferences = registration.preferences ?? .init()
            // Exclude this token from LAN fanout even when a preference suppressed
            // it, or the duplicate LAN registration would bypass mute/quiet hours.
            guard preferences.allows(workspaceId: notification.workspaceId, needsInput: needsInput, at: now()),
                  dedupe.allow(device: registration.token, notification: notification, seconds: preferences.dedupeSeconds, needsInput: needsInput, at: now()) else {
                accepted.insert(registration.token); continue
            }
            defer { dedupe.finishAttempt(device: registration.token, notification: notification, needsInput: needsInput) }
            do {
                let result = try await sender.send(APNsPushAlert(deviceToken: registration.token, environment: registration.env, notification: notification, relayId: relayId, needsInput: needsInput))
                if case .delivered = result {
                    accepted.insert(registration.token)
                    dedupe.recordDelivered(device: registration.token, notification: notification, needsInput: needsInput)
                }
                if case .invalidToken = result { registrations.removeValue(forKey: id); try? persist() }
            } catch { continue }
        }
        return accepted
    }
    private func persist() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(registrations).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func response(_ request: BrokerEnvelope, _ result: [String: Any]) -> BrokerEnvelope {
        let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data()
        return .init(type: .pushResult, sessionId: request.sessionId, text: String(data: data, encoding: .utf8))
    }
}
