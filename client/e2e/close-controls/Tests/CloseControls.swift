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
  /** On a phone 置顶 and 关闭 sit behind a left swipe on the card. */
  private func swipeOpen(_ title: String, revealing label: String) -> XCUIElement {
    let action = button(label)
    for _ in 0..<3 where !(action.exists && action.isHittable) {
      let row = card(title)
      XCTAssertTrue(row.waitForExistence(timeout: 5), "missing card \(title)")
      row.swipeLeft()
      _ = action.waitForExistence(timeout: 2)
    }
    XCTAssertTrue(action.exists && action.isHittable, "swipe did not reveal \(label)")
    return action
  }
  private func tapWorkspaceClose(_ title: String) { swipeOpen(title, revealing: "关闭工作区 \(title)").tap() }
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
    XCTAssertTrue(app.staticTexts["向左滑动卡片可以置顶或关闭；长按可以重命名"].waitForExistence(timeout: 5))
    // The title row no longer carries ☆ and ×; the swipe actions wait behind the card.
    XCTAssertFalse(button("置顶 notes").exists && button("置顶 notes").isHittable)
    XCTAssertFalse(button("关闭工作区 notes").exists && button("关闭工作区 notes").isHittable)
    shot("Workspace list")

    // Pin from the swipe: the card moves to the top and says so.
    let pin = swipeOpen("notes", revealing: "置顶 notes")
    shot("Swipe actions")
    pin.tap()
    let pinned = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "notes，", "已置顶")).firstMatch
    XCTAssertTrue(pinned.waitForExistence(timeout: 5))
    XCTAssertLessThan(pinned.frame.minY, card("panecast").frame.minY, "pinned card goes first")
    shot("Pinned card first")
    swipeOpen("notes", revealing: "取消置顶 notes").tap()
    let unpinned = NSPredicate(format: "label CONTAINS %@", "已置顶")
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons.matching(unpinned).firstMatch); waitForExpectations(timeout: 5)

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
