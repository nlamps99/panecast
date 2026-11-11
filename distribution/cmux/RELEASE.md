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

Published and verified on 2026-11-10 at
https://ningzx.cn/panecast/cmux/ from website commit
`ec316e8fef95ef52846afce38b1e3f5165f99084`. All four artifacts were read back
in full over public HTTPS and matched the recorded byte sizes and SHA-256
values. The download pages, metadata, checksum files and installer alias
matched their local sources. All 116 pre-existing download files retained
their sizes and modification times, and existing text metadata retained its
hashes. Both dr2 device and presence health endpoints returned HTTP 200 with
the expected service responses. The previous download-center index remains
available in the deployment staging backup for recovery.

## r3（2026-11-11）

源码提交 `e8f57db41dde8c121e66e612c6924d1ff134929e`（本地 `dr2-selfhost` 分支，r2 未单独发布）。构建号
`113.3`，服务地址 `https://cmux.drinklake.com`。改动：

- 侧栏左下角「手机访问」：读取已安装的 Panecast 网关、配置、launchd 任务与下载站版本，
  一键在新终端标签页运行安装、`setup`、升级（安装器 / Homebrew / npm）或 `start`；运行中可显示配对二维码、
  重启、查看日志。状态逻辑在 `Sources/PanecastGatewayStatus.swift`，由 `selfhost/PanecastGatewayVerification`
  在临时目录测试全部状态与命令。
- `.selfhost` 包默认「自动化模式」套接字，网关无需授权即可连接。
- 自有 Sparkle 更新源 `https://ningzx.cn/panecast/cmux/appcast.xml` 与 dr2 EdDSA 公钥，取代 r1 中残留的
  官方源和密钥（r1 手动检查更新可能被官方 cmux 覆盖）；`.selfhost` 包不再被当作开发版禁用更新器，
  并一次性修复 r1 写入的「自动检查关闭」。r1 用户需手动安装一次。

验证：DR2 socket 设置 18 项、更新器 38 项、网关状态 4 组测试通过；Release 构建、ad-hoc 签名、DMG 校验通过。
本机实测：r3 与 CLI 0.1.7 同时接入官方 cmux 与 DR2（两个来源在线，DR2 无授权）；用本机测试源完成
`113.2 → 113.3` 的真实下载、签名校验、安装与重启；安装器全新安装、升级备份、损坏下载拒绝均通过。

发布：大文件（dmg、zip、源码）在 COS `drink-1304262565` 的 `panecast/cmux/`（对象级公开读），
`appcast.xml`、`release.json`、页面与安装脚本在 ningzx.cn。服务器端核对四个产物 SHA 一致。
首个 r3 安装器 `install-cmux-dr2-0.65.2.2-r3-macos-arm64.sh` 从 ningzx.cn 下载，保留；`install.sh` 改指向
从 COS 下载的 `install-cmux-dr2-0.65.2.2-r3-cos-macos-arm64.sh`，隔离目录实测 20 秒装好 r3。

## r4（2026-11-11）

源码提交 `08d503468259585b2b31729f658cdfcb98673ec3`，构建号 `113.4`。登录框改为用户名：自建配置的
`usernameDomain`（`users.drinklake.com`）把 `nzx` 映射为 `nzx@users.drinklake.com`，与 Panecast broker 共用
同一账号服务；含 `@` 的输入仍按邮箱处理。打包脚本要求该域名一致。配置测试与 9 语言本地化检查通过。

发布：dmg、zip、源码先上传 COS 并核对 SHA，再更新 ningzx.cn 的页面、`install.sh`（从 COS 下载）、
`release.json` 与 `appcast.xml`；服务器端四个产物 SHA 一致。r3 用户会在左下角收到 r4 更新。

注意：构建目录中的原始 App 的构建号是未打包的 `113`，运行后会被线上 appcast 当作旧版而自动更新覆盖；
本地验证应使用打包后的 App。
