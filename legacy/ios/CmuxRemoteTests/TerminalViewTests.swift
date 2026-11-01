import XCTest
@testable import CmuxRemote

final class TerminalViewTests: XCTestCase {
    func testBottomScrollPaddingMatchesFiveTerminalRows() {
        XCTAssertEqual(TerminalView.bottomScrollPaddingRows, 5)
        XCTAssertEqual(TerminalView.bottomScrollPadding(lineHeight: 10), 50)
    }
}
