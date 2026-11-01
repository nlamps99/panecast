import Foundation
import Observation

struct Computer: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var endpoint: RelayEndpoint
    var brokerEndpoint: RelayEndpoint?
    var preference: TransportPreference

    init(id: UUID = UUID(), name: String, host: String, port: Int = 4399) {
        self.init(id: id, name: name, endpoint: RelayEndpoint(host: host, port: port))
    }

    init(id: UUID = UUID(), name: String, endpoint: RelayEndpoint,
         brokerEndpoint: RelayEndpoint? = nil, preference: TransportPreference = .direct) {
        self.id = id
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.name = trimmed.isEmpty ? (endpoint.mode == .broker ? endpoint.relayId : endpoint.host) : trimmed
        self.endpoint = endpoint
        self.brokerEndpoint = brokerEndpoint
        self.preference = preference
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        endpoint = try values.decode(RelayEndpoint.self, forKey: .endpoint)
        brokerEndpoint = try values.decodeIfPresent(RelayEndpoint.self, forKey: .brokerEndpoint)
        preference = try values.decodeIfPresent(TransportPreference.self, forKey: .preference) ?? .direct
    }

    var direct: RelayEndpoint? { endpoint.mode == .direct ? endpoint : nil }
    var broker: RelayEndpoint? { endpoint.mode == .broker ? endpoint : brokerEndpoint }
    var endpoints: [RelayEndpoint] { [direct, broker].compactMap { $0 } }
    var displayAddress: String {
        if preference == .broker, let broker { return "\(broker.brokerBaseURL) / \(broker.relayId)" }
        if let direct { return "\(direct.host):\(direct.port)" }
        return broker?.brokerBaseURL ?? ""
    }
    var isValid: Bool {
        guard endpoints.allSatisfy(\.isValid) else { return false }
        switch preference {
        case .direct: return direct != nil
        case .broker: return broker != nil
        case .auto: return !endpoints.isEmpty
        }
    }

    static func fromDefaults(_ defaults: UserDefaults, id: UUID = UUID(), name: String = "") -> Computer {
        let host = defaults.string(forKey: "cmux.host") ?? ""
        let storedPort = defaults.integer(forKey: "cmux.port")
        let direct = RelayEndpoint(host: host, port: storedPort == 0 ? 4399 : storedPort)
        let url = defaults.string(forKey: "cmux.brokerURL") ?? ""
        let broker: RelayEndpoint? = url.isEmpty ? nil : .broker(baseURL: url, relayId: defaults.string(forKey: "cmux.relayId") ?? "")
        let preference = TransportPreference(rawValue: defaults.string(forKey: "cmux.transportPreference")
            ?? defaults.string(forKey: "cmux.connectionMode") ?? "direct") ?? .direct
        return Computer(id: id, name: name, endpoint: host.isEmpty ? (broker ?? direct) : direct,
                        brokerEndpoint: host.isEmpty ? nil : broker, preference: preference)
    }
}

struct ComputerPairingCodes {
    var lan: String = ""
    var broker: String = ""
}

@MainActor
@Observable
final class ComputerStore {
    private struct SavedState: Codable {
        var computers: [Computer] = []
        var selectedID: UUID?
    }

    private var state: SavedState
    private let defaults: UserDefaults
    private let keychain: Keychain
    var pendingNewComputer = false
    nonisolated static let storageKey = "cmux.computers.v1"
    var computers: [Computer] { state.computers }
    var selectedID: UUID? { state.selectedID }
    var selected: Computer? { computers.first { $0.id == selectedID } }

    nonisolated static func savedComputer(defaults: UserDefaults = .standard) -> Computer? {
        guard let data = defaults.data(forKey: storageKey),
              let state = try? JSONDecoder().decode(SavedState.self, from: data) else { return nil }
        return state.computers.first { $0.id == state.selectedID }
    }

    init(defaults: UserDefaults = .standard,
         keychain: Keychain = Keychain(service: "com.genie.cmuxremote")) {
        self.defaults = defaults
        self.keychain = keychain
        if let data = defaults.data(forKey: Self.storageKey),
           let saved = try? JSONDecoder().decode(SavedState.self, from: data) {
            state = saved
        } else {
            let computer = Computer.fromDefaults(defaults)
            state = computer.isValid ? SavedState(computers: [computer], selectedID: computer.id) : SavedState()
        }
    }

    func migrateLegacyCredentials() throws {
        for computer in computers {
            for endpoint in computer.endpoints {
                try AuthClient.migrateLegacyCredentials(endpoint: endpoint, keychain: keychain)
            }
        }
        if defaults.data(forKey: Self.storageKey) == nil, let selected {
            try storeCodes(currentCodes(), for: selected.id)
        }
        persist()
    }

