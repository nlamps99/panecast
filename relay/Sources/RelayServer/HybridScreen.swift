import Foundation
import CMUXClient
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
///
/// After input, the read that first shows the echo returns at once; the grid
/// follows on the next read, so typing is not held up by the slower grid.
/// Meanwhile a typed-into row keeps the colours of its unchanged start.
struct HybridScreen {
    static let minGridInterval: TimeInterval = 0.15
    /// How long after input a changed text counts as its echo.
    static let echoWindow: TimeInterval = 0.5
    /// More changed rows than this, without new ones, is a redraw, not typing.
    static let maxEditedRows = 2

    private var text: [String] = []
    private var plain: [String] = []
    private var stale = true
    private var inputAt: TimeInterval = -.infinity
    private var gridAt: TimeInterval = -.infinity
    /// The input whose echo was already sent ahead of its grid.
    private var echoSentFor: TimeInterval = -.infinity

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
        let changed = rows != text
        if changed {
            text = rows
            plain = rows.map(Self.trimmed)
            stale = true
        }
        let wanted = stale || inputAt > gridAt || !hasGrid
        guard wanted, now - gridAt >= Self.minGridInterval else { return false }
        // The echo of a keystroke: send the text now, the grid next read.
        if changed, hasGrid, inputAt > gridAt, inputAt > echoSentFor, now - inputAt <= Self.echoWindow {
            echoSentFor = inputAt
            return false
        }
        return true
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
        var cursorX = cursor?.x
        if let offset, text == textAtGrid {
            start = offset
            for (index, row) in colored.enumerated() where offset + index < rows.count { rows[offset + index] = row }
        } else {
            // The text moved on since the grid: keep each row's colors when
            // its text is unchanged, by position first, then by content.
            start = text.count - endGap - colored.count
            // Typed into in place (nothing scrolled, a row or two changed):
            // those rows keep the colors of their unchanged start.
            let editedInPlace = offset != nil && text.count == textAtGrid.count
                && zip(text, textAtGrid).lazy.filter { $0 != $1 }.prefix(Self.maxEditedRows + 1).count <= Self.maxEditedRows
            rows = text.enumerated().map { index, row in
                let position = index - start
                let inGrid = position >= 0 && position < colored.count
                if inGrid, coloredPlain[position] == plain[index] { return colored[position] }
                if plain[index].isEmpty { return row }
                if let moved = byContent[plain[index]] { return moved }
                if editedInPlace, inGrid,
                   let typed = Self.keepingColors(colored[position], was: coloredPlain[position], now: plain[index]) { return typed }
                return row
            }
            // Typing at the end of the cursor's line: the cursor follows the
            // text until the grid places it.
            if editedInPlace, let cursor, cursor.y < coloredPlain.count, start + cursor.y >= 0, start + cursor.y < plain.count {
                let was = coloredPlain[cursor.y], now = plain[start + cursor.y]
                if was != now, cursor.x == CMUXRenderGrid.displayWidth(was), now.hasPrefix(was) || was.hasPrefix(now) {
                    cursorX = CMUXRenderGrid.displayWidth(now)
                }
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
        if let cursorX, let row = cursorRow, row >= 0, row < rows.count {
            position = CursorPos(x: cursorX, y: row)
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

    /// `colored` (an SGR row reading `was`) with its colours kept over the
    /// start it shares with `now` and the rest of `now` plain, so a typed
    /// character does not blank a coloured prompt until the next grid. Nil
    /// when nothing is shared or there are no colours to keep.
    static func keepingColors(_ colored: String, was: String, now: String) -> String? {
        guard colored.unicodeScalars.contains("\u{1B}") else { return nil }
        let old = Array(was.unicodeScalars)
        let new = Array(now.unicodeScalars)
        var shared = 0
        while shared < old.count, shared < new.count, old[shared] == new[shared] { shared += 1 }
        guard shared > 0 else { return nil }
        var out = String.UnicodeScalarView()
        var styled = false
        var copied = 0
        var scalars = colored.unicodeScalars.makeIterator()
        while copied < shared, let scalar = scalars.next() {
            guard scalar == "\u{1B}" else {
                out.append(scalar)
                copied += 1
                continue
            }
            // ESC [ params m
            var params = String.UnicodeScalarView()
            out.append(scalar)
            while let next = scalars.next() {
                out.append(next)
                if next == "m" { break }
                if next != "[" { params.append(next) }
            }
            let parameters = String(params)
            styled = !(parameters.isEmpty || parameters == "0")
        }
        if styled { out.append(contentsOf: "\u{1B}[0m".unicodeScalars) }
        out.append(contentsOf: new[shared...])
        return String(out)
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
