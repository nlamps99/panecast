# Running indicators, completion alert and local cache on the phone

Run `node client/e2e/activity-cache/fixture.mjs` (broker on 4497, control on 4496).
One terminal is idle and the other is in the middle of a Codex turn; `GET /finish`
completes that turn and `GET /offline` stops the relay. Nothing reaches a real
computer or model.

Generate this XcodeGen project under a canonical `/private/tmp/` path and run
`PanecastActivityUITests` on a dedicated simulator with the current app installed
and no saved pairing (the test pairs with the fixture itself).

It checks the running indicator on the workspace card, its terminal row and the
terminal tab; the "对话已完成" alert when the turn finishes; and, after restarting
with the computer offline, the last terminal screen and the workspace list shown
from the phone's cache (the screenshot shows the dimmed ×; nested buttons in a
card are not separate accessibility elements on iOS).
