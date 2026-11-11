# Panecast 下载与安装发布

维护入口：**https://ningzx.cn/panecast/**。页面、安装器、npm 包和 Homebrew tap 均在此目录
的构建流程中生成。Android APK 的旧 `/static/panecast/` 链接继续有效。

## 源文件

- `site/`：无需框架的响应式下载页面，读取 `releases.json` 显示版本和更新记录。
- `release.json`：已验证的 Android 版本、文件大小、SHA-256、运行时版本和历史版本清单。
- `install.sh.in`：独立安装器模板，支持 ARM64 / Intel，安装私有 Node 运行时并校验 SHA-256。
- `../desktop/install/install.sh.in`：桌面客户端安装器；固定 ZIP 的 SHA-256，校验应用完整性并保留升级备份。与电脑网关的 `install.sh` 分开发布。
- `desktop-artifacts.mjs`：完整发布和桌面单独发布共用的 DMG、ZIP、安装脚本校验与暂存。
- `build.mjs`：打包 `relay-tmux/` 的 CLI，包含运行依赖；生成 Homebrew Formula 和静态 Git tap。
- `publish.py`：上传并校验产物，拒绝修改已发布的版本化文件，原子替换元数据和页面。

Homebrew tap 通过 HTTPS 的 Git 静态协议提供，地址为 `/panecast/homebrew-tap.git`。
不依赖 GitHub 账号或 npm 发布令牌；npm 直接安装版本化 `.tgz`。独立安装器固定校验
包与 Node 运行时的 SHA-256，不接收服务器上的可变校验值来替代本地模板中的值。

## 发新版本

桌面版本可单独发布，保留已有 CLI 和手机产物：在 `desktop/` 运行 `npm run build`，
把经过校验的 `build/desktop/desktop-arm64.json` 元数据及日期、更新说明写入
`release.json` 的 `desktop` 字段，然后执行：

```sh
node distribution/desktop.mjs
python3 distribution/publish.py --desktop-only --host USER@SERVER --directory /absolute/webroot/panecast
```

此流程从已发布清单继承其他平台版本，校验 DMG、ZIP、版本化脚本的大小和 SHA-256 后发布；若其他平台版本
在准备与上传之间发生变化，会停止发布以避免覆盖。当前 Mac 包为未公证预览版，
下载页面与 DMG 内明确说明。`desktop.file` 是 DMG 主下载，`desktop.archive` 保留 ZIP，
`desktop.installer` 指向版本化脚本。`install-desktop.sh` 是同内容的可变入口，不加入不可变
产物的 SHA256SUMS；上传顺序保证版本化文件先于页面、脚本入口和元数据上线。
发布后重新下载三种产物核对哈希；若修改账号或连接功能，再核对 broker 的账号与撤销流程。
安装说明在 `/panecast/mac-install.html`，同一文件作为离线说明放入 DMG。

1. 修改 CLI 时递增 `relay-tmux/package.json` 版本，运行 `npm install --package-lock-only --ignore-scripts`。
2. Android 按 `client/ANDROID.md` 构建。将其元数据更新到 `release.json`，旧版加入 `history`
   （每条包含 `platform`、`version`、`file`、`date`、`notes`）。不要改写同一版本的二进制。
3. Node 运行时从 nodejs.org 下载到 `build/distribution/cache/`。在发布配置中固定版本和
   从官方 `SHASUMS256.txt` 核对过的哈希；第三方许可证随运行时及包一起分发。
4. 运行 `node distribution/build.mjs`，产物在 `build/distribution/public/`。构建会先在 `relay/` 编译
   通用（arm64 + x86_64）release 版 `cmux-relay`，裁剪符号并 ad-hoc 签名后放入 CLI 包的
   `vendor/darwin/`，网关在没有可用 relay 的电脑上用它接入 cmux。需要 Xcode 命令行工具。
5. 验证安装器、npm 安装、Homebrew Formula，以及配置/启停/配对。发布命令如下：

```sh
python3 distribution/publish.py --host USER@SERVER --directory /absolute/webroot/panecast
```

发布后检查首页、`releases.json`、`install.sh`、APK、npm 包和 Git tap，下载二进制复核哈希。
网页与 `releases.json` 应使用 `Cache-Control: no-cache`，避免版本信息滞后。

第一次部署还需在现有 HTTPS nginx server 内把 `/panecast/` 映射到上述 webroot，
并为无尾斜杠的 `/panecast` 返回 308。先备份配置，用 `nginx -t` 验证再 reload。
公开目录只允许构建产物，不放入签名、用户配置、令牌或配对二维码。

## 本地验证与配置保护

独立安装器可用 `PANECAST_INSTALL_DIR`、`PANECAST_BIN_DIR` 和 `PANECAST_NO_PATH_UPDATE=1`
安装到临时目录；`PANECAST_DOWNLOAD_BASE` 可指向本地静态服务器。后台服务验证使用
`--config`、`PANECAST_SERVICE_LABEL` 和 `PANECAST_LAUNCH_AGENTS_DIR` 隔离，避免操作日常 hub。
发布用 Homebrew tap 的 Git 工作目录保存在 `build/distribution/tap`，更新会保留提交历史。
在另一台机器继续发布前，应先从线上 tap 克隆到该目录，不要重新生成不相关的历史。

桌面安装器用 `PANECAST_DESKTOP_INSTALL_DIR` 指向临时应用目录，
`PANECAST_DESKTOP_DOWNLOAD_BASE` 指向 HTTPS 或 localhost / 127.0.0.1 本地 HTTP 服务器。
验证首次安装、升级备份和损坏下载时必须使用隔离目录；脚本不会启动图形界面。
DMG 可用 `hdiutil attach -readonly -nobrowse -noautoopen` 挂载检查，结束后 detach。

`panecast setup` 登录账号后由中转自动为每台电脑分配独立凭据，需要中转升级到支持
`POST /v1/account/relays` 的版本；旧中转或关闭自动分配的中转仍可用 `--relay-id` 和
`--token-file` 手动配置。网关自动接入本机的 tmux、cmux 和 Codex，每个来源都拥有全部权限，
没有授权步骤。升级、重装和卸载都保留用户配置与配对。
