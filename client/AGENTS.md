This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility. Project-wide context, the protocol and the current task are in `../CLAUDE.md`.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm install — resolves SDK-compatible versions
npx expo start              # start the dev server
npm run lint                # lint
npm run typecheck           # tsc --noEmit
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

If a registry mirror reports `No matching version found`, it has not synced the newest Expo packages yet. Install once with `--registry https://registry.npmjs.org`; do not change the user's global npm config.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils, the protocol client) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building

- Local builds on this Mac (it has Xcode): `npx expo run:ios --device` / `npx expo run:android`. These are free and do not use EAS build quota.
- EAS cloud builds, store submission and OTA updates: `npx eas-cli@latest build|submit|update`. The free plan has a monthly build quota. Docs: https://docs.expo.dev/eas/index.md

## Rules

- `ios/` and `android/` here are generated (Continuous Native Generation) and gitignored. Never create or edit them by hand — configure native behavior in `app.json` and config plugins. The hand-written native apps live in `../legacy/` and are reference only.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries. Android must keep working without Google Play services.
