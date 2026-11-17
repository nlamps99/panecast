import Foundation
import SharedKit

/// The parts of cmux's `terminal.replay` render grid the relay forwards:
/// styled cell runs (for colors) and the real cursor. `surface.read_text`
/// carries neither, so viewers drew monochrome text without a cursor.
public struct CMUXRenderGrid: Decodable, Sendable, Equatable {
    public struct Style: Decodable, Sendable, Equatable {
        public var id: Int
        public var foreground: String?
        public var background: String?
        public var foregroundSource: String?
        public var foregroundPaletteIndex: Int?
        public var backgroundSource: String?
        public var backgroundPaletteIndex: Int?
        public var bold = false, faint = false, italic = false, underline = false
        public var blink = false, inverse = false, invisible = false, strikethrough = false

        enum CodingKeys: String, CodingKey {
            case id, foreground, background, bold, faint, italic, underline, blink, inverse, invisible, strikethrough
            case foregroundSource = "foreground_source"
            case foregroundPaletteIndex = "foreground_palette_index"
            case backgroundSource = "background_source"
            case backgroundPaletteIndex = "background_palette_index"
        }

        public init(id: Int, foregroundSource: String? = nil, foreground: String? = nil, foregroundPaletteIndex: Int? = nil,
                    backgroundSource: String? = nil, background: String? = nil, backgroundPaletteIndex: Int? = nil,
                    bold: Bool = false, faint: Bool = false, italic: Bool = false, underline: Bool = false,
                    blink: Bool = false, inverse: Bool = false, invisible: Bool = false, strikethrough: Bool = false) {
            self.id = id
            self.foreground = foreground; self.foregroundSource = foregroundSource; self.foregroundPaletteIndex = foregroundPaletteIndex
            self.background = background; self.backgroundSource = backgroundSource; self.backgroundPaletteIndex = backgroundPaletteIndex
            self.bold = bold; self.faint = faint; self.italic = italic; self.underline = underline
            self.blink = blink; self.inverse = inverse; self.invisible = invisible; self.strikethrough = strikethrough
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(Int.self, forKey: .id)
            foreground = try c.decodeIfPresent(String.self, forKey: .foreground)
            background = try c.decodeIfPresent(String.self, forKey: .background)
            foregroundSource = try c.decodeIfPresent(String.self, forKey: .foregroundSource)
            foregroundPaletteIndex = try c.decodeIfPresent(Int.self, forKey: .foregroundPaletteIndex)
            backgroundSource = try c.decodeIfPresent(String.self, forKey: .backgroundSource)
            backgroundPaletteIndex = try c.decodeIfPresent(Int.self, forKey: .backgroundPaletteIndex)
            bold = try c.decodeIfPresent(Bool.self, forKey: .bold) ?? false
            faint = try c.decodeIfPresent(Bool.self, forKey: .faint) ?? false
            italic = try c.decodeIfPresent(Bool.self, forKey: .italic) ?? false
            underline = try c.decodeIfPresent(Bool.self, forKey: .underline) ?? false
            blink = try c.decodeIfPresent(Bool.self, forKey: .blink) ?? false
            inverse = try c.decodeIfPresent(Bool.self, forKey: .inverse) ?? false
            invisible = try c.decodeIfPresent(Bool.self, forKey: .invisible) ?? false
            strikethrough = try c.decodeIfPresent(Bool.self, forKey: .strikethrough) ?? false
        }
    }

    public struct Span: Decodable, Sendable, Equatable {
        public var row: Int
        public var column: Int
        public var styleID: Int
        public var text: String
        public var cellWidth: Int?
        enum CodingKeys: String, CodingKey { case row, column, text; case styleID = "style_id"; case cellWidth = "cell_width" }
        public init(row: Int, column: Int, styleID: Int = 0, text: String, cellWidth: Int? = nil) {
            self.row = row; self.column = column; self.styleID = styleID; self.text = text; self.cellWidth = cellWidth
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            row = try c.decode(Int.self, forKey: .row)
            column = try c.decode(Int.self, forKey: .column)
            styleID = try c.decodeIfPresent(Int.self, forKey: .styleID) ?? 0
            text = try c.decode(String.self, forKey: .text)
            cellWidth = try c.decodeIfPresent(Int.self, forKey: .cellWidth)
        }
    }

