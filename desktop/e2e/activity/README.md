# Desktop activity and history regression

Run `npm run export` in `desktop/`, then run `node e2e/activity/verify.mjs` with
Playwright and its WebKit browser installed. If Playwright is installed outside
this package, set `PANECAST_PLAYWRIGHT_MODULE` to its `index.mjs` path.

The test serves the actual exported app to an isolated WebKit browser and
replaces only the desktop transport with `bridge.js`. All credentials,
conversations and terminal output are fixtures; it never contacts a user's
gateway or sends real terminal input. Screenshots go to `build/activity-qa/`.

It checks inline running indicators across multiple windows, sidebar and recent-visit ordering, background
updates preserving the selected terminal, natural wheel direction, loading
history from a short shell screen and an alternate-screen program, stable
reading during live output, return to live output and one native-notification
request per completion, cached switching with a two-second serialized relay delay,
and persisted conversation/window restoration in a new page instance. Measured
times are saved in `build/activity-qa/cache-performance.json`.
The OS notification itself is mocked in this browser
test; Rust compilation and transport/CSP tests cover the native bundle.

`node desktop/e2e/cache-native/verify.mjs` from the repository root also builds
and launches an isolated Mac QA app. It tests the actual cache storage module
under `tauri://localhost`, including page reload and app relaunch, then clears
the QA cache. It uses its own bundle ID and only a loopback result receiver;
the test never calls credential or terminal commands. The Cargo bin directory
must be on `PATH`.
