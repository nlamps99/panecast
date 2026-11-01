# Panecast client

The Panecast phone app, written with Expo (React Native). It runs on iOS,
Android and the web from one codebase. It speaks the same HTTP/WebSocket
protocol as the native clients in `legacy/`, so it works with the existing
relay (`relay/`) and broker (`broker/`).

This is an early skeleton. See the roadmap in the root `README.md`.

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