    public struct Cursor: Decodable, Sendable, Equatable {
        public var row: Int
        public var column: Int
        public var visible: Bool
        enum CodingKeys: String, CodingKey { case row, column, visible }
        public init(row: Int, column: Int, visible: Bool = true) { self.row = row; self.column = column; self.visible = visible }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            row = try c.decode(Int.self, forKey: .row)
            column = try c.decode(Int.self, forKey: .column)
            visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
        }
    }

    public var columns: Int
    public var rows: Int
    public var cursor: Cursor?
    public var styles: [Style]
    public var rowSpans: [Span]
    public var scrollbackRows: Int
    public var scrollbackSpans: [Span]

    enum CodingKeys: String, CodingKey {
        case columns, rows, cursor, styles
        case rowSpans = "row_spans"
        case scrollbackRows = "scrollback_rows"
        case scrollbackSpans = "scrollback_spans"
    }

    public init(columns: Int, rows: Int, cursor: Cursor?, styles: [Style], rowSpans: [Span], scrollbackRows: Int = 0, scrollbackSpans: [Span] = []) {
        self.columns = columns; self.rows = rows; self.cursor = cursor; self.styles = styles
        self.rowSpans = rowSpans; self.scrollbackRows = scrollbackRows; self.scrollbackSpans = scrollbackSpans
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        columns = try c.decode(Int.self, forKey: .columns)
        rows = try c.decode(Int.self, forKey: .rows)
        cursor = try c.decodeIfPresent(Cursor.self, forKey: .cursor)
        styles = try c.decodeIfPresent([Style].self, forKey: .styles) ?? []
        rowSpans = try c.decodeIfPresent([Span].self, forKey: .rowSpans) ?? []
        scrollbackRows = max(0, try c.decodeIfPresent(Int.self, forKey: .scrollbackRows) ?? 0)
        scrollbackSpans = try c.decodeIfPresent([Span].self, forKey: .scrollbackSpans) ?? []
    }

    /// Scrollback above the visible rows, then the visible rows, as ANSI text
    /// (SGR only, ending in a reset). Keeps the last `maxRows`. The cursor is
    /// in the same row space; a hidden cursor sits one row past the end.
    public func toScreen(rev: Int, maxRows: Int) -> Screen {
        guard rows > 0, columns > 0 else { return Screen(rev: rev, rows: [], cols: 0, cursor: CursorPos(x: 0, y: 0)) }
        let stylesByID = Dictionary(styles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var history = Array(repeating: [Span](), count: scrollbackRows)
        for span in scrollbackSpans where span.row >= 0 && span.row < scrollbackRows { history[span.row].append(span) }
        var screen = Array(repeating: [Span](), count: rows)
        for span in rowSpans where span.row >= 0 && span.row < rows { screen[span.row].append(span) }
        var lines = (history + screen).map { Self.line($0, styles: stylesByID, columns: columns) }
        // Blank scrollback rows trail no content; keep the visible block intact.
        let dropped = max(0, lines.count - max(maxRows, rows))
        if dropped > 0 { lines.removeFirst(dropped) }
        let top = scrollbackRows - dropped
        var cursorPosition = CursorPos(x: 0, y: lines.count)
        if let cursor, cursor.visible, cursor.row >= 0, cursor.row < rows {
            cursorPosition = CursorPos(x: max(0, min(cursor.column, columns - 1)), y: top + cursor.row)
        }
        return Screen(rev: rev, rows: lines, cols: columns, cursor: cursorPosition)
    }

    static func line(_ spans: [Span], styles: [Int: Style], columns: Int) -> String {
        var out = ""
        var column = 0
        var styled = false
        for span in spans.sorted(by: { $0.column < $1.column }) {
            guard span.column >= column, span.column < columns, !span.text.isEmpty else { continue }
            if span.column > column {
                if styled { out += "\u{1B}[0m"; styled = false }
                out += String(repeating: " ", count: span.column - column)
                column = span.column
            }
            let style = styles[span.styleID]
            let sgr = style.map(Self.sgr) ?? ""
            if styled { out += "\u{1B}[0m"; styled = false }
            if !sgr.isEmpty { out += "\u{1B}[\(sgr)m"; styled = true }
            let text = span.text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
                ? String(String.UnicodeScalarView(span.text.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }))
                : span.text
            out += text
            column = span.column + (span.cellWidth ?? Self.cellWidth(text))
        }
        if styled {
            out += "\u{1B}[0m"
        } else {
            // Plain trailing spaces carry nothing; viewers measure trimmed rows.
            while out.unicodeScalars.last == " " { out.unicodeScalars.removeLast() }
        }
        return out
    }

    static func sgr(_ style: Style) -> String {
        var parts: [String] = []
        if style.bold { parts.append("1") }
        if style.faint { parts.append("2") }
        if style.italic { parts.append("3") }
        if style.underline { parts.append("4") }
        if style.blink { parts.append("5") }
        if style.inverse { parts.append("7") }
        if style.invisible { parts.append("8") }
        if style.strikethrough { parts.append("9") }
        if let fg = colorSGR(source: style.foregroundSource, hex: style.foreground, palette: style.foregroundPaletteIndex, base: 30) { parts.append(fg) }
        if let bg = colorSGR(source: style.backgroundSource, hex: style.background, palette: style.backgroundPaletteIndex, base: 40) { parts.append(bg) }
        return parts.joined(separator: ";")
    }

    /// Theme defaults stay unset so each viewer applies its own theme.
    static func colorSGR(source: String?, hex: String?, palette: Int?, base: Int) -> String? {
        switch source {
        case "default":
            return nil
        case "rgb":
            guard let hex, let rgb = parseHex(hex) else { return nil }
            return "\(base + 8);2;\(rgb.0);\(rgb.1);\(rgb.2)"
        default:
            guard let index = palette, (0...255).contains(index) else { return nil }
            if index < 8 { return "\(base + index)" }
            if index < 16 { return "\(base + 60 + index - 8)" }
            return "\(base + 8);5;\(index)"
        }
    }

    static func parseHex(_ value: String) -> (Int, Int, Int)? {
        var hex = value.hasPrefix("#") ? String(value.dropFirst()) : value
        if hex.count == 8 { hex = String(hex.prefix(6)) }
        guard hex.count == 6, let number = Int(hex, radix: 16) else { return nil }
        return ((number >> 16) & 0xFF, (number >> 8) & 0xFF, number & 0xFF)
    }

    /// Terminal cell width, used only when cmux omits `cell_width`.
    static func cellWidth(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { total, scalar in total + scalarWidth(scalar.value) }
    }

    static func scalarWidth(_ v: UInt32) -> Int {
        if v == 0 || (0x300...0x36F).contains(v) || (0x200B...0x200F).contains(v) || (0xFE00...0xFE0F).contains(v) || v == 0x20E3 { return 0 }
        if (0x1100...0x115F).contains(v) || (0x2E80...0x303E).contains(v) || (0x3041...0x33FF).contains(v)
            || (0x3400...0x4DBF).contains(v) || (0x4E00...0x9FFF).contains(v) || (0xA000...0xA4CF).contains(v)
            || (0xAC00...0xD7A3).contains(v) || (0xF900...0xFAFF).contains(v) || (0xFE30...0xFE4F).contains(v)
            || (0xFF00...0xFF60).contains(v) || (0xFFE0...0xFFE6).contains(v) || (0x1F300...0x1F64F).contains(v)
            || (0x1F900...0x1F9FF).contains(v) || (0x20000...0x3FFFD).contains(v) { return 2 }
        return 1
    }
}

extension CMUXClient {
    /// The terminal's styled cells and cursor. `scrollback` rows above the
    /// screen come along so the viewer keeps a little history.
    public func surfaceRenderGrid(workspaceId: String, surfaceId: String, scrollback: Int) async throws -> CMUXRenderGrid {
        let resp = try await call(method: "terminal.replay",
                                  params: .object([
                                      "workspace_id": .string(workspaceId),
                                      "surface_id": .string(surfaceId),
                                      "anchor": .string("screen"),
                                      "max_scrollback_rows": .int(Int64(max(0, scrollback))),
                                  ]))
        struct Wrapper: Decodable { let render_grid: CMUXRenderGrid? }
        guard let grid = try resp.unwrapResult().decode(Wrapper.self).render_grid else {
            throw CMUXRenderGridUnavailable()
        }
        return grid
    }
}

/// cmux answered without a render grid (an older build, or the terminal is
/// still starting); callers fall back to plain text.
public struct CMUXRenderGridUnavailable: Error {}
