# Panecast client

The Panecast phone app, written with Expo (React Native). It runs on iOS,
Android and the web from one codebase. It speaks the same HTTP/WebSocket
protocol as the native clients in `legacy/`, so it works with the existing
relay (`relay/`) and broker (`broker/`).

The client supports terminal drafts, send receipts, saved and recent input,
Ctrl + Up, output search/copy, inbox handling and reminders, project file
previews/downloads, Git diff, and connection diagnostics. See the
[workflow notes](../docs/specs/2026-11-04-mobile-workflow.md) for relay upgrades
and platform limits. The web build currently provides the interactive demo;
real pairing is supported on iOS and Android.

The [desktop app](../desktop/README.md) packages this same client for macOS with native
credential storage and authenticated networking. Account login is available from pairing
and settings; accounts synchronize authorized computers on the selected broker. New mobile
builds include this screen; the currently published Android build 13 still uses pairing.

The Sources tab supports the [unified hub](../relay-tmux/HUB.md), including
source status/permissions and Codex conversations, streamed replies, approvals,
and interruption. The offline demo also includes a simulated Codex conversation.

```bash
npm install
npm run ios        # or: npm run android / npm run web
npm run typecheck
npm run lint
```

If `npm install` reports `No matching version found` while you use a registry
mirror, the mirror has not synced the newest Expo packages yet. Install once
from the official registry instead:
`npm install --registry https://registry.npmjs.org`.

For local iOS archives and TestFlight uploads, see [TESTFLIGHT.md](TESTFLIGHT.md).
For signed Android APK builds and downloads, see [ANDROID.md](ANDROID.md).

图标、商店文案、截图及其 API 发布流程见 [商店素材说明](../store/README.md)。
