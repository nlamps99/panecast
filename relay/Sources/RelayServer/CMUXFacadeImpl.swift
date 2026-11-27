import Foundation
import RelayCore
import CMUXClient
import SharedKit

/// Translates the JSON-RPC dispatch surface that `WebSocketHandler` exposes
/// into typed `CMUXClient.call` requests against the cmux daemon. Methods
/// the relay handles directly (e.g. `surface.subscribe`) are intercepted
/// upstream by `Session` and never reach this facade.
public final class CMUXFacadeImpl: CMUXFacade, @unchecked Sendable {
    public enum Lane: Sendable {
        case realtime
        case history
    }

    private let connection: CmuxConnection
    private let lane: Lane

    public init(connection: CmuxConnection, lane: Lane = .realtime) {
        self.connection = connection
        self.lane = lane
    }

    public func dispatch(method: String, params: JSONValue) async throws -> JSONValue {
        let client: CMUXClient
        switch lane {
        case .realtime:
            // Writes go out on their own socket: cmux works through a
            // socket's requests in order, and the screen polls keep the
            // dispatch socket busy.
            client = WSRequestLane.of(method: method) == .input
                ? try await connection.connectForInput()
                : try await connection.connect()
        case .history:
            client = try await connection.connectForHistory()
        }
        let resp = try await client.call(method: method, params: params)
        return try resp.unwrapResult()
    }
}

extension CMUXFacadeImpl: CMUXTextReading {
    public func readText(workspaceId: String, surfaceId: String, lines: Int) async throws -> String {
        let client = lane == .history ? try await connection.connectForHistory() : try await connection.connect()
        return try await client.surfaceReadTextString(workspaceId: workspaceId, surfaceId: surfaceId, lines: lines)
    }
}
