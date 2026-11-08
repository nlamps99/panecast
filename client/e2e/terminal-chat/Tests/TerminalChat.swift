import XCTest

final class TerminalChat: XCTestCase {
  func testChatFoldsToolsSendsToSelectedTerminalAndScrollsContinuously() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    app.launch()
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    let pair = app.buttons["没法扫码？粘贴配对链接"]
    if pair.waitForExistence(timeout: 3) {
      pair.tap(); let input = app.secureTextFields.firstMatch
      XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
      input.typeText("cmux://pair?server=http%3A%2F%2F127.0.0.1%3A4493&relay=qa-chat&code=qa-pair-only")
      app.buttons["配对"].tap()
    }
    let workspace = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "终端对话测试，")).firstMatch
    XCTAssertTrue(workspace.waitForExistence(timeout: 20)); workspace.tap()
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    app.buttons["对话模式"].tap()
    XCTAssertTrue(app.staticTexts["CHAT_0_ANSWER_89"].firstMatch.waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "CHAT_TOOL_OUTPUT_")).firstMatch.exists)
    let tools = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "展开工具调用")).firstMatch
    XCTAssertTrue(tools.waitForExistence(timeout: 5)); tools.tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "CHAT_TOOL_OUTPUT_0_89")).firstMatch.waitForExistence(timeout: 5))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "收起工具调用")).firstMatch.tap()
    XCTAssertTrue(app.staticTexts["CHAT_0_ANSWER_89"].firstMatch.exists)
    let collapsed = XCTAttachment(screenshot: app.screenshot()); collapsed.name = "Chat tools collapsed"; collapsed.lifetime = .keepAlways; add(collapsed)
    let composer = app.textViews.firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap(); composer.typeText("phone chat message")
    app.buttons["发送消息到当前终端"].tap()
    XCTAssertTrue(app.staticTexts["CHAT_REPLY_0: phone chat message"].firstMatch.waitForExistence(timeout: 15))
    app.otherElements["terminal-chat-messages"].firstMatch.swipeDown()
    if app.buttons["第二个终端"].waitForExistence(timeout: 5) { app.buttons["第二个终端"].tap() }
    else { app.buttons["终端模式"].tap(); app.buttons["第二个终端"].tap(); app.buttons["对话模式"].tap() }
    XCTAssertTrue(app.staticTexts["CHAT_1_ANSWER_89"].firstMatch.waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["CHAT_REPLY_0: phone chat message"].firstMatch.exists)
    composer.tap(); composer.typeText("second terminal message"); app.buttons["发送消息到当前终端"].tap()
    XCTAssertTrue(app.staticTexts["CHAT_REPLY_1: second terminal message"].firstMatch.waitForExistence(timeout: 15))
    let list = app.otherElements["terminal-chat-messages"].firstMatch
    for _ in 0..<60 { list.swipeDown(); if app.staticTexts["CHAT_1_ANSWER_0"].firstMatch.exists { break } }
    XCTAssertTrue(app.staticTexts["CHAT_1_ANSWER_0"].firstMatch.waitForExistence(timeout: 10))
    let history = XCTAttachment(screenshot: app.screenshot()); history.name = "Chat continuous history"; history.lifetime = .keepAlways; add(history)
    app.terminate(); app.launch()
    let reopen = app.buttons["打开终端 第二个终端"]
    if reopen.waitForExistence(timeout: 5) { reopen.tap() }
    XCTAssertTrue(app.buttons["对话模式"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["对话模式"].isSelected)
    app.buttons["终端模式"].tap()
    XCTAssertTrue(app.staticTexts["SHELL_SCREEN_1"].firstMatch.waitForExistence(timeout: 10))
  }
}
