import SharedKit
import SwiftUI
import UIKit

struct SettingsView: View {
    @Bindable var store: WorkspaceStore
    let computers: ComputerStore
    let onDisconnect: () -> Void
    let onReconnect: () -> Void
    let onTerminalPreferencesChanged: () -> Void
    var onTriggerTestNotification: (@MainActor () -> TestNotificationResult)? = nil
    @AppStorage("cmux.transportPreference") private var transportPreferenceRaw: String = TransportPreference.direct.rawValue
    @AppStorage("cmux.host") private var host: String = ""
    @AppStorage("cmux.port") private var port: Int = 4399
    @AppStorage("cmux.lanPairingCode") private var lanPairingCode: String = ""
    @AppStorage("cmux.brokerURL") private var brokerURL: String = ""
    @AppStorage("cmux.relayId") private var relayId: String = ""
    @AppStorage("cmux.pairingCode") private var pairingCode: String = ""
    @AppStorage("cmux.demoMode") private var demoMode: Bool = false
    @AppStorage("cmux.theme") private var themeRaw: String = CmuxColorTheme.storm.rawValue
    @AppStorage("cmux.terminalFontSize") private var terminalFontSize: Double = 15
    @AppStorage("cmux.terminalLineSpacing") private var terminalLineSpacing: Double = 2
    @AppStorage("cmux.terminalScanlines") private var terminalScanlines: Bool = true
    @AppStorage("cmux.terminalScanlineIntensity") private var scanlineIntensity: Double = 0.18
    @AppStorage("cmux.terminalHistoryLines") private var terminalHistoryLines: Int = 120
    @AppStorage("cmux.defaultLiveInput") private var defaultLiveInput: Bool = false
    @AppStorage("cmux.keepScreenAwake") private var keepScreenAwake: Bool = false
    @AppStorage("cmux.keepKeyboardAfterSubmit") private var keepKeyboardAfterSubmit: Bool = false
    @AppStorage("cmux.showTerminalShortcutBar") private var showTerminalShortcutBar: Bool = true
    @AppStorage("cmux.terminalHaptics") private var terminalHaptics: Bool = false
    @State private var localStatus: TestNotificationStatus = .idle
    @State private var roundTripStatus: TestNotificationStatus = .idle
    @State private var showPairingScanner = false
    @State private var pairingScanConfirmation: String?
    @State private var editingComputer: Computer?
    @State private var removingComputer: Computer?
    @State private var computerError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CmuxSpacing.xl) {
                    Text(L10n.string("settings"))
                        .cmuxLargeTitle()
                        .foregroundStyle(CmuxTheme.ink)

                    computerConnections

                    settingsMenuGroup(title: "settings connection") {
                        settingsMenuItem(.connection)
                    }

                    settingsMenuGroup(title: "settings preferences") {
                        settingsMenuItem(.appearance)
                        settingsMenuItem(.terminal)
                        settingsMenuItem(.interaction)
                    }

                    settingsMenuGroup(title: "settings tools") {
                        settingsMenuItem(.notifications)
                        settingsMenuItem(.demo)
                        settingsMenuItem(.device)
                    }
                }
                .frame(maxWidth: 920, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, CmuxSpacing.screen)
                .padding(.top, CmuxSpacing.lg)
                .padding(.bottom, CmuxSpacing.xxl + CmuxSpacing.sm)
            }
            .scrollContentBackground(.hidden)
            .background(CmuxTheme.canvas)
            .navigationDestination(for: SettingsSection.self) { section in
                detailPage(for: section)
            }
        }
        .onAppear { CmuxTheme.apply(themeRawValue: themeRaw) }
        .onChange(of: themeRaw) { _, newValue in CmuxTheme.apply(themeRawValue: newValue) }
        .sheet(item: $editingComputer) { computer in
            ComputerEditor(computer: computer, codes: (try? computers.pairingCodes(for: computer.id)) ?? ComputerPairingCodes()) { updated, codes in
                try computers.save(updated, codes: codes)
                computers.select(updated.id)
                demoMode = false
                onReconnect()
            }
        }
        .confirmationDialog(L10n.string("Remove Computer"), isPresented: Binding(
            get: { removingComputer != nil }, set: { if !$0 { removingComputer = nil } }
        ), titleVisibility: .visible) {
            Button(L10n.string("Remove Computer"), role: .destructive) {
                guard let computer = removingComputer else { return }
                do {
                    let wasSelected = computer.id == computers.selectedID
                    try computers.remove(computer)
                    if wasSelected { onReconnect() }
                } catch { computerError = error.localizedDescription }
                removingComputer = nil
            }
        }
        .alert(L10n.string("Unable to Update Computer"), isPresented: Binding(
            get: { computerError != nil }, set: { if !$0 { computerError = nil } }
        )) {
            Button(L10n.string("OK")) { computerError = nil }
        } message: { Text(computerError ?? "") }
    }

    private var computerConnections: some View {
        VStack(alignment: .leading, spacing: CmuxSpacing.md) {
            HStack {
                CmuxRule(title: L10n.string("Computers"))
                Button { editingComputer = Computer(name: "", host: "") } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .accessibilityIdentifier("AddComputerButton")
                .accessibilityLabel(L10n.string("Add Computer"))
            }
            if computers.computers.isEmpty {
                Text(L10n.string("No saved computers")).cmuxCaption().foregroundStyle(CmuxTheme.muted)
            }
            ForEach(computers.computers) { computer in
                HStack(spacing: CmuxSpacing.md) {
                    Button {
                        computers.select(computer.id)
                        demoMode = false
                        onReconnect()
                    } label: {
                        HStack(spacing: CmuxSpacing.md) {
                            Image(systemName: computer.id == computers.selectedID ? "checkmark.circle.fill" : "desktopcomputer")
                                .foregroundStyle(computer.id == computers.selectedID ? CmuxTheme.success : CmuxTheme.muted)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(computer.name).cmuxHeadline().foregroundStyle(CmuxTheme.ink)
                                Text(verbatim: computer.displayAddress).cmuxCaption().foregroundStyle(CmuxTheme.muted)
                            }
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: 52).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("SelectComputer-\(computer.name)")
                    Menu {
                        Button(L10n.string("Edit"), systemImage: "pencil") { editingComputer = computer }
                        Button(L10n.string("Remove"), systemImage: "trash", role: .destructive) { removingComputer = computer }
                    } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel(L10n.format("Manage %@", computer.name))
                }
                Divider()
            }
        }
    }

    private func saveConnection() {
        do {
            try computers.saveCurrentSettings()
            demoMode = false
            onReconnect()
        } catch { computerError = error.localizedDescription }
    }

    private func settingsMenuItem(_ section: SettingsSection) -> some View {
        NavigationLink(value: section) {
            HStack(spacing: CmuxSpacing.md) {
                Image(systemName: section.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(section.tint)
                    .frame(width: 32, height: 32)
                    .background(section.tint.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: CmuxSpacing.xxs) {
                    Text(L10n.string(section.titleKey))
                        .cmuxHeadline()
                        .foregroundStyle(CmuxTheme.ink)
                    Text(L10n.string(section.subtitleKey))
                        .cmuxCaption()
                        .foregroundStyle(CmuxTheme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CmuxTheme.mutedDim)
            }
            .cmuxSurface()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(section.accessibilityIdentifier)
    }

    private func settingsMenuGroup<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: CmuxSpacing.md) {
            CmuxRule(title: L10n.string(title))
            content()
        }
    }

    @ViewBuilder
    private func detailPage(for section: SettingsSection) -> some View {
        switch section {
        case .connection:
            settingsDetail(title: section.titleKey) {
                connectionSettings
                connectionGuide
            }
        case .appearance:
            settingsDetail(title: section.titleKey) { appearanceSettings }
        case .terminal:
            settingsDetail(title: section.titleKey) { terminalSettings }
        case .interaction:
            settingsDetail(title: section.titleKey) { interactionSettings }
        case .notifications:
            settingsDetail(title: section.titleKey) { notificationSettings }
        case .demo:
            settingsDetail(title: section.titleKey) { demoSettings }
        case .device:
            settingsDetail(title: section.titleKey) { deviceSettings }
        }
    }

    private func settingsDetail<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CmuxSpacing.lg) {
                content()
            }
            .frame(maxWidth: 920, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, CmuxSpacing.screen)
            .padding(.vertical, CmuxSpacing.lg)
        }
        .background(CmuxTheme.canvas)
        .navigationTitle(L10n.string(title))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var connectionSettings: some View {
        section(title: "connection") {
            VStack(alignment: .leading, spacing: CmuxSpacing.lg) {
                labelRow("mode", color: CmuxTheme.muted)
                Picker(L10n.string("Connection mode"), selection: transportPreferenceBinding) {
                    ForEach(TransportPreference.allCases) { preference in
                        Text(preference.displayName).tag(preference)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("ConnectionModePicker")

                if transportPreference == .auto {
                    Text(L10n.string("Uses the Mac's LAN address when it answers on this Wi-Fi, and the server otherwise."))
                        .cmuxCaption()
                        .foregroundStyle(CmuxTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if transportPreference != .broker {
                    labelRow("host", color: CmuxTheme.muted)
                    TextField("192.168.x.x, mac.local, or 100.x.x.x", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .cmuxInputStyle()

                    labelRow("port", color: CmuxTheme.muted)
                    Stepper(value: $port, in: 1024...65535) {
                        Text(String(port)).cmuxHeadline().foregroundStyle(CmuxTheme.primary)
                    }

                    // A tailnet host proves its identity to the relay through
                    // Tailscale, so it needs no code. A LAN address cannot, and
                    // pairs with relay.json's lan.pairing_code instead.
                    if EndpointPolicy.isPrivateLANHost(host) {
                        labelRow("lan pairing code", color: CmuxTheme.muted)
                        SecureField(L10n.string("relay.json lan.pairing_code"), text: $lanPairingCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .cmuxInputStyle().accessibilityIdentifier("LANPairingCodeField")
                        Text(L10n.string("LAN traffic is not encrypted. Use it only on a network you trust."))
                            .cmuxCaption()
                            .foregroundStyle(CmuxTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if transportPreference != .direct {
                    labelRow("server url", color: CmuxTheme.muted)
                    TextField("https://relay.example.com", text: $brokerURL)
                        .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                        .cmuxInputStyle().accessibilityIdentifier("BrokerURLField")
                    labelRow("relay id", color: CmuxTheme.muted)
                    TextField("home-mac", text: $relayId)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .cmuxInputStyle().accessibilityIdentifier("RelayIDField")
                    labelRow("pairing code", color: CmuxTheme.muted)
                    SecureField(L10n.string("One-time pairing secret"), text: $pairingCode)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .cmuxInputStyle().accessibilityIdentifier("PairingCodeField")
                }

                if transportPreference != .direct {
                    Button {
                        pairingScanConfirmation = nil
                        showPairingScanner = true
                    } label: {
                        HStack(spacing: CmuxSpacing.sm) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 12, weight: .bold))
                            Text(L10n.string("[ SCAN QR FROM MAC ]")).cmuxDisplay(12)
                        }
                    }
                    .buttonStyle(CmuxOutlineButtonStyle())
                    .accessibilityIdentifier("ScanPairingQRButton")

                    if let pairingScanConfirmation {
                        Text(pairingScanConfirmation)
                            .cmuxCaption()
                            .foregroundStyle(CmuxTheme.success)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("PairingScanConfirmation")
                    }
                }

                HStack(spacing: CmuxSpacing.sm) {
                    Circle().fill(color(for: store.connection)).frame(width: 7, height: 7)
                    Text(label(store.connection)).cmuxCaption().foregroundStyle(CmuxTheme.muted)
                    if let transport = store.activeTransport, store.connection == .connected {
                        Text(transport.shortLabel)
                            .cmuxMono(10)
                            .foregroundStyle(
                                transport.isPlaintext ? CmuxTheme.warning : CmuxTheme.muted
                            )
                            .accessibilityIdentifier("SettingsTransportBadge")
                    }
                    Spacer()
                }

                Button(action: saveConnection) {
                    HStack(spacing: CmuxSpacing.sm) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .bold))
                        Text(L10n.string("[ SAVE & RECONNECT ]")).cmuxDisplay(12)
                    }
                }
                .buttonStyle(CmuxFilledButtonStyle(tint: CmuxTheme.success))
                .accessibilityIdentifier("ReconnectButton")
            }
        }
        .sheet(isPresented: $showPairingScanner) {
            PairingScannerView(
                onScanned: { payload in
                    apply(payload)
                    showPairingScanner = false
                },
                onCancel: { showPairingScanner = false }
            )
        }
    }

    /// Scanning fills in the connection fields but deliberately does not
    /// reconnect on its own: the user still confirms with SAVE & RECONNECT, so a
    /// mis-scan cannot silently replace a working configuration.
    private func apply(_ payload: PairingPayload) {
        computers.pendingNewComputer = true
        brokerURL = payload.serverURL
        relayId = payload.relayId
        pairingCode = payload.pairingCode
        if payload.hasLAN,
           let lanURL = payload.lanURL,
           let components = URLComponents(string: lanURL),
           let scannedHost = components.host,
           !scannedHost.isEmpty
        {
            host = scannedHost
            port = components.port ?? 4399
            lanPairingCode = payload.lanPairingCode ?? ""
            transportPreferenceRaw = TransportPreference.auto.rawValue
            pairingScanConfirmation = L10n.format(
                "scanned %@ with LAN fallback — tap save & reconnect",
                payload.relayId
            )
        } else {
            host = ""
            lanPairingCode = ""
            transportPreferenceRaw = TransportPreference.broker.rawValue
            pairingScanConfirmation = L10n.format("scanned %@ — tap save & reconnect", payload.relayId)
        }
    }

    private var demoSettings: some View {
        section(title: "demo mode") {
            VStack(alignment: .leading, spacing: CmuxSpacing.md) {
                Text(L10n.string("Explore the app without a Mac or Tailscale. It fills the app with demo workspaces, terminals, and notifications."))
                    .cmuxCaption().foregroundStyle(CmuxTheme.muted).fixedSize(horizontal: false, vertical: true)
                Button(action: { demoMode.toggle(); onReconnect() }) {
                    HStack(spacing: CmuxSpacing.sm) {
                        Image(systemName: demoMode ? "checkmark.seal.fill" : "play.rectangle")
                            .font(.system(size: 12, weight: .bold))
                        Text(L10n.string(demoMode ? "[ EXIT DEMO MODE ]" : "[ TRY DEMO MODE ]")).cmuxDisplay(12)
                    }
                }
                .buttonStyle(CmuxFilledButtonStyle(tint: demoMode ? CmuxTheme.warning : CmuxTheme.primary))
                .accessibilityIdentifier("DemoModeToggle")
            }
        }
    }

    private var notificationSettings: some View {
        section(title: "notifications") {
            VStack(alignment: .leading, spacing: CmuxSpacing.md) {
                Text(L10n.string("Manage notification permission, banners, and sounds in iOS Settings."))
                    .cmuxCaption().foregroundStyle(CmuxTheme.muted).fixedSize(horizontal: false, vertical: true)
                Button(action: openNotificationSettings) {
                    HStack(spacing: CmuxSpacing.sm) {
                        Image(systemName: "gearshape").font(.system(size: 12, weight: .bold))
                        Text(L10n.string("Open iOS notification settings")).cmuxDisplay(12)
                    }
                }
                .buttonStyle(CmuxOutlineButtonStyle())

                if onTriggerTestNotification != nil {
                    Text(L10n.string("Local injection immediately verifies the Inbox and iOS banner. The round-trip status separately verifies relay → cmux → events.stream."))
                        .cmuxCaption().foregroundStyle(CmuxTheme.muted).fixedSize(horizontal: false, vertical: true)
                    Button(action: triggerTestNotification) {
                        HStack(spacing: CmuxSpacing.sm) {
                            Image(systemName: "bell.badge").font(.system(size: 12, weight: .bold))
                            Text(L10n.string("[ SEND TEST NOTIFICATION ]")).cmuxDisplay(12)
                        }
                    }
                    .buttonStyle(CmuxFilledButtonStyle())
                    .disabled(localStatus.isSending || roundTripStatus.isSending)
                    if let line = localStatus.label { Text(L10n.format("local: %@", line)).cmuxCaption().foregroundStyle(localStatus.color) }
                    if let line = roundTripStatus.label { Text(L10n.format("round-trip: %@", line)).cmuxCaption().foregroundStyle(roundTripStatus.color) }
                }
            }
        }
    }

    private var deviceSettings: some View {
        section(title: "device") {
            Button(role: .destructive, action: onDisconnect) {
                HStack(spacing: CmuxSpacing.sm) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                    Text(L10n.string("[ UNPAIR CURRENT COMPUTER ]")).cmuxDisplay(12)
                }
            }
            .buttonStyle(CmuxOutlineButtonStyle(foreground: CmuxTheme.critical, border: CmuxTheme.critical.opacity(0.45)))
            .disabled(computers.selected == nil)
        }
    }

    private var appearanceSettings: some View {
        section(title: "appearance") {
            VStack(alignment: .leading, spacing: CmuxSpacing.md) {
                labelRow("theme", color: CmuxTheme.muted)
                Picker(L10n.string("Theme"), selection: $themeRaw) {
                    ForEach(CmuxColorTheme.allCases) { theme in
                        Text(L10n.string(theme.titleKey)).tag(theme.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                HStack(spacing: CmuxSpacing.sm) {
                    ForEach(CmuxColorTheme.allCases) { theme in
                        themeSwatch(theme)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L10n.string("Theme"))
            }
        }
    }

    private func themeSwatch(_ theme: CmuxColorTheme) -> some View {
        let selected = themeRaw == theme.rawValue
        return Button {
            themeRaw = theme.rawValue
        } label: {
            HStack(spacing: CmuxSpacing.sm) {
                Circle()
                    .fill(CmuxTheme.previewColor(for: theme))
                    .frame(width: 16, height: 16)
                    .overlay {
                        Circle().strokeBorder(
                            selected ? CmuxTheme.ink : Color.clear,
                            lineWidth: 2
                        )
                    }
                Text(L10n.string(theme.titleKey))
                    .cmuxCaption()
                    .foregroundStyle(selected ? CmuxTheme.ink : CmuxTheme.muted)
            }
            .padding(.horizontal, CmuxSpacing.md)
            .padding(.vertical, CmuxSpacing.sm)
            .frame(maxWidth: .infinity)
            .background(selected ? CmuxTheme.surfaceRaised : CmuxTheme.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous)
                    .strokeBorder(selected ? CmuxTheme.borderStrong : CmuxTheme.divider, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var terminalSettings: some View {
        section(title: "terminal") {
            VStack(alignment: .leading, spacing: CmuxSpacing.lg) {
                preferenceSlider(
                    title: "Terminal font size",
                    value: $terminalFontSize,
                    range: 12...24,
                    step: 1
                )

                preferenceSlider(
                    title: "Line spacing",
                    value: $terminalLineSpacing,
                    range: 0...8,
                    step: 1
                )

                HStack {
                    Text(L10n.string("Terminal history"))
                        .cmuxCallout()
                        .foregroundStyle(CmuxTheme.ink)
                    Spacer()
                    Stepper(value: $terminalHistoryLines, in: 60...400, step: 20) {
                        Text(L10n.format("%lld lines", Int64(terminalHistoryLines)))
                            .cmuxDisplay(CmuxFont.Role.micro.size)
                            .foregroundStyle(CmuxTheme.primary)
                    }
                    .accessibilityIdentifier("TerminalHistoryStepper")
                }
                .onChange(of: terminalHistoryLines) { _, _ in
                    onTerminalPreferencesChanged()
                }

                Toggle(L10n.string("Show CRT scanlines"), isOn: $terminalScanlines)
                    .tint(CmuxTheme.primary)
                    .cmuxCallout()
                    .foregroundStyle(CmuxTheme.ink)

                if terminalScanlines {
                    preferenceSlider(
                        title: "Scanline intensity",
                        value: $scanlineIntensity,
                        range: 0.06...0.30,
                        step: 0.02,
                        showsPoints: false
                    )
                }
            }
        }
    }

    private var interactionSettings: some View {
        section(title: "interaction") {
            VStack(alignment: .leading, spacing: CmuxSpacing.lg) {
                Group {
                    Toggle(L10n.string("Use live input by default"), isOn: $defaultLiveInput)
                    Toggle(L10n.string("Keep keyboard open after sending"), isOn: $keepKeyboardAfterSubmit)
                    Toggle(L10n.string("Show terminal shortcut bar"), isOn: $showTerminalShortcutBar)
                    Toggle(L10n.string("Haptic feedback for terminal keys"), isOn: $terminalHaptics)
                    Toggle(L10n.string("Keep screen awake while using cmux Remote"), isOn: $keepScreenAwake)
                }
                .tint(CmuxTheme.primary)
                .cmuxCallout()
                .foregroundStyle(CmuxTheme.ink)

                Button(action: restoreAppearanceDefaults) {
                    Text(L10n.string("Restore preferences defaults"))
                        .cmuxDisplay(11)
                }
                .buttonStyle(CmuxOutlineButtonStyle())
            }
        }
    }

    private func preferenceSlider(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        showsPoints: Bool = true
    ) -> some View {
        VStack(alignment: .leading, spacing: CmuxSpacing.sm) {
            HStack {
                Text(L10n.string(title))
                    .cmuxCallout()
                    .foregroundStyle(CmuxTheme.ink)
                Spacer()
                Text(sliderValueLabel(value.wrappedValue, showsPoints: showsPoints))
                    .cmuxDisplay(CmuxFont.Role.micro.size)
                    .foregroundStyle(CmuxTheme.primary)
            }
            Slider(value: value, in: range, step: step)
                .tint(CmuxTheme.primary)
        }
    }

    private func sliderValueLabel(_ value: Double, showsPoints: Bool) -> String {
        if showsPoints {
            return L10n.format("%lld pt", Int64(value.rounded()))
        }
        return L10n.format("%lld%%", Int64((value * 100).rounded()))
    }

    private func restoreAppearanceDefaults() {
        themeRaw = CmuxColorTheme.storm.rawValue
        terminalFontSize = 15
        terminalLineSpacing = 2
        terminalScanlines = true
        scanlineIntensity = 0.18
        terminalHistoryLines = 120
        defaultLiveInput = false
        keepScreenAwake = false
        keepKeyboardAfterSubmit = false
        showTerminalShortcutBar = true
        terminalHaptics = false
        CmuxTheme.apply(themeRawValue: themeRaw)
        onTerminalPreferencesChanged()
    }

    private func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: CmuxSpacing.md) {
            CmuxRule(title: L10n.string(title))
            content()
        }
        .cmuxSurface()
    }

    private func labelRow(_ text: String, color: Color) -> some View {
        Text(L10n.string(text))
            .cmuxEyebrow()
            .foregroundStyle(color)
    }

    private var transportPreference: TransportPreference {
        TransportPreference(rawValue: transportPreferenceRaw) ?? .direct
    }

    private var transportPreferenceBinding: Binding<TransportPreference> {
        Binding(
            get: { transportPreference },
            set: { transportPreferenceRaw = $0.rawValue }
        )
    }

    private var connectionGuide: some View {
        VStack(alignment: .leading, spacing: CmuxSpacing.md) {
            CmuxRule(title: L10n.string("tutorial"))
            VStack(alignment: .leading, spacing: CmuxSpacing.md) {
                switch transportPreference {
                case .direct:
                    GuideStep(number: 1,
                              title: "Turn on cmux and the relay on your Mac.",
                              detail: "swift run cmux-relay serve --config ~/.cmuxremote/relay.json")
                    GuideStep(number: 2,
                              title: "Pick how the phone reaches the Mac.",
                              detail: "A tailnet address needs Tailscale; a LAN address needs lan.pairing_code.")
                    GuideStep(number: 3,
                              title: "Enter that host and port.",
                              detail: "The port is usually 4399.")
                case .broker:
                    GuideStep(number: 1,
                              title: "Run the Broker and HTTPS on your VPS.",
                              detail: "broker/docker-compose.yml starts Caddy TLS too.")
                    GuideStep(number: 2,
                              title: "Set the Mac relay.json to Broker mode.",
                              detail: "Use the same relay_id / relay_token as the server.")
                    GuideStep(number: 3,
                              title: "Enter the Server URL, Relay ID, and Pairing Code.",
                              detail: "A public server URL must start with https://.")
                case .auto:
                    GuideStep(number: 1,
                              title: "Set relay.json transport to both.",
                              detail: "Add a lan.pairing_code block alongside the broker block.")
                    GuideStep(number: 2,
                              title: "Run cmux-relay pair on the Mac.",
                              detail: "The QR then carries the LAN address and the server together.")
                    GuideStep(number: 3,
                              title: "Scan it, or fill both sections by hand.",
                              detail: "The phone probes the LAN address first and falls back to the server.")
                }
                GuideStep(number: 4,
                          title: "Save, then tap reconnect.",
                          detail: "The connection is ready when workspaces appear.")
            }
        }
        .cmuxSurface()
    }

    private func color(for state: ConnectionState) -> Color {
        switch state {
        case .connected:    return CmuxTheme.success
        case .connecting:   return CmuxTheme.warning
        case .error:        return CmuxTheme.critical
        case .disconnected: return CmuxTheme.muted
        }
    }

    private func label(_ state: ConnectionState) -> String {
        switch state {
        case .connected: return L10n.string("connected")
        case .connecting: return L10n.string("connecting…")
        case .error(let message): return L10n.format("error: %@", message)
        case .disconnected: return L10n.string("disconnected")
        }
    }

    private func triggerTestNotification() {
        guard let action = onTriggerTestNotification else { return }
        let result = action()
        localStatus = result.localInjected
            ? .sent
            : .failed(L10n.string("inject skipped"))
        if let task = result.roundTrip {
            roundTripStatus = .sending
            Task { @MainActor in
                do {
                    try await task.value
                    roundTripStatus = .sent
                } catch {
                    roundTripStatus = .failed(String(describing: error))
                }
            }
        } else {
            roundTripStatus = .failed(L10n.string("relay disconnected"))
        }
    }
}

private extension View {
    func cmuxInputStyle() -> some View {
        self
            .cmuxCallout()
            .foregroundStyle(CmuxTheme.ink)
            .padding(.horizontal, CmuxSpacing.md)
            .padding(.vertical, CmuxSpacing.md - CmuxSpacing.xxs)
            .background(CmuxTheme.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous)
                    .strokeBorder(CmuxTheme.divider, lineWidth: 1)
            )
    }
}

private enum SettingsSection: CaseIterable, Hashable {
    case connection, appearance, terminal, interaction, notifications, demo, device

    var titleKey: String {
        switch self {
        case .connection: return "connection"
        case .appearance: return "appearance"
        case .terminal: return "terminal"
        case .interaction: return "interaction"
        case .notifications: return "notifications"
        case .demo: return "demo mode"
        case .device: return "device"
        }
    }

    var subtitleKey: String {
        switch self {
        case .connection: return "Configure relay and pairing"
        case .appearance: return "Theme colors"
        case .terminal: return "Font, spacing and scanlines"
        case .interaction: return "Input and screen behavior"
        case .notifications: return "Test delivery and Inbox"
        case .demo: return "Preview without a relay"
        case .device: return "Pairing and credentials"
        }
    }

    var icon: String {
        switch self {
        case .connection: return "network"
        case .appearance: return "paintpalette"
        case .terminal: return "terminal"
        case .interaction: return "hand.tap"
        case .notifications: return "bell"
        case .demo: return "play.rectangle"
        case .device: return "iphone"
        }
    }

    var accessibilityIdentifier: String {
        switch self {
        case .connection: return "SettingsConnectionItem"
        case .appearance: return "SettingsAppearanceItem"
        case .terminal: return "SettingsTerminalItem"
        case .interaction: return "SettingsInteractionItem"
        case .notifications: return "SettingsNotificationsItem"
        case .demo: return "SettingsDemoItem"
        case .device: return "SettingsDeviceItem"
        }
    }

    var tint: Color {
        switch self {
        case .connection: return CmuxTheme.accentGreen
        case .appearance: return CmuxTheme.accentMagenta
        case .terminal: return CmuxTheme.accentBlue
        case .interaction: return CmuxTheme.accentCyan
        case .notifications: return CmuxTheme.accentYellow
        case .demo: return CmuxTheme.accentOrange
        case .device: return CmuxTheme.accentRed
        }
    }
}

private enum TestNotificationStatus: Equatable {
    case idle
    case sending
    case sent
    case failed(String)

    var isSending: Bool {
        if case .sending = self { return true }
        return false
    }

    var label: String? {
        switch self {
        case .idle: return nil
        case .sending: return L10n.string("sending…")
        case .sent: return L10n.string("sent — it will appear in Inbox shortly.")
        case .failed(let message): return L10n.format("failed: %@", message)
        }
    }

    var color: Color {
        switch self {
        case .failed: return CmuxTheme.critical
        case .sent: return CmuxTheme.success
        default: return CmuxTheme.muted
        }
    }
}

private struct GuideStep: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: CmuxSpacing.md) {
            Text(String(format: "%02d", number))
                .cmuxDisplay(11)
                .foregroundStyle(CmuxTheme.success)
                .frame(width: 24, height: 24)
                .background(CmuxTheme.surfaceSunken)
                .clipShape(RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: CmuxRadius.sm, style: .continuous)
                        .strokeBorder(CmuxTheme.divider, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: CmuxSpacing.xxs) {
                Text(L10n.string(title))
                    .cmuxCallout()
                    .foregroundStyle(CmuxTheme.ink)
                Text(L10n.string(detail))
                    .cmuxCaption()
                    .foregroundStyle(CmuxTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
