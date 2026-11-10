# cmux DR2 0.65.2.2-r1

Built from upstream stable release `v0.65.2.2`, commit
`12023d89feb5425c766ba05e8d8e4cfc176e3991`. The upstream app version is
`0.65.2` (build 113). The custom source commit is
`aec9a774bbafca28c0037e79c3513d00c7c979ba`; its complete source archive is
published alongside the installers. Artifact sizes and SHA-256 values are
recorded in `release.json`.

The Release build targets Apple Silicon and macOS 14+. It installs as
`cmux DR2` with bundle ID `com.cmuxterm.app.debug.dr2.selfhost` and uses
`https://ipcraft.drinklake.com` for account, device, presence and relay
services. Native email/password login and personal Mac discovery are enabled.
Cloud VM rental, official telemetry and the official updater are disabled
for this self-hosted distribution. A complete server profile can be supplied
in `~/.config/cmux-dr2/server.json`; the packaged README describes its format.

Validation completed on 2026-11-10:

- Tagged optimized Release build succeeded with the upstream build wrapper.
- 19 scoped Swift source syntax checks and localization checks across 10
  catalogs and 9 locales passed.
- Five focused profile, account and live authentication tests passed,
  including login, team resolution, token refresh and isolated sign-out.
- Three app-model and device integration tests passed, including password
  presentation/retry, signed WebSocket enrollment, device directory loading,
  API ticket and relay credential renewal, and temporary device revocation.
- 16 of 17 scoped static checks passed. The remaining feature-flag date check
  also fails on the untouched stable release: upstream expiry dates for
  `ios-feed-performance-release`, `agent-inbox-quick-view-enabled-release`
  and `conversation-sidebar-release` precede the verification date.
- Bundled terminal helper provenance was verified against the upstream
  GitHub Actions attestation for commit
  `786ab29824b470de376a8030d60f1445dde241cc`.
- The ARM64 package passed deep, strict signature verification and the
  bundled CLI version check. The DMG passed image verification and a
  read-only mount inspection of the app, profile, identity, instructions and
  Applications link.
- Installer tests passed for a fresh install, upgrade with backup, and a
  corrupted download. A checksum failure preserved the installed app and
  existing backup. All test installs were isolated and removed afterward.

The package uses ad-hoc signing and is not Apple-notarized. The installer
verifies its pinned archive hash and app integrity before removing this
app's quarantine attribute. Native UI interaction and an interactive
two-Mac terminal session have not been verified. This release's verification
does not modify or launch the user's installed official cmux application.

Publication uses `publish.py`, followed by HTTPS size/hash verification of
all four artifacts, installer alias comparison, existing-download inventory
comparison, and dr2 service health checks. Local build and deployment
receipts are retained under the ignored `build/cmux/verification/` directory.
