import Foundation
import SharedKit

/// One subscribed terminal's screen, assembled from two cmux reads:
///
/// - `surface.read_text` on every tick: cheap (a few ms), carries the
///   scrollback the viewers keep live, and tells whether anything changed.
/// - `terminal.replay` (the render grid) only after the text changed or the
///   user typed, at most every `minGridInterval`: it carries colors and the
///   real cursor but costs cmux about ten times more.
///
/// The grid's visible rows are placed over the matching tail of the text
/// rows. Between grids, rows that moved keep their colors by content, new
/// rows stay plain until the next grid, and the cursor keeps its distance
/// from the bottom. Without any grid (an older cmux) this is plain text with
/// the old (0, 0) placeholder cursor.
struct HybridScreen {
    static let minGridInterval: TimeInterval = 0.15

    private var text: [String] = []
    private var plain: [String] = []
    private var stale = true
    private var inputAt: TimeInterval = -.infinity
    private var gridAt: TimeInterval = -.infinity

    private var colored: [String] = []
    private var coloredPlain: [String] = []
    private var cursor: CursorPos?
    private var hasGrid = false
    /// Where the grid's rows began in `text`, while the text is unchanged.
    private var offset: Int?
    private var textAtGrid: [String] = []
    /// Text rows below the grid's rows when it was read (negative when the
    /// text left out the screen's trailing blank rows).
    private var endGap = 0
    private var byContent: [String: String] = [:]

    mutating func noteInput(at now: TimeInterval) {
        inputAt = now
    }

    /// Records a plain read; true when a grid should be read now.
    mutating func acceptText(_ rows: [String], at now: TimeInterval) -> Bool {
        if rows != text {
            text = rows
            plain = rows.map(Self.trimmed)
            stale = true
        }
        let wanted = stale || inputAt > gridAt || !hasGrid
        return wanted && now - gridAt >= Self.minGridInterval
    }

    /// The grid's visible rows (SGR text) and cursor in that row space; nil when hidden.
    mutating func acceptGrid(rows: [String], cursor: CursorPos?, at now: TimeInterval) {
        gridAt = now
        hasGrid = true
        colored = rows
        coloredPlain = rows.map(Self.plainText)
        self.cursor = cursor
        var index: [String: String] = [:]
        for (row, plainRow) in zip(rows, coloredPlain) where !plainRow.isEmpty && row != plainRow { index[plainRow] = row }
        byContent = index
        offset = Self.align(coloredPlain, in: plain)
        if let offset {
            stale = false
            textAtGrid = text
            endGap = text.count - offset - rows.count
        }
    }

    /// A failed grid read waits for the next interval before trying again.
    mutating func gridFailed(at now: TimeInterval) {
        gridAt = now
    }

    func screen(maxRows: Int, cols: Int) -> Screen {
        guard hasGrid else { return Screen(rev: 0, rows: text, cols: cols, cursor: CursorPos(x: 0, y: 0)) }
        // Rows follow the text read (same count, same scrollback); the grid
        // only colors them, so the row count never flips between reads.
        var rows = text
        let start: Int
        if let offset, text == textAtGrid {
            start = offset
            for (index, row) in colored.enumerated() where offset + index < rows.count { rows[offset + index] = row }
        } else {
            // The text moved on since the grid: keep each row's colors when
            // its text is unchanged, by position first, then by content.
            start = text.count - endGap - colored.count
            rows = text.enumerated().map { index, row in
                let position = index - start
                if position >= 0, position < colored.count, coloredPlain[position] == plain[index] { return colored[position] }
                return plain[index].isEmpty ? row : byContent[plain[index]] ?? row
            }
        }
        var cursorRow = cursor.map { start + $0.y }
        // A cursor on a trailing blank row the text left out: show those rows.
        if let row = cursorRow, row >= rows.count, row < start + colored.count {
            rows += Array(repeating: "", count: row - rows.count + 1)
        }
        let dropped = max(0, rows.count - maxRows)
        if dropped > 0 {
            rows.removeFirst(dropped)
            cursorRow = cursorRow.map { $0 - dropped }
        }
        let position: CursorPos
        if let cursor, let row = cursorRow, row >= 0, row < rows.count {
            position = CursorPos(x: cursor.x, y: row)
        } else {
            position = CursorPos(x: 0, y: rows.count)
        }
        return Screen(rev: 0, rows: rows, cols: cols, cursor: position)
    }

    /// Where `grid` sits at the end of `text`: the text may end with the
    /// screen's blank rows or leave them out.
    static func align(_ grid: [String], in text: [String]) -> Int? {
        var core = grid.count
        while core > 0, grid[core - 1].isEmpty { core -= 1 }
        if core == 0 { return max(0, text.count - grid.count) }
        let latest = text.count - core
        guard latest >= 0 else { return nil }
        let earliest = max(0, text.count - grid.count - 2)
        guard earliest <= latest else { return nil }
        for start in stride(from: latest, through: earliest, by: -1) {
            guard text[(start + core)...].allSatisfy(\.isEmpty) else { continue }
            if Array(text[start..<(start + core)]) == Array(grid[0..<core]) { return start }
        }
        return nil
    }

    static func trimmed(_ row: String) -> String {
        var scalars = row.unicodeScalars
        while scalars.last == " " { scalars.removeLast() }
        return String(scalars)
    }

    /// The text of an SGR-only row (what the relay itself writes), trimmed.
    static func plainText(_ row: String) -> String {
        guard row.contains("\u{1B}") else { return trimmed(row) }
        var out = String.UnicodeScalarView()
        var scalars = row.unicodeScalars.makeIterator()
        while let scalar = scalars.next() {
            if scalar == "\u{1B}" {
                // ESC [ params m
                while let next = scalars.next(), next != "m" {}
                continue
            }
            out.append(scalar)
        }
        return trimmed(String(out))
    }
}
