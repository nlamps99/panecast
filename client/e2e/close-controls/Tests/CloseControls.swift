import XCTest

final class CloseControls: XCTestCase {
  private var app: XCUIApplication!

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func button(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }
  private func answer(_ title: String, _ choice: String) {
    let alert = app.alerts[title]
    XCTAssertTrue(alert.waitForExistence(timeout: 5), "missing alert \(title)")
    alert.buttons[choice].tap()
  }
  /** Workspace cards wrap their × in the card's own button, so tap it by position when it is not separately exposed. */
  private func tapWorkspaceClose(_ title: String) {
    let close = button("关闭工作区 \(title)")
    if close.exists && close.isHittable { close.tap(); return }
    let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(title)，")).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 5), "missing card \(title)")
    // Right to left the header ends with the chevron, the demo's unread badge, then the ×.
    card.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: card.frame.width - 84, dy: 0)).tap()
  }
  private func card(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(title)，")).firstMatch
  }

  func testPhoneClosesTerminalsAndWorkspaces() throws {
    continueAfterFailure = false
    app = XCUIApplication(bundleIdentifier: "com.nzx.panecast")
    app.launch()
    if app.buttons["以后再说"].waitForExistence(timeout: 2) { app.buttons["以后再说"].tap() }
    let demo = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "先看看演示")).firstMatch
    XCTAssertTrue(demo.waitForExistence(timeout: 10)); demo.tap()
    XCTAssertTrue(card("notes").waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["点 × 关闭工作区；长按可以重命名"].waitForExistence(timeout: 5))
    shot("Workspace list with close buttons")

    // Cancelling keeps the workspace.
    tapWorkspaceClose("notes")
    answer("关闭「notes」？", "取消")
    XCTAssertTrue(card("notes").exists)

    // Close one terminal from its tab, then the last one, which takes the workspace with it.
    card("panecast").tap()
    let first = button("关闭终端 zsh — panecast")
    XCTAssertTrue(first.waitForExistence(timeout: 15))
    // The demo shows a notification banner over the header for a moment.
    let hittable = NSPredicate(format: "hittable == true")
    expectation(for: hittable, evaluatedWith: first); waitForExpectations(timeout: 15)
    shot("Terminal tabs with close buttons")
    first.tap()
    answer("关闭终端？", "关闭")
    let gone = NSPredicate(format: "exists == false")
    expectation(for: gone, evaluatedWith: first); waitForExpectations(timeout: 10)
    let last = button("关闭终端 自动测试")
    XCTAssertTrue(last.waitForExistence(timeout: 5))
    shot("One terminal left")
    last.tap()
    answer("关闭最后一个终端？", "关闭")
    XCTAssertTrue(card("notes").waitForExistence(timeout: 10), "returns to the workspace list")
    expectation(for: gone, evaluatedWith: card("panecast")); waitForExpectations(timeout: 10)
    shot("Back on the list without the closed workspace")

    // Close a workspace from its card.
    tapWorkspaceClose("notes")
    answer("关闭「notes」？", "关闭")
    expectation(for: gone, evaluatedWith: card("notes")); waitForExpectations(timeout: 10)
    shot("Workspace closed from the list")
  }
}
