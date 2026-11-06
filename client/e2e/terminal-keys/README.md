# Terminal key UI regression

Uses the existing XCTest workflow in `../codex-ui/README.md`, with this
directory's `project.yml`, scheme `PanecastKeyUITests`, and `fixture.mjs`.
The fixture listens on loopback port 4499 and uses temporary test credentials.
Run on a dedicated clean simulator with the current signed simulator app.

The test scrolls into history, taps the real **Ctrl + Up** shortcut, and checks
that the remote program's response is visible. A second tap checks that the
button still works in the live view. The fixture rejects any different key or
target and records the count of received shortcuts.
