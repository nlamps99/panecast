import XCTest
import SharedKit
@testable import CMUXClient

final class CMUXRenderGridTests: XCTestCase {
    private func decode(_ json: String) throws -> CMUXRenderGrid {
        try JSONDecoder().decode(CMUXRenderGrid.self, from: Data(json.utf8))
    }

    func testStyledSpansBecomeSGRRowsAndTheCursorIsPlacedBelowScrollback() throws {
        let grid = try decode("""
        {"format":"cmux.render-grid.v1","surface_id":"s","state_seq":1,"columns":20,"rows":2,
         "cursor":{"row":1,"column":4,"visible":true,"style":"block","blinking":false},
         "styles":[{"id":0},{"id":1,"foreground_source":"palette","foreground_palette_index":2,"bold":true},
                   {"id":2,"foreground_source":"rgb","foreground":"#ff8000","background_source":"palette","background_palette_index":12},
                   {"id":3,"foreground_source":"default","foreground":"#c0caf5","inverse":true}],
         "row_spans":[{"row":0,"column":0,"style_id":1,"text":"ok"},{"row":0,"column":3,"style_id":0,"text":"done   "},
                      {"row":1,"column":0,"style_id":0,"text":"$ ls"},{"row":1,"column":6,"style_id":2,"text":"x"},
                      {"row":1,"column":8,"style_id":3,"text":" "}],
         "scrollback_rows":1,"scrollback_spans":[{"row":0,"column":0,"style_id":0,"text":"older"}],
         "active_screen":"primary","anchor":"screen"}
        """)
        let screen = grid.toScreen(rev: 7, maxRows: 120)
        XCTAssertEqual(screen.rows, [
            "older",
            "\u{1B}[1;32mok\u{1B}[0m done",
            "$ ls  \u{1B}[38;2;255;128;0;104mx\u{1B}[0m \u{1B}[7m \u{1B}[0m",
        ])
        XCTAssertEqual(screen.cursor, CursorPos(x: 4, y: 2), "cursor rows count from the top of the returned rows")
        XCTAssertEqual(screen.cols, 20)
    }

    func testHiddenCursorSitsPastTheLastRowAndTrimmingKeepsTheScreen() throws {
        let grid = CMUXRenderGrid(columns: 10, rows: 2, cursor: .init(row: 0, column: 3, visible: false), styles: [],
                                  rowSpans: [.init(row: 0, column: 0, text: "a"), .init(row: 1, column: 0, text: "b")],
                                  scrollbackRows: 3, scrollbackSpans: [.init(row: 2, column: 0, text: "h")])
        let screen = grid.toScreen(rev: 0, maxRows: 3)
        XCTAssertEqual(screen.rows, ["h", "a", "b"])
        XCTAssertEqual(screen.cursor, CursorPos(x: 0, y: 3))

        let shown = CMUXRenderGrid(columns: 10, rows: 2, cursor: .init(row: 1, column: 12), styles: [],
                                   rowSpans: [], scrollbackRows: 3, scrollbackSpans: [])
        XCTAssertEqual(shown.toScreen(rev: 0, maxRows: 3).cursor, CursorPos(x: 9, y: 2), "clamped into the row, below the kept history")
    }

    func testWideCharactersAdvanceTwoCellsWhenCmuxOmitsTheWidth() {
        let grid = CMUXRenderGrid(columns: 20, rows: 1, cursor: nil, styles: [],
                                  rowSpans: [.init(row: 0, column: 0, text: "中文"), .init(row: 0, column: 6, text: "x"),
                                             .init(row: 0, column: 8, text: "y", cellWidth: 1)])
        XCTAssertEqual(grid.toScreen(rev: 0, maxRows: 1).rows, ["中文  x y"])
    }

    func testControlCharactersNeverReachTheViewer() {
        let grid = CMUXRenderGrid(columns: 20, rows: 1, cursor: nil, styles: [],
                                  rowSpans: [.init(row: 0, column: 0, text: "a\u{1B}[2Jb\u{07}")])
        XCTAssertEqual(grid.toScreen(rev: 0, maxRows: 1).rows, ["a[2Jb"])
    }

    func testPaletteColorsUseTheShortFormsViewersKnow() {
        XCTAssertEqual(CMUXRenderGrid.colorSGR(source: "palette", hex: nil, palette: 1, base: 30), "31")
        XCTAssertEqual(CMUXRenderGrid.colorSGR(source: "palette", hex: nil, palette: 9, base: 30), "91")
        XCTAssertEqual(CMUXRenderGrid.colorSGR(source: nil, hex: nil, palette: 200, base: 40), "48;5;200")
        XCTAssertNil(CMUXRenderGrid.colorSGR(source: "default", hex: "#ffffff", palette: nil, base: 30))
        XCTAssertNil(CMUXRenderGrid.colorSGR(source: "rgb", hex: "zz", palette: nil, base: 30))
    }
}
