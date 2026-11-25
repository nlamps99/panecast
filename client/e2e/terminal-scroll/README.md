# cmux terminal scrolling

Follow the simulator signing and XcodeGen workflow in `../codex-ui/README.md`,
using this directory's `project.yml`, scheme `PanecastScrollUITests`, and
`node client/e2e/terminal-scroll/fixture.mjs`. Ports 4495 and 4496 are loopback only.
On macOS, use a canonical project path such as `/private/tmp/panecast-terminal-ui`
in both XcodeGen and xcodebuild so generated source paths stay valid.

This exercises the actual terminal screen and native gestures for ordinary
scrollback and an alternate-screen mouse program with sticky header/footer rows.
Normal requests take 500 ms; before a fling the fixture delays network frames
by 1.8 seconds. The test checks that visible text scrolls past the initial screen
using locally prepared rows, without skipping or repeating a row.
It never controls an existing user terminal or starts a model request.

The program terminal has no session record: the fixture answers
`terminal.conversation` with `available: false`, as the gateway does for vim or
htop. Since 4c052e9 full-screen history comes from the session record and
screens are no longer stitched, so a program without one scrolls itself. On a
phone the test taps the floating ↑↓ at the right edge (one `terminal.scroll` of
3 lines each way), then drags down past the top of the screen and checks that
each request carries one wheel unit and that older program rows appear. The
fixture multiplies wheel input by nine and emits a cleared-prefix frame before
the complete draw.
