import Foundation
import SharedKit

/// The rows last sent to one subscriber, diffed against each new read by
/// comparing bytes (a SHA-256 per row per tick cost far more, and is not part
/// of the wire protocol). Bytes, not `String ==`: canonically equivalent rows
/// with different bytes would leave the viewer's `screen.checksum` behind.
public struct RowState {
    private var rows: [String] = []
    private var cursor: CursorPos = .init(x: -1, y: -1)
    private var initialised = false

    public init() {}

    public mutating func ingest(snapshot: Screen) -> [DiffOp] {
        if !initialised {
            initialised = true
            rows = snapshot.rows
            cursor = snapshot.cursor
            var ops: [DiffOp] = [.clear]
            for (i, row) in snapshot.rows.enumerated() { ops.append(.row(y: i, text: row)) }
            ops.append(.cursor(x: snapshot.cursor.x, y: snapshot.cursor.y))
            return ops
        }
        var ops: [DiffOp] = []
        if snapshot.rows.count != rows.count {
            ops.append(.clear)
            rows = snapshot.rows
            for (i, row) in snapshot.rows.enumerated() { ops.append(.row(y: i, text: row)) }
        } else {
            for i in 0..<snapshot.rows.count where !Self.sameBytes(snapshot.rows[i], rows[i]) {
                rows[i] = snapshot.rows[i]
                ops.append(.row(y: i, text: snapshot.rows[i]))
            }
        }
        if snapshot.cursor != cursor {
            cursor = snapshot.cursor
            ops.append(.cursor(x: snapshot.cursor.x, y: snapshot.cursor.y))
        }
        return ops
    }

    static func sameBytes(_ a: String, _ b: String) -> Bool {
        var a = a, b = b
        return a.withUTF8 { x in
            b.withUTF8 { y in
                x.count == y.count && (x.isEmpty || memcmp(x.baseAddress!, y.baseAddress!, x.count) == 0)
            }
        }
    }
}
