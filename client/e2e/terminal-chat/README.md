# cmux conversation mode

Run `node client/e2e/terminal-chat/fixture.mjs`. The loopback fixture reads temporary
Codex JSONL logs and receives terminal input without model calls or production
terminals. Port 4492 exposes received text/keys and history requests for assertions.

Generate this XcodeGen test project under a canonical `/private/tmp/` path and run
`PanecastChatUITests` on a dedicated simulator with the current app installed.
The UI test covers tool expansion, direct input, switching between two terminals,
continuous history, persistence of the mode choice, and the original terminal view.

Android can use `adb reverse tcp:4493 tcp:4493` and pair to the same loopback URL.
Always remove the previous UIAutomator XML and verify a fresh dump succeeded.
