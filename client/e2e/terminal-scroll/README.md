# cmux terminal scrolling

Follow the simulator signing and XcodeGen workflow in `../codex-ui/README.md`,
using this directory's `project.yml`, scheme `PanecastScrollUITests`, and
`node client/e2e/terminal-scroll/fixture.mjs`. Ports 4495 and 4496 are loopback only.
On macOS, use a canonical project path such as `/private/tmp/panecast-terminal-ui`
in both XcodeGen and xcodebuild so generated source paths stay valid.

This exercises the actual terminal screen and native gestures for ordinary
scrollback and an alternate-screen application with sticky header/footer rows.
Normal requests take 500 ms; before a fling the fixture delays network frames
by 1.8 seconds. The test checks that visible text scrolls past the initial screen
using locally prepared rows. It also verifies that remote application captures
preserve the vertical position of a visible row while building the history.
The regression concerns text movement and continuity, rather than wheel counts.
It never controls an existing user terminal or starts a model request.

The application fixture multiplies wheel input by nine and changes header,
footer, and progress rows between captures. This reproduces the old alignment
failure caused by scrolling a complete screen without overlap. The client must
keep visible rows fixed and use reliable overlap even when status text redraws.
The fixture also emits a cleared-prefix intermediate frame before the complete
draw. The client must wait for the real revealed text before committing it.
