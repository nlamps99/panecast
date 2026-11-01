import XCTest
import SharedKit
@testable import CmuxRemote

final class CellGridTests: XCTestCase {
    func testReplaceRowParsesAnsi() {
        var grid = CellGrid(cols: 80, rows: 3)
        grid.replaceRow(1, raw: "\u{1B}[31mok\u{1B}[0m")
        XCTAssertEqual(grid.rows[1].first?.character, "o")
        XCTAssertEqual(grid.rows[1].first?.attr.fg, .red)
        XCTAssertEqual(grid.rawRows[1], "\u{1B}[31mok\u{1B}[0m")
    }

    func testReplaceRowPrecomputesRenderRuns() {
        var grid = CellGrid(cols: 80, rows: 1)
        grid.replaceRow(0, raw: "\u{1B}[32mhello\u{1B}[0m \u{1B}[38;5;202mworld")

        XCTAssertEqual(grid.renderRows[0].columns, 11)
        XCTAssertEqual(grid.maxRenderedColumns, 11)
        XCTAssertEqual(grid.renderRows[0].plainText, "hello world")
        XCTAssertEqual(grid.renderRows[0].runs.map(\.text), ["hello", " ", "world"])
        XCTAssertEqual(grid.renderRows[0].runs[0].attr.fg, .green)
        XCTAssertEqual(grid.renderRows[0].runs[2].attr.fg, .indexed(202))
    }

    func testRenderRunsPinWideGlyphsToColumns() {
        var grid = CellGrid(cols: 80, rows: 1)
        grid.replaceRow(0, raw: "A한B")

        let runs = grid.renderRows[0].runs
        XCTAssertEqual(runs.map(\.text), ["A", "한", "B"])
        XCTAssertEqual(runs.map(\.startColumn), [0, 1, 3])
        XCTAssertEqual(runs.map(\.columns), [1, 2, 1])
        XCTAssertEqual(grid.renderRows[0].columns, 4)
    }

    func testMaxRenderedColumnsShrinksWhenLongestRowIsReplaced() {
        var grid = CellGrid(cols: 80, rows: 2)
        grid.replaceRow(0, raw: "long")
        grid.replaceRow(1, raw: "xx")
        XCTAssertEqual(grid.maxRenderedColumns, 4)

        grid.replaceRow(0, raw: "y")

        XCTAssertEqual(grid.maxRenderedColumns, 2)
    }

    func testClearEmpties() {
        var grid = CellGrid(cols: 10, rows: 2)
        grid.replaceRow(0, raw: "hi")
        grid.clear()
        XCTAssertEqual(grid.rows[0].count, 0)
        XCTAssertEqual(grid.rawRows[0], "")
        XCTAssertEqual(grid.renderRows[0].runs.count, 0)
        XCTAssertEqual(grid.maxRenderedColumns, 0)
    }
}
