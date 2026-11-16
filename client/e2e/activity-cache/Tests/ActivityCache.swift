import XCTest

/// Needs `node client/e2e/activity-cache/fixture.mjs` running and an app with no saved pairing.
final class ActivityCache: XCTestCase {
  private func fixture(_ path: String) {
    let done = expectation(description: path)
    URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:4496\(path)")!) { _, _, _ in done.fulfill() }.resume()
    wait(for: [done], timeout: 10)
  }
  private func dismissOffer(_ app: XCUIApplication) {
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
  }
  private func waitForValue(_ element: XCUIElement, _ value: String?, timeout: TimeInterval = 20) {
    let predicate = NSPredicate { object, _ in
      let current = (object as? XCUIElement)?.value as? String
      return value == nil ? (current ?? "").isEmpty : current == value
    }
    expectation(for: predicate, evaluatedWith: element); waitForExpectations(timeout: timeout)
  }
  private func shot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }

  func testRunningIndicatorsCompletionAndCachedScreenOffline() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    let control: (String) -> XCUIElement = { app.descendants(matching: .any).matching(identifier: $0).firstMatch }
    app.launch()
    dismissOffer(app)
    let pair = app.buttons["没法扫码？粘贴配对链接"]
    XCTAssertTrue(pair.waitForExistence(timeout: 10), "start without a saved pairing")
    pair.tap(); let input = app.secureTextFields.firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
    input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4497&relay=qa-activity&code=qa-pair-only")
    app.buttons["配对"].tap()
    if app.buttons["返回工作区"].waitForExistence(timeout: 5) { app.buttons["返回工作区"].tap() }
    dismissOffer(app)

    // The list shows which terminal is working, without opening it.
    let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "运行状态测试，")).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 20))
    waitForValue(card, "1 个正在运行")
    let runningRow = app.buttons["打开终端 运行中终端"]
    waitForValue(runningRow, "正在运行")
    XCTAssertTrue(((app.buttons["打开终端 空闲终端"].value as? String) ?? "").isEmpty)
    // One spinner on the card, one on the terminal's row.
    XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "terminal-running-indicator").count, 2)
    shot(app, "Workspace list with a running terminal")

    // Inside the workspace the tab says the same, and the finished turn raises an alert.
    app.buttons["打开终端 空闲终端"].tap()
    XCTAssertTrue(app.staticTexts["CACHED_SCREEN_0"].firstMatch.waitForExistence(timeout: 15))
    let runningTab = control("运行中终端")
    XCTAssertTrue(runningTab.waitForExistence(timeout: 5))
    waitForValue(runningTab, "正在运行")
    shot(app, "Terminal tabs with a running terminal")
    fixture("/finish")
    // The alert is one button whose label starts with its title; it hides after a few seconds.
    let alert = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "对话已完成")).firstMatch
    XCTAssertTrue(alert.waitForExistence(timeout: 20), "completion alert on the phone")
    shot(app, "Completion alert")
    waitForValue(runningTab, nil)

    // Offline after a restart: the last screen and the list come from the phone's cache.
    sleep(3)
    fixture("/offline")
    app.terminate(); app.launch()
    dismissOffer(app)
    XCTAssertTrue(app.staticTexts["CACHED_SCREEN_0"].firstMatch.waitForExistence(timeout: 10), "cached screen while the computer is offline")
    shot(app, "Cached terminal while offline")
    app.buttons["返回工作区"].tap()
    dismissOffer(app)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "运行状态测试，")).firstMatch.waitForExistence(timeout: 5), "cached workspace list while offline")
    // The card's × is not a separate accessibility element on iOS; the screenshot shows it dimmed.
    shot(app, "Cached workspace list while offline")
  }
}
