# Codex conversation simulator checks

These XCTest UI checks operate a real installed iOS app in a dedicated simulator.
The loopback broker/relay fixture simulates Codex messages without an OpenAI
account, production pairing, or model requests. It covers repeated opening and
scrolling of long histories, resuming a saved conversation, selecting a project,
creating a named conversation, and sending/receiving messages.
It also tests mid-turn input: the receipt appears before processing, the reply
records the correlated user message, and a delayed older history response cannot
erase that message or make a completed turn appear active again.

Use a clean simulator with the current `com.nzx.panecast` build installed. Build
with normal simulator signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`);
disabling signing also removes the simulated keychain entitlement, so pairing
cannot store its credentials. Do not change the generated `ios/` project by hand.

From the repository root, run the fixture in one terminal:

```sh
node client/e2e/codex-ui/fixture.mjs
```

Port 4498 must be free. All fixture credentials are test-only and its listener is
bound to loopback. `PANECAST_UI_RAW_HISTORY=1` exercises the phone's compatibility
with older relays which send the full tool history.
Port 4497 is a separate loopback control endpoint used to delay or fail history
reads and count page requests in the cache regression test.

With XcodeGen installed, generate and run the standalone UI test project:

```sh
mkdir -p /tmp/panecast-ui-tests
xcodegen generate --spec client/e2e/codex-ui/project.yml --project /tmp/panecast-ui-tests
xcodebuild test \
  -project /tmp/panecast-ui-tests/PanecastUITests.xcodeproj \
  -scheme PanecastUITests \
  -destination 'platform=iOS Simulator,id=YOUR_TEST_SIMULATOR_ID' \
  -derivedDataPath /tmp/panecast-ui-tests/build \
  -resultBundlePath /tmp/panecast-ui-tests/results.xcresult \
  -parallel-testing-enabled NO
```

Screenshots are retained in the result bundle. Restarting the fixture discards
its temporary device registry; use a clean test app/simulator for the next run.
The app-server integration tests, including real Codex with a local model stub,
are in `relay-tmux/test/desktop-bridge.test.mjs` and `codex-history.test.mjs`.

`testToolsAreCollapsedAndCanBeExpandedWithoutHidingReplies` checks that a long
conversation initially shows replies and a compact tool summary, that tapping
the summary reveals the tool output, and that collapse and refresh keep the
conversation readable. Screenshots of both states are retained in the result.

`testZCachedHistoryScrollsContinuouslyAndSurvivesAppRestart` scrolls to the oldest
message without page buttons, opens a cached conversation before a deliberately
slow network response, then restarts the app with history reads unavailable. It
verifies that already loaded pages stay readable without requesting them again.
