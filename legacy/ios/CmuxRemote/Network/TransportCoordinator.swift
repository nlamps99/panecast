import Foundation
import os.log

/// Holds the endpoint the app is currently connected through, and re-decides it
/// when the network path changes.
///
/// A reference type on purpose: `App` is a struct, so the path-change callback
/// needs somewhere stable to read the live endpoint from and somewhere to hang
/// the reconnect action. Keeping both here also means the decision to switch is
/// testable without standing up a SwiftUI scene.
@MainActor
public final class TransportCoordinator {
    private let observer: NetworkPathObserver
    private let selector: TransportSelector
    private let settings: @Sendable () -> (preference: TransportPreference, candidates: TransportCandidates)
    private var activeEndpoint: RelayEndpoint?
    private var onSwitch: (@MainActor () -> Void)?
    private var watching = false
    private var generation = UUID()

    public init(
        observer: NetworkPathObserver = NetworkPathObserver(),
        selector: TransportSelector = TransportSelector(http: URLSessionHTTP()),
        settings: @escaping @Sendable () -> (preference: TransportPreference, candidates: TransportCandidates)
    ) {
        self.observer = observer
        self.selector = selector
        self.settings = settings
    }

    /// Records the endpoint a successful connection used, and starts watching
    /// for path changes the first time it is called under `auto`.
    ///
    /// Watching is gated on `auto` because with an explicit preference there is
    /// nothing to re-decide, and tearing down a working session on every Wi-Fi
    /// blip would be a regression.
    public func connected(to endpoint: RelayEndpoint, onSwitch: @escaping @MainActor () -> Void) {
        generation = UUID()
        activeEndpoint = endpoint
        self.onSwitch = onSwitch
        guard !watching, settings().preference == .auto else { return }
        watching = true
        observer.start { [weak self] in
            await self?.pathChanged()
        }
    }

    public func disconnected() {
        activeEndpoint = nil
    }

    /// Re-selects and reports whether the choice moved. Exposed for tests; the
    /// observer drives it in the app.
    @discardableResult
    public func pathChanged() async -> Bool {
        let generation = self.generation
        let (preference, candidates) = settings()
        guard preference == .auto else { return false }
        guard let selection = await selector.select(preference: preference, candidates: candidates),
              generation == self.generation,
              selection.endpoint != activeEndpoint
        else { return false }
        os_log("cmux transport switch to mode=%{public}@", selection.endpoint.mode.rawValue)
        onSwitch?()
        return true
    }

    public func stop() {
        generation = UUID()
        onSwitch = nil
        observer.cancel()
        watching = false
    }
}
