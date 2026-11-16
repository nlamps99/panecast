import XCTest

/// How much of the phone the terminal gets, with and without the keyboard. Build 16
/// gave it 52% of an iPhone 15 Pro (26 rows) and 32% of the space above the
/// keyboard (11 rows); build 17 gives 67% (33 rows) and 56% (20 rows).
final class TerminalLayout: XCTestCase {
  private func viewport(_ app: XCUIApplication) -> CGRect {
    app.descendants(matching: .any).matching(identifier: "terminal-viewport").firstMatch.frame
  }

  private func attach(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
  }

  func testTerminalGetsMostOfThePhone() throws {
    let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    app.launch()
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    let pair = app.buttons["没法扫码？粘贴配对链接"]
    if pair.waitForExistence(timeout: 5) {
      pair.tap(); let input = app.secureTextFields.firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
      input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4491&relay=qa-layout&code=qa-pair-only")
      app.buttons["配对"].tap()
    }
    if app.buttons["返回工作区"].waitForExistence(timeout: 5) { app.buttons["返回工作区"].tap() }
    let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "布局测量，")).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 20)); card.tap()
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "for shortcuts")).firstMatch.waitForExistence(timeout: 15))
    sleep(1)

    let screen = app.windows.firstMatch.frame
    XCTAssertGreaterThan(viewport(app).height / screen.height, 0.62, "terminal share of the screen without the keyboard")
    attach(app, "terminal")

    // Files, search and copy, wrapping and text size are in the "⋯" menu instead of rows above the terminal.
    XCTAssertFalse(app.buttons["搜索和复制终端输出"].exists)
    XCTAssertFalse(app.staticTexts["向上滑动查看历史"].exists)
    app.buttons["更多：文件、搜索复制、折行、字号"].tap()
    XCTAssertTrue(app.buttons["搜索和复制终端输出"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["放大文字"].exists)
    // A sheet row's label carries its detail line too.
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "项目文件与 Git 改动")).firstMatch.exists)
    attach(app, "menu")
    app.buttons["关闭"].firstMatch.tap(); sleep(1)

    // History status floats over the text while browsing, without resizing the terminal.
    let before = viewport(app)
    app.descendants(matching: .any).matching(identifier: "terminal-output-list").firstMatch.swipeDown(); sleep(1)
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "terminal-history-status").firstMatch.exists)
    XCTAssertEqual(viewport(app), before)
    attach(app, "browsing")
    app.buttons["回到最新输出"].tap(); sleep(1)

    // While typing, only the keys and the input stay below the terminal.
    let input = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
    input.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5)); sleep(1)
    XCTAssertFalse(app.buttons["常用输入 · 最近输入"].exists)
    XCTAssertTrue(app.buttons["发送 Esc"].exists)
    let above = screen.height - app.keyboards.firstMatch.frame.height
    XCTAssertGreaterThan(viewport(app).height / above, 0.5, "terminal share of the space above the keyboard")
    attach(app, "keyboard")
  }
}
