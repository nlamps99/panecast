import SwiftUI
import SharedKit

struct ComputerEditor: View {
    @Environment(\.dismiss) private var dismiss
    private let computer: Computer
    private let onSave: (Computer, ComputerPairingCodes) throws -> Void
    @State private var name: String
    @State private var host: String
    @State private var port: String
    @State private var errorMessage: String?
    @State private var preference: TransportPreference
    @State private var brokerURL: String
    @State private var relayID: String
    @State private var lanCode: String
    @State private var brokerCode: String
    @State private var showScanner = false

    init(computer: Computer, codes: ComputerPairingCodes = ComputerPairingCodes(),
         onSave: @escaping (Computer, ComputerPairingCodes) throws -> Void) {
        self.computer = computer
        self.onSave = onSave
        _name = State(initialValue: computer.name)
        _host = State(initialValue: computer.direct?.host ?? "")
        _port = State(initialValue: String(computer.direct?.port ?? 4399))
        _preference = State(initialValue: computer.preference)
        _brokerURL = State(initialValue: computer.broker?.brokerBaseURL ?? "")
        _relayID = State(initialValue: computer.broker?.relayId ?? "")
        _lanCode = State(initialValue: codes.lan)
        _brokerCode = State(initialValue: codes.broker)
    }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    TextField(L10n.string("Computer name"), text: $name)
                        .accessibilityIdentifier("ComputerNameField")
                    Picker(L10n.string("Connection mode"), selection: $preference) {
                        ForEach(TransportPreference.allCases) { Text($0.displayName).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if preference != .broker {
                    TextField("192.168.x.x, mac.local, or 100.x.x.x", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityIdentifier("ComputerHostField")
                    HStack {
                        Text(L10n.string("port"))
                        TextField("4399", text: $port)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .accessibilityIdentifier("ComputerPortField")
                    }
                    if EndpointPolicy.isPrivateLANHost(host) {
                        SecureField(L10n.string("lan pairing code"), text: $lanCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    }
                    if preference != .direct {
                        TextField("https://relay.example.com", text: $brokerURL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityIdentifier("ComputerBrokerURLField")
                        TextField(L10n.string("relay id"), text: $relayID)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("ComputerRelayIDField")
                        SecureField(L10n.string("pairing code"), text: $brokerCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Button(L10n.string("[ SCAN QR FROM MAC ]"), systemImage: "qrcode.viewfinder") { showScanner = true }
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(CmuxTheme.accentRed)
                    }
                }
                .listRowBackground(CmuxTheme.surface)
            }
            .cmuxMono(13)
            .foregroundStyle(CmuxTheme.ink)
            .scrollContentBackground(.hidden)
            .background(CmuxTheme.canvas)
            .navigationTitle(L10n.string(computer.isValid ? "Edit Computer" : "Add Computer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("Save & Connect")) {
                        do {
                            guard let port = Int(port) else { throw ComputerError.invalidEndpoint }
                            let direct = RelayEndpoint(host: host, port: port)
                            let broker: RelayEndpoint? = brokerURL.isEmpty ? nil : .broker(baseURL: brokerURL, relayId: relayID)
                            let updated = Computer(id: computer.id, name: name,
                                                   endpoint: host.isEmpty ? (broker ?? direct) : direct,
                                                   brokerEndpoint: host.isEmpty ? nil : broker, preference: preference)
                            try onSave(updated, ComputerPairingCodes(lan: lanCode, broker: brokerCode))
                            dismiss()
                        } catch { errorMessage = error.localizedDescription }
                    }
                    .accessibilityIdentifier("SaveComputerButton")
                }
            }
        }
        .sheet(isPresented: $showScanner) {
            PairingScannerView(onScanned: { payload in
                brokerURL = payload.serverURL
                relayID = payload.relayId
                brokerCode = payload.pairingCode
                if name.isEmpty { name = payload.relayId }
                let lan = payload.lanURL.flatMap(URLComponents.init(string:))
                host = lan?.host ?? ""
                port = String(lan?.port ?? 4399)
                lanCode = payload.lanPairingCode ?? ""
                preference = payload.hasLAN ? .auto : .broker
                showScanner = false
            }, onCancel: { showScanner = false })
        }
        .preferredColorScheme(.dark)
        .tint(CmuxTheme.accentGreen)
    }
}
