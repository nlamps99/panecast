import XCTest

final class TerminalKeys: XCTestCase {
  func testCtrlUpShowsRemoteResultAfterReadingHistory() {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    app.launch()
    if app.buttons["以后再说"].exists { app.buttons["以后再说"].tap() }
    let pair = app.buttons["没法扫码？粘贴配对链接"]
    if pair.waitForExistence(timeout: 5) {
      pair.tap()
      let input = app.secureTextFields.firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
      input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4499&relay=qa-keys&code=qa-pair-only")
      app.buttons["配对"].tap()
    }
    let key = app.buttons["发送 Ctrl 上箭头"]
    if !key.waitForExistence(timeout: 2) {
      let workspace = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "快捷键回归测试，")).firstMatch
      XCTAssertTrue(workspace.waitForExistence(timeout: 20)); workspace.tap()
    }
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    XCTAssertTrue(key.waitForExistence(timeout: 10)); XCTAssertTrue(key.isEnabled)
    let output = app.otherElements["terminal-viewport"].firstMatch
    XCTAssertTrue(output.waitForExistence(timeout: 5))
    for _ in 0..<3 { output.swipeDown() }
    XCTAssertTrue(app.otherElements["terminal-history-status"].waitForExistence(timeout: 5))
    key.tap()
    XCTAssertTrue(app.staticTexts["CTRL_UP_RECEIVED_1"].firstMatch.waitForExistence(timeout: 10))
    XCTAssertFalse(app.otherElements["terminal-history-status"].exists)
    key.tap()
    XCTAssertTrue(app.staticTexts["CTRL_UP_RECEIVED_2"].firstMatch.waitForExistence(timeout: 10))
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Ctrl Up shows the remote result"; screenshot.lifetime = .keepAlways; add(screenshot)
  }
}
