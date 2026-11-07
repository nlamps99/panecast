import XCTest

final class TerminalScroll: XCTestCase {
  private func stats(_ path: String = "/") throws -> [String: Any] {
    let received = expectation(description: "fixture response")
    var result: Result<Data, Error>!
    URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:4496\(path)")!) { data, _, error in
      result = error.map { .failure($0) } ?? .success(data ?? Data()); received.fulfill()
    }.resume()
    wait(for: [received], timeout: 5)
    return try JSONSerialization.jsonObject(with: result.get()) as! [String: Any]
  }

  private func prepared(_ key: String, minimum: Int) throws {
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      let result = try stats(), calls = result[key] as! [[String: Any]]
      if calls.count >= minimum, let last = calls.last?["at"] as? Double,
         Date().timeIntervalSince1970 * 1000 - last > 1200 { return }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTFail("History did not prepare a local runway")
  }

  private func visibleNumbers(_ app: XCUIApplication, output: XCUIElement, prefix: String) -> [Int] {
    let snapshot = app.debugDescription, text = snapshot as NSString, viewport = output.frame
    let attachment = XCTAttachment(string: snapshot)
    attachment.name = "Visible terminal positions for \(prefix)"; attachment.lifetime = .keepAlways; add(attachment)
    let pattern = #"StaticText[^\n]*\{\{[-0-9.]+, ([-0-9.]+)\}, \{[-0-9.]+, ([-0-9.]+)\}\}[^\n]*label: '"# + NSRegularExpression.escapedPattern(for: prefix) + #"([0-9]+)'"#
    let regex = try! NSRegularExpression(pattern: pattern)
    return regex.matches(in: snapshot, range: NSRange(location: 0, length: text.length)).compactMap { match in
      guard let y = Double(text.substring(with: match.range(at: 1))),
            let height = Double(text.substring(with: match.range(at: 2))),
            y + height > Double(viewport.minY), y < Double(viewport.maxY) else { return nil }
      return Int(text.substring(with: match.range(at: 3)))
    }
  }

  private func fling(_ output: XCUIElement) {
    let start = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
    let end = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(2000), thenHoldForDuration: 0)
  }

  func testCachedRowsMoveAcrossBothHistoryKindsWhileNetworkFramesAreDelayed() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    app.launch()
    if app.buttons["以后再说"].exists { app.buttons["以后再说"].tap() }
    let pair = app.buttons["没法扫码？粘贴配对链接"]
    if pair.waitForExistence(timeout: 5) {
      pair.tap()
      let input = app.secureTextFields.firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
      input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4495&relay=qa-scroll&code=qa-pair-only")
      app.buttons["配对"].tap()
    }
    let workspace = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "cmux 连续滚动测试，")).firstMatch
    if workspace.waitForExistence(timeout: 10) { workspace.tap() }
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    let output = app.otherElements["terminal-viewport"].firstMatch
    XCTAssertTrue(output.waitForExistence(timeout: 10))
    try prepared("historyCalls", minimum: 4)
    _ = try stats("/latency?ms=1800")
    fling(output)
    let primaryNumbers = visibleNumbers(app, output: output, prefix: "CMUX_HISTORY_")
    XCTAssertFalse(primaryNumbers.isEmpty)
    XCTAssertLessThan(primaryNumbers.min()!, 9940, "Native scrolling must cross the initial 47-row screen using cached rows")
    let primaryShot = XCTAttachment(screenshot: app.screenshot())
    primaryShot.name = "Primary history after one fling with delayed network"; primaryShot.lifetime = .keepAlways; add(primaryShot)

    _ = try stats("/latency?ms=500")
    app.otherElements["程序终端"].firstMatch.tap()
    let anchor = app.staticTexts["APP_HISTORY_1025"].firstMatch
    XCTAssertTrue(anchor.waitForExistence(timeout: 10))
    let touch = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
    let moved = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
    touch.press(forDuration: 0.05, thenDragTo: moved, withVelocity: XCUIGestureVelocity(100), thenHoldForDuration: 0.2)
    let anchorY = anchor.frame.minY
    try prepared("calls", minimum: 3)
    XCTAssertTrue(anchor.exists && anchor.isHittable, "Prefetch must retain the screen being read")
    XCTAssertEqual(anchor.frame.minY, anchorY, accuracy: 1, "Remote captures must not move a visible row")
    _ = try stats("/latency?ms=1800")
    fling(output)
    let applicationNumbers = visibleNumbers(app, output: output, prefix: "APP_HISTORY_")
    XCTAssertFalse(applicationNumbers.isEmpty)
    XCTAssertLessThan(applicationNumbers.min()!, 995, "The same native fling must enter earlier cached application history")
    let appShot = XCTAttachment(screenshot: app.screenshot())
    appShot.name = "Application history after one fling with delayed network"; appShot.lifetime = .keepAlways; add(appShot)
  }
}
