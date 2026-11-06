import XCTest
final class Smoke: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
  func openSources() {
    continueAfterFailure = false
    if app.state == .notRunning { app.launch() } else { app.activate() }
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let openAlert = springboard.alerts.matching(NSPredicate(format: "label CONTAINS %@", "Panecast")).firstMatch
    if openAlert.waitForExistence(timeout: 1), openAlert.buttons["Open"].exists { openAlert.buttons["Open"].tap() }
    if app.buttons["以后再说"].exists { app.buttons["以后再说"].tap() }
    if app.buttons["没法扫码？粘贴配对链接"].waitForExistence(timeout: 3) {
      app.buttons["没法扫码？粘贴配对链接"].tap()
      let input = app.secureTextFields.firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
      input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4498&relay=qa-mac&code=qa-pair-only")
      app.buttons["配对"].tap()
    }
    let tab = app.otherElements["来源"].firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 15)); tab.tap()
    let source = app.buttons["打开 Codex 模拟器测试"]
    for _ in 0..<3 {
      if named("长会话回归测试").exists { return }
      if source.waitForExistence(timeout: 2) { source.tap() }
      else if app.buttons["返回"].exists { app.buttons["返回"].tap() }
    }
  }
  func named(_ name: String) -> XCUIElement { app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch }
  func snapshot(_ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
  }
  func fixture(_ values: [String: Any]? = nil) -> [String: Any] {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:4497/")!)
    if let values { request.httpMethod = "POST"; request.httpBody = try! JSONSerialization.data(withJSONObject: values) }
    let done = expectation(description: "Local history fixture")
    var result: [String: Any] = [:]
    URLSession.shared.dataTask(with: request) { data, _, _ in
      if let data { result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 10)
    return result
  }
  func testConversationWorkflow() {
    openSources()
    for _ in 0..<3 {
      let long = named("长会话回归测试")
      XCTAssertTrue(long.waitForExistence(timeout: 10)); long.tap()
      let resume = app.buttons["继续对话"]
      XCTAssertTrue(resume.waitForExistence(timeout: 15))
      XCTAssertTrue(resume.isEnabled)
      XCTAssertEqual(app.state, .runningForeground)
      app.swipeUp(); app.swipeDown()
      snapshot("Long conversation")
      app.buttons["返回"].tap()
    }
    let saved = named("继续对话回归测试")
    XCTAssertTrue(saved.waitForExistence(timeout: 10)); saved.tap()
    let resume = app.buttons["继续对话"]
    if resume.waitForExistence(timeout: 3) { resume.tap() }
    let composer = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Codex 消息")).firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText("simulator resume")
    app.buttons["发送"].tap()
    XCTAssertTrue(app.staticTexts["已收到模拟器消息"].firstMatch.waitForExistence(timeout: 10))
    snapshot("Resumed conversation")
    app.buttons["返回"].tap()
    XCTAssertTrue(app.buttons["新建对话"].waitForExistence(timeout: 10)); app.buttons["新建对话"].tap()
    let title = app.textFields.matching(NSPredicate(format: "label BEGINSWITH %@", "对话名称")).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 10)); title.tap(); title.typeText("Simulator new conversation")
    XCTAssertTrue(app.buttons["创建对话"].isEnabled); app.buttons["创建对话"].tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 15)); composer.tap(); composer.typeText("simulator new")
    app.buttons["发送"].tap()
    XCTAssertTrue(app.staticTexts["已收到模拟器消息"].firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(app.state, .runningForeground)
    snapshot("New conversation")
    print("PANECAST_WORKFLOW_PASSED: repeated long history, resume, new conversation, send and reply")
  }
  func testSteeringShowsReceiptAndPersistsMessage() {
    openSources()
    let active = named("追加指令回归测试")
    XCTAssertTrue(active.waitForExistence(timeout: 10)); active.tap()
    let composer = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Codex 消息")).firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText("Please check the failing test first")
    XCTAssertTrue(app.buttons["追加"].waitForExistence(timeout: 5)); app.buttons["追加"].tap()
    let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已送达 Codex")).firstMatch
    XCTAssertTrue(receipt.waitForExistence(timeout: 3))
    XCTAssertTrue(app.staticTexts["已按追加指令继续处理"].firstMatch.waitForExistence(timeout: 15))
    Thread.sleep(forTimeInterval: 2)
    if app.buttons["以后再说"].exists { app.buttons["以后再说"].tap() }
    // Selectable RN text has both a container and a text child in the AX tree.
    // Message identity/deduplication is verified by SourceStore tests.
    XCTAssertTrue(app.staticTexts["Please check the failing test first"].firstMatch.exists)
    XCTAssertFalse(receipt.exists)
    XCTAssertTrue(app.buttons["发送"].exists)
    XCTAssertFalse(app.buttons["追加"].exists)
    XCTAssertEqual(app.state, .runningForeground)
    snapshot("Steering receipt and recorded instruction")
  }
  func testToolsAreCollapsedAndCanBeExpandedWithoutHidingReplies() {
    openSources()
    let long = named("长会话回归测试")
    XCTAssertTrue(long.waitForExistence(timeout: 10)); long.tap()
    let tools = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "codex-tools-")).firstMatch
    XCTAssertTrue(tools.waitForExistence(timeout: 15))
    XCTAssertTrue(tools.label.hasPrefix("展开工具调用"))
    let details = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "codex-item-cmd-")).firstMatch
    XCTAssertFalse(details.exists)
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "轮已经完成")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 5))
    snapshot("Tools collapsed, conversation visible")
    tools.tap()
    XCTAssertTrue(details.waitForExistence(timeout: 5))
    XCTAssertTrue(tools.label.hasPrefix("收起工具调用"))
    snapshot("Tools expanded on demand")
    tools.tap()
    XCTAssertFalse(details.exists)
    XCTAssertTrue(reply.waitForExistence(timeout: 5))
    snapshot("Tools collapsed again")
    app.buttons["刷新会话"].tap()
    XCTAssertTrue(tools.waitForExistence(timeout: 10))
    XCTAssertTrue(tools.label.hasPrefix("展开工具调用"))
    XCTAssertFalse(details.exists)
    app.buttons["返回"].tap()
  }
  func testZCachedHistoryScrollsContinuouslyAndSurvivesAppRestart() {
    _ = fixture(["delay": 0, "offline": false])
    openSources()
    let long = named("长会话回归测试")
    XCTAssertTrue(long.waitForExistence(timeout: 10)); long.tap()
    let latest = app.staticTexts["第 19 轮已经完成。"].firstMatch
    XCTAssertTrue(latest.waitForExistence(timeout: 10)); XCTAssertTrue(latest.isHittable)
    let oldest = app.staticTexts["第 0 轮已经完成。"].firstMatch
    let list = app.descendants(matching: .any).matching(identifier: "codex-messages").firstMatch
    for _ in 0..<24 {
      if oldest.exists && oldest.isHittable { break }
      list.swipeDown()
    }
    XCTAssertTrue(oldest.exists && oldest.isHittable)
    XCTAssertFalse(app.buttons["更早的消息"].exists)
    snapshot("Continuous older history, no page button")
    let before = fixture()["reads"] as? [[String: Any]] ?? []
    let olderBefore = before.filter { $0["threadId"] as? String == "qa-long" && $0["cursor"] is String }.count
    _ = fixture(["delay": 4000, "offline": false])
    app.buttons["返回"].tap()
    XCTAssertTrue(long.waitForExistence(timeout: 10)); long.tap()
    XCTAssertTrue(latest.waitForExistence(timeout: 1.5))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已显示本机历史")).firstMatch.exists)
    snapshot("Cached conversation before the network reply")
    Thread.sleep(forTimeInterval: 1.5)
    app.terminate()
    _ = fixture(["delay": 0, "offline": true])
    app.launch()
    let tab = app.otherElements["来源"].firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 10)); tab.tap()
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    for _ in 0..<24 {
      if oldest.exists && oldest.isHittable { break }
      list.swipeDown()
    }
    XCTAssertTrue(oldest.exists && oldest.isHittable)
    let after = fixture()["reads"] as? [[String: Any]] ?? []
    let olderAfter = after.filter { $0["threadId"] as? String == "qa-long" && $0["cursor"] is String }.count
    XCTAssertEqual(olderAfter, olderBefore, "Already read history must come from the phone")
    XCTAssertFalse(app.buttons["继续对话"].isEnabled)
    snapshot("Disk cache after app restart with history offline")
    _ = fixture(["delay": 0, "offline": false])
  }
}
