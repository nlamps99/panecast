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

  func testOneFlingContinuesAcrossRemoteFramesWithSlowAcknowledgements() throws {
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
    XCTAssertTrue(app.staticTexts["连续滑动查看程序内历史"].waitForExistence(timeout: 10))
    // Position at the edge, then measure exactly one further gesture.
    output.swipeDown(velocity: .slow)
    output.swipeDown(velocity: .slow)
    let ready = expectation(description: "previous gesture settles")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) { ready.fulfill() }
    wait(for: [ready], timeout: 3)
    _ = try stats("/reset")
    let start = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
    let end = output.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(2000), thenHoldForDuration: 0)
    let settled = expectation(description: "inertia settles")
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { settled.fulfill() }
    wait(for: [settled], timeout: 3)
    let result = try stats()
    let calls = result["calls"] as! [[String: Any]]
    let fingerLines = Int(output.frame.height * 0.6 / 17)
    XCTAssertGreaterThan(result["total"] as! Int, fingerLines + 8, "One fling must continue beyond the finger's travel")
    XCTAssertGreaterThan(calls.count, 12)
    XCTAssertTrue(calls.allSatisfy { abs($0["lines"] as! Int) <= 4 }, "No screen-sized scroll batches")
    XCTAssertGreaterThan(result["frames"] as! Int, 5)
    XCTAssertGreaterThan((calls.last!["at"] as! Double) - (calls.first!["at"] as! Double), 800)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "cmux after one continuous fling"; screenshot.lifetime = .keepAlways; add(screenshot)
  }
}
