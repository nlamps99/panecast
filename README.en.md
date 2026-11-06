English · [简体中文](README.md)

# Panecast

View and drive the terminals on your computer from your phone.

> **Early stage.** Panecast grew out of
> [cmux Remote](https://github.com/NewTurn2017/cmux-remote). It supports
> [cmux](https://github.com/manaflow-ai/cmux) and tmux. The Expo client shares
> one codebase between iOS, Android and a web demo.

## How it works

Panecast has three parts:

- **relay** runs on the computer that hosts the terminals. It reads the
  terminal screen and forwards keystrokes. Today it is a Swift daemon for
  macOS that talks to cmux over its JSON-RPC socket.
- **broker** (optional) runs on a VPS you control. The phone and the computer
  both connect out to it, so the computer needs no inbound port. The broker
  can read the terminal frames it forwards: connections use TLS, but they are
  not end-to-end encrypted.
- **client** is the phone app, written with Expo (React Native).

On the same LAN or Tailscale network the phone connects to the relay
directly. Elsewhere, traffic goes through the broker.

## Repository layout

| Directory | Contents |
|---|---|
| `client/` | Expo phone app |
| `relay/` | Mac relay (Swift) |
| `relay-tmux/` | tmux relay (Node, macOS / Linux) |
| `broker/` | VPS broker (Node) |
| `docs/specs/` | Protocol design and sample cmux payloads |
| `legacy/` | The original cmux Remote native iOS and Android clients and old docs, to be deleted once the new app reaches parity |

## Quick start

**[Download and install Panecast](https://ningzx.cn/panecast/)** for Android APKs,
the Mac installer, Homebrew, npm packages, and release notes.

```sh
brew tap panecast/tap https://ningzx.cn/panecast/homebrew-tap.git
brew install panecast/tap/panecast
panecast setup
panecast start
panecast pair
```

See the [Mac setup guide](docs/MAC-SETUP.md) to connect another person's Mac,
and the [Android guide](client/ANDROID.md) for signed APK builds and downloads.

The relay needs macOS and Swift 5.10+, and must be installed from a terminal
running inside cmux:

```bash
cd relay
./scripts/install-launchd.sh
```

To deploy the broker, see [`broker/README.md`](broker/README.md).
For tmux on macOS or Linux, see [`relay-tmux/README.md`](relay-tmux/README.md).

To manage cmux, tmux, and Codex through one pairing, use the
[unified hub](relay-tmux/HUB.md). Sources have host-controlled read or control
permissions. Codex supports stored history and App Server conversations;
controlling an existing desktop task requires access to that task's server.

The client includes per-terminal drafts, send receipts, saved and recent input,
Ctrl + Up, output search and copying, pending/resolved inbox items and reminders,
project previews and downloads, Git diff, and connection diagnostics.

Client:

```bash
cd client
npm install
npm run ios
```

Full relay configuration (`relay.json`, Tailscale direct mode, LAN pairing,
troubleshooting) still lives in
[`legacy/README.cmux-remote.en.md`](legacy/README.cmux-remote.en.md) for now.

## Roadmap

- [x] Split the repository and scaffold the Expo client
- [x] Prototype: terminal screen, input (including CJK input methods), broker
      QR pairing
- [x] Workspaces and surfaces, multiple
      computers, automatic LAN/broker switching, inbox and push, image
      attachments, demo mode
- [x] tmux backend on macOS and Linux
- [x] Publish Android APKs: [download the latest build](https://ningzx.cn/static/panecast/panecast-latest.apk)
- [ ] Ship to the App Store and deliver small changes as OTA updates

## Origin and license

Panecast derives from
[NewTurn2017/cmux-remote](https://github.com/NewTurn2017/cmux-remote) and keeps
its full commit history. It is MIT licensed; see [`LICENSE`](LICENSE).

This is a community project. It is not affiliated with Manaflow or cmux.
