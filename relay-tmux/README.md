# tmux relay

Panecast now includes an installable `panecast` command. Get the latest
package and installation commands at **https://ningzx.cn/panecast/**.

```sh
brew tap panecast/tap https://ningzx.cn/panecast/homebrew-tap.git
brew install panecast/tap/panecast
panecast setup
panecast start
panecast pair
```

Homebrew installs Node.js and tmux. The standalone installer includes its own
Node.js runtime; npm can install the bundled `.tgz` directly. `panecast setup`
preserves any existing configuration. It signs in to your Panecast account and
the broker assigns this computer its relay ID, relay token and pairing code, so
there is nothing to copy by hand. Phones signed in to the same account list the
computer automatically; `panecast pair` shows a QR code for phones without an
account. For a broker that disables enrollment, pass the credentials its
administrator assigned with `--relay-id ID --token-file PATH`. tmux, cmux and
Codex on this computer are connected automatically with full access; there is
no separate authorization step.
Use `panecast status`, `panecast logs`, `panecast restart`, and `panecast stop`
to manage the macOS background service. Stop the service before uninstalling.
Configuration and paired devices stay under `~/.cmuxremote/` across upgrades.

To connect cmux, tmux, and Codex through one pairing, see the [unified hub guide](HUB.md).

Connect Panecast to tmux on Linux or macOS. Requires Node.js 22+ and tmux 3.2+.
The mobile app and broker use the same protocol as the cmux relay. Each tmux
session is a workspace; its panes, across all windows, are terminals.

```sh
# Ubuntu / Debian
sudo apt-get install tmux
# macOS
brew install tmux

cd relay-tmux
npm ci
mkdir -p ~/.cmuxremote
cp relay.example.json ~/.cmuxremote/tmux-relay.json
chmod 600 ~/.cmuxremote/tmux-relay.json
```

Configure `broker.url`, `broker.relay_id`, and `broker.relay_token` to match
your broker. One broker can serve multiple computers using `CMUX_RELAYS_FILE`;
each relay has an independent ID, relay token and pairing code. See
[broker multi-relay configuration](../broker/README.md). Start a tmux session and the relay:

```sh
tmux new-session -d -s work
npm start
```

In another terminal run `npm run pair`, enter the broker's pairing code and
scan the QR code in Panecast. `--url-only` prints a link for manual pairing;
the QR code and link contain the pairing secret.

The relay never executes a client-provided shell command directly. Input goes
to the selected tmux pane. Ctrl + ↑ is sent as tmux's `C-Up`. New terminals open
as tmux windows. Text, ANSI colors, history snapshots, workspace management,
image uploads, project files, Git diff, and snippets are supported. Closing a
workspace kills the corresponding tmux session and its processes.

Optional LAN access (HTTP/WS on a trusted private network) adds these fields:

```json
{
  "host": "0.0.0.0",
  "port": 4399,
  "lan": { "pairing_code": "AN_INDEPENDENT_RANDOM_SECRET" }
}
```

Generate a QR with `npm run pair -- --lan-host 192.168.1.42`. The app can then
switch between LAN and broker. Without `lan`, no TCP listener is opened.
By default, state is stored under `~/.cmuxremote/tmux/`. `state_directory`,
`notify_socket`, and `tmux_socket` (the `tmux -L` name) can override it.

## Notifications and agent hooks

tmux does not emit cmux's agent events. A shell command or agent hook can send
an explicit event through a local Unix socket restricted to the current user:

```sh
node /path/to/panecast/relay-tmux/src/cli.mjs notify --needs-input --title '等待确认'
node /path/to/panecast/relay-tmux/src/cli.mjs notify --completed --title '任务完成'
node /path/to/panecast/relay-tmux/src/cli.mjs notify --failed --title '构建失败'
```

Run inside tmux so `TMUX_PANE` identifies the terminal, or pass `--surface %0`
and `--workspace '$0'`. No terminal output is scraped to infer task completion.
Configure the coding tool's own hook to invoke this command when appropriate.

For iOS background push, upgrade the broker and add the same APNs settings
as the Swift relay:

```json
{
  "apns": {
    "key_path": "/absolute/path/AuthKey.p8",
    "key_id": "APPLE_KEY_ID",
    "team_id": "APPLE_TEAM_ID",
    "topic": "com.nzx.panecast",
    "env": "prod"
  }
}
```

Use `sandbox` for a development build. TestFlight and App Store use `prod`.
The broker forwards registrations; signing keys and raw APNs tokens stay on
the relay. Push alerts contain generic text and terminal IDs, not command
output. Test push in the app's notification settings. Android continues to
use local notifications while connected, without Google Play services.

## Running continuously on Linux

Create `~/.config/systemd/user/panecast-tmux.service` with your actual paths:

```ini
[Unit]
Description=Panecast tmux relay
After=network-online.target

[Service]
WorkingDirectory=/home/USER/panecast/relay-tmux
ExecStart=/usr/bin/node src/cli.mjs serve --config /home/USER/.cmuxremote/tmux-relay.json
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload` and
`systemctl --user enable --now panecast-tmux`. If the service reports an existing
`notify.sock`, confirm no other relay is running before removing that stale
socket. On macOS, run under your preferred process supervisor; the existing
cmux launchd installation is independent.

## Verification

`npm test` exercises the real tmux backend in a dedicated temporary tmux
server (`-L panecast-test-*`) and never operates on your regular sessions.
