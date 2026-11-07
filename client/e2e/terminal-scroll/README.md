# cmux terminal scrolling

Follow the simulator signing and XcodeGen workflow in `../codex-ui/README.md`,
using this directory's `project.yml`, scheme `PanecastScrollUITests`, and
`node client/e2e/terminal-scroll/fixture.mjs`. Ports 4495 and 4496 are loopback only.

This exercises the actual terminal screen and native gestures. The alternate
screen fixture delays wheel acknowledgements by 180 ms and pushes new screen
frames while the same fling is in progress. The test positions at the old edge,
resets the counters, then performs exactly one fast drag and release. It checks
that scrolling continues beyond the finger's travel using small wheel steps.
It never controls an existing user terminal or starts a model request.