    func save(_ computer: Computer, codes: ComputerPairingCodes? = nil) throws {
        guard computer.isValid else { throw ComputerError.invalidEndpoint }
        let identities = Set(computer.endpoints.map(\.key))
        guard !computers.contains(where: { $0.id != computer.id && $0.endpoints.contains { identities.contains($0.key) } }) else {
            throw ComputerError.duplicateEndpoint
        }
        try migrateLegacyCredentials()
        if let codes { try storeCodes(codes, for: computer.id) }
        if let index = state.computers.firstIndex(where: { $0.id == computer.id }) {
            for old in state.computers[index].endpoints where !identities.contains(old.key) {
                try AuthClient.removeCredentials(endpoint: old, keychain: keychain)
            }
            state.computers[index] = computer
        } else {
            state.computers.append(computer)
        }
        if state.selectedID == nil { state.selectedID = computer.id }
        persist()
    }

    func saveCurrentSettings() throws {
        let current = Computer.fromDefaults(defaults)
        let existing = pendingNewComputer
            ? computers.first { computer in computer.endpoints.contains { current.endpoints.map(\.key).contains($0.key) } }
            : selected
        var updated = current
        if let existing {
            updated = Computer(id: existing.id, name: existing.name, endpoint: current.endpoint,
                               brokerEndpoint: current.brokerEndpoint, preference: current.preference)
        }
        try save(updated, codes: currentCodes())
        select(updated.id)
    }

    func select(_ id: UUID) {
        guard computers.contains(where: { $0.id == id }) else { return }
        state.selectedID = id
        pendingNewComputer = false
        activateSelected()
        persist()
    }

    func activateSelected() {
        guard let computer = selected else { return }
        defaults.set(computer.direct?.host ?? "", forKey: "cmux.host")
        defaults.set(computer.direct?.port ?? 4399, forKey: "cmux.port")
        defaults.set(computer.broker?.brokerBaseURL ?? "", forKey: "cmux.brokerURL")
        defaults.set(computer.broker?.relayId ?? "", forKey: "cmux.relayId")
        defaults.set(computer.preference.rawValue, forKey: "cmux.transportPreference")
        defaults.set(computer.preference == .direct ? "direct" : "broker", forKey: "cmux.connectionMode")
        let codes = (try? pairingCodes(for: computer.id)) ?? ComputerPairingCodes()
        defaults.set(codes.lan, forKey: "cmux.lanPairingCode")
        defaults.set(codes.broker, forKey: "cmux.pairingCode")
    }

    func pairingCodes(for id: UUID) throws -> ComputerPairingCodes {
        ComputerPairingCodes(lan: try keychain.get(codeKey(id, .direct)) ?? "",
                             broker: try keychain.get(codeKey(id, .broker)) ?? "")
    }

    func clearPairingCode(for endpoint: RelayEndpoint) throws {
        guard endpoint.requiresPairingCode, let selectedID else { return }
        try keychain.delete(codeKey(selectedID, endpoint.mode))
    }

    func remove(_ computer: Computer) throws {
        try migrateLegacyCredentials()
        for endpoint in computer.endpoints { try AuthClient.removeCredentials(endpoint: endpoint, keychain: keychain) }
        try clearCodes(for: computer.id)
        state.computers.removeAll { $0.id == computer.id }
        if selectedID == computer.id {
            state.selectedID = state.computers.first?.id
            if selectedID != nil { activateSelected() } else {
                for key in ["cmux.host", "cmux.port", "cmux.brokerURL", "cmux.relayId", "cmux.lanPairingCode", "cmux.pairingCode"] {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        persist()
    }

    func unpairSelected() throws {
        guard let selected else { return }
        try migrateLegacyCredentials()
        for endpoint in selected.endpoints { try AuthClient.removeCredentials(endpoint: endpoint, keychain: keychain) }
        try clearCodes(for: selected.id)
        activateSelected()
    }

    private func currentCodes() -> ComputerPairingCodes {
        ComputerPairingCodes(lan: defaults.string(forKey: "cmux.lanPairingCode") ?? "",
                             broker: defaults.string(forKey: "cmux.pairingCode") ?? "")
    }

    private func codeKey(_ id: UUID, _ mode: ConnectionMode) -> String { "computer.\(id.uuidString).\(mode.rawValue).pairing" }

    private func storeCodes(_ codes: ComputerPairingCodes, for id: UUID) throws {
        try keychain.set(codes.lan, for: codeKey(id, .direct))
        try keychain.set(codes.broker, for: codeKey(id, .broker))
    }

    private func clearCodes(for id: UUID) throws {
        try keychain.delete(codeKey(id, .direct))
        try keychain.delete(codeKey(id, .broker))
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}

enum ComputerError: LocalizedError {
    case invalidEndpoint
    case duplicateEndpoint

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return L10n.string("Enter a valid connection address and port.")
        case .duplicateEndpoint: return L10n.string("This connection is already saved.")
        }
    }
}
