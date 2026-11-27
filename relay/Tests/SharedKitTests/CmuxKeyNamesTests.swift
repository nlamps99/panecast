import XCTest
@testable import SharedKit

final class CmuxKeyNamesTests: XCTestCase {
    private typealias T = CmuxKeyNames.Translation

    func testOldPageNamesBecomeCmuxNames() {
        XCTAssertEqual(CmuxKeyNames.translate("pgup"), T.key("pageup"))
        XCTAssertEqual(CmuxKeyNames.translate("pgdn"), T.key("pagedown"))
        XCTAssertEqual(CmuxKeyNames.translate("PgUp"), T.key("pageup"))
        XCTAssertEqual(CmuxKeyNames.translate("page-down"), T.key("page-down"), "not a key name; left for cmux to refuse")
        XCTAssertEqual(CmuxKeyNames.translate("ins"), T.text("\u{1B}[2~"))
    }

    func testNamesCmuxKnowsPassThroughUntouched() {
        for name in ["enter", "return", "tab", "escape", "esc", "backspace", "delete", "space",
                     "up", "down", "left", "right", "home", "end", "pageup", "page_down",
                     "ctrl-c", "ctrl+c", "ctrl-\\", "shift-tab", "backtab", "ctrl-x", "alt-left",
                     "ctrl-alt-shift-up", "cmd-k", "ENTER"] {
            XCTAssertEqual(CmuxKeyNames.translate(name), T.key(name), name)
        }
    }

    func testChordsAreRespelledTheWayCmuxSplitsThem() {
        XCTAssertEqual(CmuxKeyNames.translate("ctrl+x"), T.key("ctrl-x"))
        XCTAssertEqual(CmuxKeyNames.translate("shift-esc"), T.key("shift-escape"))
        XCTAssertEqual(CmuxKeyNames.translate("meta-b"), T.key("alt-b"))
        XCTAssertEqual(CmuxKeyNames.translate("shift-ctrl-arrowleft"), T.key("ctrl-shift-left"))
    }

    func testModifiedNavigationKeysAreXtermSequences() {
        XCTAssertEqual(CmuxKeyNames.translate("shift-pgup"), T.text("\u{1B}[5;2~"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-pgdn"), T.text("\u{1B}[6;5~"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-home"), T.text("\u{1B}[1;5H"))
        XCTAssertEqual(CmuxKeyNames.translate("shift-end"), T.text("\u{1B}[1;2F"))
        XCTAssertEqual(CmuxKeyNames.translate("alt-shift-insert"), T.text("\u{1B}[2;4~"))
    }

    func testFunctionKeys() {
        XCTAssertEqual(CmuxKeyNames.translate("f1"), T.text("\u{1B}[11~"))
        XCTAssertEqual(CmuxKeyNames.translate("F4"), T.text("\u{1B}[14~"))
        XCTAssertEqual(CmuxKeyNames.translate("f5"), T.text("\u{1B}[15~"))
        XCTAssertEqual(CmuxKeyNames.translate("f6"), T.text("\u{1B}[17~"))
        XCTAssertEqual(CmuxKeyNames.translate("f12"), T.text("\u{1B}[24~"))
        XCTAssertEqual(CmuxKeyNames.translate("shift-f1"), T.text("\u{1B}[1;2P"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-f3"), T.text("\u{1B}[13;5~"), "CSI 1;5R would be taken for a cursor report")
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-shift-f5"), T.text("\u{1B}[15;6~"))
        XCTAssertEqual(CmuxKeyNames.translate("f13"), T.key("f13"))
    }

    func testControlSymbolsBecomeControlBytes() {
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-/"), T.text("\u{1F}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-_"), T.text("\u{1F}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl--"), T.text("\u{1F}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-]"), T.text("\u{1D}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-^"), T.text("\u{1E}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-@"), T.text("\u{00}"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-["), T.key("escape"))
        XCTAssertEqual(CmuxKeyNames.translate("ctrl-?"), T.key("backspace"))
        XCTAssertEqual(CmuxKeyNames.translate("alt-/"), T.key("alt-/"), "only plain Ctrl chords have a control byte")
    }

    func testUnknownNamesAreLeftForCmuxToRefuse() {
        XCTAssertEqual(CmuxKeyNames.translate("hyper-x"), T.key("hyper-x"))
        XCTAssertEqual(CmuxKeyNames.translate("menu"), T.key("menu"))
    }

    /// cmux hands a complete CSI sequence to the program unchanged, except
    /// the finals it reads as terminal reports (R c n u y t), and splits
    /// `ESC O …` into Escape plus typed text.
    func testEverySequenceIsOneCmuxPassesThrough() {
        let names = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "insert"]
            + ["shift", "alt", "ctrl", "ctrl-shift", "ctrl-alt-shift-cmd"].flatMap { mods in
                ["f1", "f2", "f3", "f4", "f8", "f12", "home", "end", "pgup", "pgdn", "insert"].map { "\(mods)-\($0)" }
            }
        for name in names {
            guard case .text(let text) = CmuxKeyNames.translate(name) else { return XCTFail("\(name) should be a sequence") }
            let scalars = Array(text.unicodeScalars)
            XCTAssertEqual(scalars.first, "\u{1B}", name)
            XCTAssertEqual(scalars.dropFirst().first, "[", name)
            let final = scalars.last!
            XCTAssertTrue((0x40...0x7E).contains(final.value), name)
            XCTAssertFalse("Rcnuyt".unicodeScalars.contains(final), "\(name) ends like a terminal report")
            XCTAssertTrue(scalars.dropFirst(2).dropLast().allSatisfy { (0x30...0x3F).contains($0.value) }, name)
        }
    }

    func testKeyEncoderPageKeysReachCmuxUnderItsNames() {
        XCTAssertEqual(CmuxKeyNames.translate(KeyEncoder.encode(.pageUp)), T.key("pageup"))
        XCTAssertEqual(CmuxKeyNames.translate(KeyEncoder.encode(.named("pgdn", modifiers: [.shift]))), T.text("\u{1B}[6;2~"))
    }
}
