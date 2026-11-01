import AVFoundation
import SharedKit
import SwiftUI
import UIKit

/// Scans a `cmux://pair?...` QR code produced by `cmux-relay pair`.
///
/// Typing a broker URL, relay id, and a 64-character pairing code by hand is
/// error-prone, and the broker rate-limits pairing attempts by source IP, so a
/// few typos can lock a user out for a minute.
struct PairingScannerView: View {
    /// Called with a successfully parsed payload. The view stops scanning first,
    /// so the handler is invoked exactly once per presentation.
    let onScanned: (PairingPayload) -> Void
    let onCancel: () -> Void

    @State private var authorization: CameraAuthorization = .undetermined
    @State private var failureMessage: String?
    @State private var handled = false

    var body: some View {
        NavigationStack {
            ZStack {
                CmuxTheme.canvas.ignoresSafeArea()
                content
            }
            .navigationTitle(L10n.string("Scan QR"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("Cancel"), action: onCancel)
                }
            }
        }
        .task { await resolveAuthorization() }
    }

    @ViewBuilder
    private var content: some View {
        switch authorization {
        case .undetermined:
            ProgressView().tint(CmuxTheme.primary)
        case .denied:
            deniedState
        case .authorized:
            scanner
        }
    }

    private var scanner: some View {
        VStack(spacing: CmuxSpacing.lg) {
            QRScannerRepresentable { payloadString in
                handle(payloadString)
            }
            .clipShape(RoundedRectangle(cornerRadius: CmuxRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CmuxRadius.lg, style: .continuous)
                    .strokeBorder(CmuxTheme.divider, lineWidth: 1)
            )
            .frame(maxHeight: 420)
            .accessibilityIdentifier("PairingScannerPreview")
            .accessibilityLabel(L10n.string("Camera viewfinder for pairing QR code"))

            VStack(alignment: .leading, spacing: CmuxSpacing.sm) {
                Text(L10n.string("On your Mac run:"))
                    .cmuxCaption()
                    .foregroundStyle(CmuxTheme.muted)
                Text("cmux-relay pair")
                    .cmuxMono(13)
                    .foregroundStyle(CmuxTheme.primary)
                    .textSelection(.enabled)
                if let failureMessage {
                    Text(failureMessage)
                        .cmuxCaption()
                        .foregroundStyle(CmuxTheme.critical)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("PairingScannerError")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cmuxSurface()

            Spacer(minLength: 0)
        }
        .padding(CmuxSpacing.screen)
    }

    private var deniedState: some View {
        VStack(spacing: CmuxSpacing.md) {
            Image(systemName: "camera.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(CmuxTheme.muted)
            Text(L10n.string("Camera access is off"))
                .cmuxHeadline()
                .foregroundStyle(CmuxTheme.ink)
            Text(L10n.string("Enable the camera in iOS Settings to scan a pairing code, or enter the details by hand."))
                .cmuxCaption()
                .foregroundStyle(CmuxTheme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            } label: {
                Text(L10n.string("Open iOS settings")).cmuxDisplay(12)
            }
            .buttonStyle(CmuxOutlineButtonStyle())
        }
        .padding(CmuxSpacing.screen)
        .frame(maxWidth: 420)
    }

    private func handle(_ raw: String) {
        guard !handled else { return }
        do {
            let payload = try PairingPayload(urlString: raw)
            handled = true
            failureMessage = nil
            onScanned(payload)
        } catch {
            // Keep scanning: the user may simply have pointed the camera at an
            // unrelated QR code.
            failureMessage = L10n.string("That QR code is not a cmux pairing code.")
        }
    }

    private func resolveAuthorization() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            authorization = .authorized
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            authorization = granted ? .authorized : .denied
        default:
            authorization = .denied
        }
    }

    private enum CameraAuthorization {
        case undetermined, authorized, denied
    }
}

/// Thin AVFoundation wrapper. Kept separate from the SwiftUI layer so the
/// capture session lifecycle is explicit: it starts when the view appears and
/// stops as soon as it goes away or a code is accepted.
private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) {
        controller.onCode = onCode
    }
}

private final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let sessionQueue = DispatchQueue(label: "cmux.pairing.scanner")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startIfNeeded()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        // Assign after adding the output, otherwise the available types list is
        // still empty and `.qr` is rejected at runtime.
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    private func startIfNeeded() {
        sessionQueue.async { [session] in
            guard !session.isRunning else { return }
            session.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              object.type == .qr,
              let value = object.stringValue
        else { return }
        onCode?(value)
    }
}
