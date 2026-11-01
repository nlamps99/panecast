import XCTest
import UIKit
import SharedKit
@testable import CmuxRemote

final class TerminalVisualLayoutTests: XCTestCase {
    func testLongRowsWrapToTheViewportWithoutLosingAttributes() {
        let green = ANSIAttr(fg: .green, bg: .default, bold: false, underline: false)
        let cells = [
            ANSICell(character: "a", attr: .default),
            ANSICell(character: "b", attr: .default),
            ANSICell(character: "c", attr: green),
            ANSICell(character: "d", attr: green),
            ANSICell(character: "e", attr: green),
        ]

        let layout = TerminalVisualLayout.make(
            rows: [cells],
            cursor: CursorPos(x: 4, y: 0),
            wrappingAt: 3
        )

        XCTAssertEqual(layout.rows.map(\.plainText), ["abc", "de"])
        XCTAssertEqual(layout.rows[0].runs.last?.attr, green)
        XCTAssertEqual(layout.rows[1].runs.first?.attr, green)
        XCTAssertEqual(layout.cursor, CursorPos(x: 1, y: 1))
    }

    func testWideCharactersNeverSplitAcrossVisualRows() {
        let cells = ANSIParser.parse("A한B", base: .default)

        let layout = TerminalVisualLayout.make(
            rows: [cells],
            cursor: CursorPos(x: 0, y: 0),
            wrappingAt: 3
        )

        XCTAssertEqual(layout.rows.map(\.plainText), ["A한", "B"])
        XCTAssertEqual(layout.rows.map(\.columns), [3, 1])
    }

    func testFullWidthRuleRowIsTrimmedToTheViewport() {
        let rule = ANSIParser.parse(String(repeating: "─", count: 156), base: .default)

        XCTAssertEqual(TerminalRuleRow.fit(rule, columns: 40).count, 40)
    }

    func testIndentedRuleKeepsItsIndent() {
        let rule = ANSIParser.parse("  " + String(repeating: "=", count: 60), base: .default)

        let fitted = TerminalRuleRow.fit(rule, columns: 40)

        XCTAssertEqual(fitted.count, 40)
        XCTAssertEqual(fitted.prefix(3).map(\.character), [" ", " ", "="])
    }

    func testRowsWithTextAreNeverTrimmed() {
        let titled = ANSIParser.parse("── Title " + String(repeating: "─", count: 60), base: .default)
        let prose = ANSIParser.parse(String(repeating: "word ", count: 30), base: .default)

        XCTAssertEqual(TerminalRuleRow.fit(titled, columns: 40), titled)
        XCTAssertEqual(TerminalRuleRow.fit(prose, columns: 40), prose)
    }

    func testRuleThatAlreadyFitsIsUnchanged() {
        let rule = ANSIParser.parse(String(repeating: "─", count: 30), base: .default)

        XCTAssertEqual(TerminalRuleRow.fit(rule, columns: 40), rule)
    }

    func testFittedRuleRendersOnOneVisualLine() throws {
        let textWidth: CGFloat = 365
        let lineHeight: CGFloat = 17
        let columns = try XCTUnwrap(
            TerminalHistoryTextRenderer.viewportColumns(fitting: textWidth, fontSize: 15)
        )

        let text = TerminalHistoryTextRenderer.make(
            rows: [String(repeating: "─", count: 156)],
            fontSize: 15,
            lineHeight: lineHeight,
            viewportColumns: columns
        )
        let height = text.boundingRect(
            with: CGSize(width: textWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height

        XCTAssertLessThan(height, lineHeight * 1.5)
    }

    func testViewportColumnsAreUnknownBeforeTheViewportHasWidth() {
        XCTAssertNil(TerminalHistoryTextRenderer.viewportColumns(fitting: 0, fontSize: 15))
    }
}
