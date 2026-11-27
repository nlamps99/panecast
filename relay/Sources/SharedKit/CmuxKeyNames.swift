import Foundation

/// Translates the key names clients send into what cmux's `surface.send_key`
/// accepts.
///
/// cmux (`TerminalSurface.pendingKeyEvent(for:)`) knows a fixed vocabulary:
/// `enter`/`return`, `tab`, `escape`/`esc`, `backspace`, `delete`/`del`,
/// `space`, the arrows, `home`, `end`, `pageup`/`page_up`,
/// `pagedown`/`page_down`, `shift-tab`, a few control chords, and
/// `<modifiers>-<letter or one of the plain named keys>`. Anything else fails
/// with "unknown key". Clients have long sent `pgup`/`pgdn` (the SharedKit
/// `KeyEncoder` names), F-keys, modified Home/End/PageUp/PageDown and
/// Ctrl-symbol chords; those either get the cmux spelling here or, when cmux
/// has no key for them, the xterm byte sequence to send with
/// `surface.send_text` instead. cmux passes a complete CSI sequence through to
/// the program unchanged, so only CSI forms are produced (SS3 `ESC O P` would
/// be split into Escape plus typed text).
public enum CmuxKeyNames {
    public enum Translation: Equatable, Sendable {
        /// Send with `surface.send_key` under this name.
        case key(String)
        /// cmux has no key for it: send these bytes with `surface.send_text`.
        case text(String)
    }

    public static func translate(_ name: String) -> Translation {
        let lowered = name.lowercased()
        if exactNames.contains(lowered) { return .key(name) }
        guard let (modifiers, base) = split(lowered) else { return .key(name) }
        let canonical = baseAliases[base] ?? base

        if modifiers.isEmpty {
            switch canonical {
            case "insert": return .text("\u{1B}[2~")
            default:
                if let sequence = functionKey(canonical, modifier: 1) { return .text(sequence) }
                return canonical == base ? .key(name) : .key(canonical)
            }
        }

        if modifiers == [.ctrl], let control = controlCharacter(for: canonical) { return control }
        // cmux builds chords only from letters and its plain named keys.
        if chordBases.contains(canonical) || isLetter(canonical) {
            return .key((modifiers.map(\.cmuxName) + [canonical]).joined(separator: "-"))
        }
        let parameter = 1 + modifiers.reduce(0) { $0 + $1.xtermWeight }
        switch canonical {
        case "home": return .text("\u{1B}[1;\(parameter)H")
        case "end": return .text("\u{1B}[1;\(parameter)F")
        case "pageup": return .text("\u{1B}[5;\(parameter)~")
        case "pagedown": return .text("\u{1B}[6;\(parameter)~")
        case "insert": return .text("\u{1B}[2;\(parameter)~")
        default:
            if let sequence = functionKey(canonical, modifier: parameter) { return .text(sequence) }
            return .key(name)
        }
    }

    // MARK: - cmux vocabulary

    /// Names `pendingKeyEvent(for:)` matches before splitting on modifiers.
    static let exactNames: Set<String> = [
        "ctrl-c", "ctrl+c", "sigint", "ctrl-d", "ctrl+d", "eof", "ctrl-f", "ctrl+f",
        "ctrl-z", "ctrl+z", "sigtstp", "ctrl-\\", "ctrl+\\", "sigquit",
        "enter", "return", "tab", "escape", "esc", "backspace",
        "up", "arrow_up", "arrowup", "down", "arrow_down", "arrowdown",
        "left", "arrow_left", "arrowleft", "right", "arrow_right", "arrowright",
        "shift+tab", "shift-tab", "backtab", "home", "end", "delete", "del", "forward_delete",
        "pageup", "page_up", "pagedown", "page_down", "space",
    ]

    /// Base keys cmux accepts after modifiers (`keycodeForNamedKey`).
    static let chordBases: Set<String> = [
        "enter", "return", "tab", "escape", "esc", "backspace", "delete", "space",
        "up", "down", "left", "right", "\\",
    ]

    static let baseAliases: [String: String] = [
        "pgup": "pageup", "page_up": "pageup", "prior": "pageup",
        "pgdn": "pagedown", "pgdown": "pagedown", "page_down": "pagedown", "next": "pagedown",
        "ins": "insert", "del": "delete", "forward_delete": "delete", "esc": "escape",
        "return": "enter", "arrowup": "up", "arrow_up": "up", "arrowdown": "down", "arrow_down": "down",
        "arrowleft": "left", "arrow_left": "left", "arrowright": "right", "arrow_right": "right",
    ]

    enum Modifier: CaseIterable {
        case ctrl, alt, shift, cmd

        var cmuxName: String {
            switch self {
            case .ctrl: return "ctrl"
            case .alt: return "alt"
            case .shift: return "shift"
            case .cmd: return "cmd"
            }
        }

        /// xterm's modifier parameter is 1 plus these.
        var xtermWeight: Int {
            switch self {
            case .shift: return 1
            case .alt: return 2
            case .ctrl: return 4
            case .cmd: return 8
            }
        }

        init?(_ word: Substring) {
            switch word {
            case "ctrl", "control": self = .ctrl
            case "alt", "opt", "option", "meta": self = .alt
            case "shift": self = .shift
            case "cmd", "command", "super": self = .cmd
            default: return nil
            }
        }
    }

    /// `ctrl-shift-pgup` → ([ctrl, shift], "pgup"); nil unless every part
    /// before the last is a modifier.
    static func split(_ name: String) -> ([Modifier], String)? {
        var parts = name.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "-" || $0 == "+" })
        // `ctrl--` and `ctrl-+`: the key itself is the separator character.
        if parts.count >= 2, parts.last?.isEmpty == true, parts[parts.count - 2].isEmpty {
            parts.removeLast(2)
            parts.append(Substring(String(name.last!)))
        }
        guard let base = parts.popLast(), !base.isEmpty else { return nil }
        var modifiers: Set<Modifier> = []
        for part in parts {
            guard let modifier = Modifier(part) else { return nil }
            modifiers.insert(modifier)
        }
        return (Modifier.allCases.filter(modifiers.contains), String(base))
    }

    static func isLetter(_ name: String) -> Bool {
        name.count == 1 && name.unicodeScalars.allSatisfy { ("a"..."z").contains($0) }
    }

    /// xterm function keys as CSI: F1–F4 unmodified use the `CSI 1x ~` form
    /// cmux passes through; modified F3 avoids `CSI 1;m R`, which cmux
    /// mistakes for a cursor position report.
    static func functionKey(_ name: String, modifier: Int) -> String? {
        guard name.hasPrefix("f"), let number = Int(name.dropFirst()), (1...12).contains(number) else { return nil }
        let tilde: [Int: Int] = [1: 11, 2: 12, 3: 13, 4: 14, 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24]
        if modifier > 1, number <= 4, number != 3 {
            let final = ["P", "Q", "R", "S"][number - 1]
            return "\u{1B}[1;\(modifier)\(final)"
        }
        let code = tilde[number]!
        return modifier > 1 ? "\u{1B}[\(code);\(modifier)~" : "\u{1B}[\(code)~"
    }

    /// Ctrl with a symbol is a control byte cmux has no key for.
    static func controlCharacter(for name: String) -> Translation? {
        switch name {
        case "@", "2": return .text("\u{00}")
        case "[", "3": return .key("escape")
        case "4": return .key("ctrl-\\")
        case "]", "5": return .text("\u{1D}")
        case "^", "6": return .text("\u{1E}")
        case "_", "/", "-", "7": return .text("\u{1F}")
        case "?", "8": return .key("backspace")
        default: return nil
        }
    }
}
