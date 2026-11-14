# Desktop activity and history regression

Run `npm run export` in `desktop/`, then run `node e2e/activity/verify.mjs` with
Playwright and its WebKit browser installed. If Playwright is installed outside
this package, set `PANECAST_PLAYWRIGHT_MODULE` to its `index.mjs` path.

The test serves the actual exported app to an isolated WebKit browser and
replaces only the desktop transport with `bridge.js`. All credentials,
conversations and terminal output are fixtures; it never contacts a user's
gateway or sends real terminal input. Screenshots go to `build/activity-qa/`.

It checks running/completed badges, sidebar and recent-visit ordering, background
updates preserving the selected terminal, natural wheel direction, loading
history from a short shell screen and an alternate-screen program, stable
reading during live output, return to live output and one native-notification
request per completion. The OS notification itself is mocked in this browser
test; Rust compilation and transport/CSP tests cover the native bundle.
