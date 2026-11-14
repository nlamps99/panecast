import AppKit
import XCTest

final class WindowLifecycle: XCTestCase {
  let identifier = "com.nzx.panecast.window-tests"
  func testCloseReopenQuitAndNativeConfirmation() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: identifier)
    app.launch()
    let window = app.windows.firstMatch
    XCTAssertTrue(window.waitForExistence(timeout: 15))
    let prompt = app.buttons["Test close confirmation"]
    XCTAssertTrue(prompt.waitForExistence(timeout: 10)); prompt.click()
    XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5)); app.buttons["取消"].click()
    XCTAssertTrue(app.staticTexts["cancelled"].waitForExistence(timeout: 5))
    prompt.click(); XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 5)); app.buttons["关闭"].click()
    XCTAssertTrue(app.staticTexts["confirmed"].waitForExistence(timeout: 5))
    window.buttons["_XCUI:CloseWindow"].click()
    expectation(for: NSPredicate(format: "count == 0"), evaluatedWith: app.windows)
    waitForExpectations(timeout: 10)
    XCTAssertNotEqual(app.state, .notRunning)
    try reopen(app)
    app.menuBars.menuBarItems["文件"].click()
    app.menuBars.menuItems["关闭窗口"].click()
    expectation(for: NSPredicate(format: "count == 0"), evaluatedWith: app.windows)
    waitForExpectations(timeout: 10)
    try reopen(app)
    app.typeKey("w", modifierFlags: .command)
    expectation(for: NSPredicate(format: "count == 0"), evaluatedWith: app.windows)
    waitForExpectations(timeout: 10)
    try reopen(app)
    app.typeKey("q", modifierFlags: .command)
    expectation(for: NSPredicate { _, _ in app.state == .notRunning }, evaluatedWith: app)
    waitForExpectations(timeout: 10)
  }
  private func reopen(_ app: XCUIApplication) throws {
    let url = try XCTUnwrap(NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier))
    let done = expectation(description: "reopen test app")
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      XCTAssertNil(error); done.fulfill()
    }
    wait(for: [done], timeout: 10)
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
  }
}
