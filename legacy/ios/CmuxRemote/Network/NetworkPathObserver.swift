import Foundation
import Network

/// Notifies when the device's network path changes, so `auto` can re-decide
/// between the LAN relay and the broker.
///
/// Without this, leaving the house keeps the app pointed at a LAN address that
/// no longer resolves: the socket eventually closes, but the app would sit
/// disconnected until the user reconnected by hand.
///
/// `NWPathMonitor` reports a burst of updates while an interface comes up
/// (Wi-Fi associating, DHCP, then routable), so callbacks are debounced —
/// otherwise each transition would trigger several probes and, worse, several
/// reconnects.
public final class NetworkPathObserver: @unchecked Sendable {
    /// Long enough to let a Wi-Fi association settle before probing, short
    /// enough that the switch still feels automatic rather than manual.
    public static let debounce: Duration = .milliseconds(750)

    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "cmux.networkPathObserver")
    private let debounce: Duration
    private let lock = NSLock()
    private var pending: Task<Void, Never>?
    private var started = false

    public init(debounce: Duration = NetworkPathObserver.debounce) {
        self.monitor = NWPathMonitor()
        self.debounce = debounce
    }

    /// Starts observing. `onChange` fires on path changes after the debounce
    /// window, never for the initial path — the caller has just connected using
    /// its own selection, so re-deciding immediately would be redundant.
    public func start(onChange: @escaping @Sendable () async -> Void) {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        lock.unlock()

        var sawFirstPath = false
        monitor.pathUpdateHandler = { [weak self] _ in
            guard let self else { return }
            guard sawFirstPath else { sawFirstPath = true; return }
            self.schedule(onChange)
        }
        monitor.start(queue: queue)
    }

    public func cancel() {
        lock.lock()
        let inFlight = pending
        pending = nil
        started = false
        lock.unlock()
        inFlight?.cancel()
        monitor.cancel()
    }

    private func schedule(_ onChange: @escaping @Sendable () async -> Void) {
        let window = debounce
        lock.lock()
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: window)
            guard !Task.isCancelled else { return }
            self?.clearPending()
            await onChange()
        }
        lock.unlock()
    }

    private func clearPending() {
        lock.lock()
        pending = nil
        lock.unlock()
    }
}
