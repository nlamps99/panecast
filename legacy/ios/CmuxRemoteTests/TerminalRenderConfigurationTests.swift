import XCTest
@testable import CmuxRemote

final class TerminalRenderConfigurationTests: XCTestCase {
    private func config(
        width: CGFloat = 400,
        fontSize: CGFloat = 15,
        lineHeight: CGFloat = 17,
        theme: String = CmuxColorTheme.storm.rawValue
    ) -> TerminalRenderConfiguration {
        TerminalRenderConfiguration(
            width: width,
            fontSize: fontSize,
            lineHeight: lineHeight,
            theme: theme
        )
    }

    func testFirstConfigurationAlwaysInvalidates() {
        XCTAssertTrue(config().invalidatesCache(comparedTo: nil))
    }

    func testIdenticalConfigurationKeepsCaches() {
        XCTAssertFalse(config().invalidatesCache(comparedTo: config()))
    }

    /// Terminal text is cached as NSAttributedString with palette colors baked
    /// in, so a theme switch has to drop the cache or the terminal keeps
    /// rendering the previous theme.
    func testThemeChangeInvalidatesCaches() {
        let stormed = config(theme: CmuxColorTheme.storm.rawValue)
        let oceanic = config(theme: CmuxColorTheme.ocean.rawValue)
        XCTAssertTrue(oceanic.invalidatesCache(comparedTo: stormed))
    }

    func testFontSizeAndLineHeightChangesInvalidateCaches() {
        XCTAssertTrue(config(fontSize: 20).invalidatesCache(comparedTo: config()))
        XCTAssertTrue(config(lineHeight: 24).invalidatesCache(comparedTo: config()))
    }

    func testWidthChangeInvalidatesCachesOnlyBeyondSubPixelNoise() {
        XCTAssertFalse(config(width: 400.2).invalidatesCache(comparedTo: config(width: 400)))
        XCTAssertTrue(config(width: 420).invalidatesCache(comparedTo: config(width: 400)))
    }
}
