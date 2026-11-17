import XCTest
import SharedKit
@testable import RelayServer

final class HybridScreenTests: XCTestCase {
    private let green = "\u{1B}[32m$\u{1B}[0m"

    func testPlainTextUntilAGridArrivesKeepsTheOldPlaceholderCursor() {
        var screen = HybridScreen()
        XCTAssertTrue(screen.acceptText(["$ ls"], at: 10))
        XCTAssertEqual(screen.screen(maxRows: 120, cols: 4), Screen(rev: 0, rows: ["$ ls"], cols: 4, cursor: CursorPos(x: 0, y: 0)))
    }

    func testGridsAreReadOnlyAfterChangesOrInputAndAtMostEveryInterval() {
        var screen = HybridScreen()
        XCTAssertTrue(screen.acceptText(["a"], at: 10))
        screen.acceptGrid(rows: ["a"], cursor: nil, at: 10)
        XCTAssertFalse(screen.acceptText(["a"], at: 11), "a quiet screen never pays for a grid")
        XCTAssertFalse(screen.acceptText(["a", "b"], at: 10.05), "changed, but too soon after the last grid")
        XCTAssertTrue(screen.acceptText(["a", "b"], at: 10.2), "the change is still owed a grid")
        screen.acceptGrid(rows: ["a", "b"], cursor: nil, at: 10.2)
        XCTAssertFalse(screen.acceptText(["a", "b"], at: 12))
        screen.noteInput(at: 12.5)
        XCTAssertTrue(screen.acceptText(["a", "b"], at: 12.7), "typing refreshes the cursor even without new text")
    }

    func testTheGridColorsTheMatchingTailAndKeepsTheScrollback() {
        var screen = HybridScreen()
        let text = ["old 1", "old 2", "$ ls", "a  b", "$ "]
        _ = screen.acceptText(text, at: 1)
        screen.acceptGrid(rows: [green + " ls", "a  b", green], cursor: CursorPos(x: 2, y: 2), at: 1)
        XCTAssertEqual(screen.screen(maxRows: 120, cols: 5), Screen(rev: 0, rows: ["old 1", "old 2", green + " ls", "a  b", green], cols: 5, cursor: CursorPos(x: 2, y: 4)))
        XCTAssertEqual(screen.screen(maxRows: 3, cols: 5).cursor, CursorPos(x: 2, y: 2), "trimming the top moves the cursor with the rows")
    }

    func testACursorOnABlankRowTheTextLeftOutIsStillShown() {
        var screen = HybridScreen()
        _ = screen.acceptText(["history", "$ make"], at: 1)
        screen.acceptGrid(rows: [green + " make", "", ""], cursor: CursorPos(x: 0, y: 1), at: 1)
        let shown = screen.screen(maxRows: 120, cols: 7)
        XCTAssertEqual(shown.rows, ["history", green + " make", ""])
        XCTAssertEqual(shown.cursor, CursorPos(x: 0, y: 2))
    }

    func testBetweenGridsRowsKeepTheirColorsAndTheCursorItsPlaceFromTheBottom() {
        var screen = HybridScreen()
        _ = screen.acceptText(["one", "$ run", "output 1"], at: 1)
        screen.acceptGrid(rows: [green + " run", "\u{1B}[31moutput 1\u{1B}[0m"], cursor: CursorPos(x: 8, y: 1), at: 1)
        // Output scrolled by one row before the next grid.
        XCTAssertFalse(screen.acceptText(["one", "$ run", "output 1", "output 2"], at: 1.05))
        let moved = screen.screen(maxRows: 120, cols: 8)
        XCTAssertEqual(moved.rows, ["one", green + " run", "\u{1B}[31moutput 1\u{1B}[0m", "output 2"], "a row that moved keeps its colors; a new row waits for the grid")
        XCTAssertEqual(moved.cursor, CursorPos(x: 8, y: 3))
        XCTAssertEqual(moved.rows.count, 4, "the row count follows the text, so viewers get diffs, not full redraws")
    }

    func testHiddenCursorAndAlignment() {
        var screen = HybridScreen()
        _ = screen.acceptText(["a", "b"], at: 1)
        screen.acceptGrid(rows: ["a", "b"], cursor: nil, at: 1)
        XCTAssertEqual(screen.screen(maxRows: 120, cols: 1).cursor, CursorPos(x: 0, y: 2), "hidden: one past the last row")
        XCTAssertEqual(HybridScreen.align(["x", "y", ""], in: ["p", "x", "y"]), 1)
        XCTAssertEqual(HybridScreen.align(["x", "y", ""], in: ["p", "x", "y", ""]), 1)
        XCTAssertNil(HybridScreen.align(["x", "z"], in: ["p", "x", "y"]))
        XCTAssertEqual(HybridScreen.plainText("\u{1B}[1;38;2;1;2;3mhi\u{1B}[0m  "), "hi")
    }
}
