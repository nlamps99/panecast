# Panecast 桌面版

复用手机客户端的终端、工作区、Codex 来源、收件箱、图片附件和项目文件功能。
0.2.0 起使用 **Tauri 2 + Rust + 系统 WebView**（Mac 上是 WKWebView，Windows 上是 WebView2），
安装包不附带 Chromium 或 Node.js。Mac 安装包面向 macOS 13+ 的 Apple Silicon 电脑；0.2.5 起提供
Windows 10 / 11 x64 安装程序。目标电脑继续运行已有 relay / hub。

## 使用

1. 从 [下载页](https://ningzx.cn/panecast/) 下载 DMG，打开后把 Panecast 拖入旁边的 Applications（应用程序）。安装包内附中文安装说明。
2. 打开「账号登录与电脑管理」，确认服务器地址，注册或登录账号。
3. 在已配置网关的目标电脑运行 `panecast pair --url-only`，输入已有配对码，将输出的完整链接粘贴到桌面版，把电脑绑定到账号。旧 Swift 网关使用 `cmux-relay pair --url-only`。
4. 在另一台设备登录相同服务器上的同一账号，选择电脑即可连接。

也可以直接粘贴已有配对链接，不使用账号。已有手机配对不受影响。
账号按服务器隔离；不同服务器上的同名用户名不是同一个账号。桌面版不会安装或授权
本机的终端网关。要让其他设备访问本机，请按 [Mac 接入指南](../docs/MAC-SETUP.md) 配置。

桌面终端默认直接输入：点击终端文字或底部输入区后，打字、方向键、Tab、Esc、
Ctrl 组合键和回车会发往当前终端。中文在输入法选字完成后发送，⌘C／⌘V 使用本机
复制粘贴。需要先编辑整条命令时点击「编辑命令」；对话模式始终先编辑再发送，
Enter 发送、Shift+Enter 换行。桌面不显示手机的虚拟按键栏。

文件可拖入终端或对话区域，截图可在输入区直接粘贴。上传后插入远端文件路径，
直接输入模式按 Enter 提交，对话或编辑命令模式点击发送。

此预览包使用本地签名，尚未经过 Apple 公证。如果 macOS 提示「已损坏」「移到废纸篓」或
「无法验证开发者」，请按 [安装与打开说明](https://ningzx.cn/panecast/mac-install.html) 操作。
DMG 只是安装载体，正式消除这类提示仍需 Developer ID Application 签名与 Apple 公证。
也可以在「终端」执行以下命令，校验官方压缩包的固定 SHA-256 与签名完整性后自动安装：

```sh
curl -fsSL https://ningzx.cn/panecast/install-desktop.sh | bash
```

脚本只清除本次验证通过的 Panecast 的下载隔离标记，不修改系统 Gatekeeper 设置；无需
sudo，不自动启动应用。默认安装到 `/Applications`，没有写权限时使用 `~/Applications`。
升级前需退出旧版；替换后保留旧应用备份，并打印备份路径。账号与配对数据不在应用包内。

### Windows

从下载页下载 `panecast-desktop-<版本>-windows-x64-setup.exe` 并运行。安装程序装到当前用户
（`%LOCALAPPDATA%\Panecast`），不需要管理员权限；缺少 WebView2 时自动安装。预览版没有代码
签名，SmartScreen 提示「Windows 已保护你的电脑」时点「更多信息」→「仍要运行」。卸载在
「设置 → 应用」中进行，可选同时删除登录数据。

Windows 上终端快捷键与 Windows Terminal 一致：Ctrl+V、Ctrl+Shift+V 粘贴；选中文字时 Ctrl+C
复制，未选中时 Ctrl+C 发往终端；Ctrl+Shift+C 复制；Alt+F4 关闭窗口。其余 Ctrl 组合键发往终端。
没有菜单栏，关闭窗口即退出应用。

当前没有 Linux 安装包。桌面端支持连接期间的收件箱和应用内提醒，
不接入 APNs，关闭应用后不会接收手机推送。

## 开发与验证

需要 Rust 1.90+、Xcode Command Line Tools 和 Node.js（仅用于构建共享界面）。

```sh
cd client
npm ci
npm run typecheck
npm run lint
cd ../desktop
npm ci
npm run export
npm test
npm run check
npm run build
npm run verify:installer
```

产物在 `build/desktop/`，包含 `.app`、带版本号的 DMG、ZIP、固定哈希的安装脚本、
各文件 SHA-256 和元数据。DMG 内含 Applications 链接及离线 HTML / TXT 中文安装说明。
`npm start` 导出界面并启动开发客户端；`PANECAST_DESKTOP_ARCH=x64 npm run build`
可以构建 Intel 包（先安装 Rust 的 `x86_64-apple-darwin` target），需在相应机器上验证后再发布。

Windows 安装程序在 Windows 上用 `npm run build:windows` 构建（NSIS，按当前用户安装），产物与
`desktop-windows-x64.json` 元数据同样放在 `build/desktop/`。GitHub Actions 的
`desktop windows` 工作流在 Windows 机器上完成导出、桥接与原生测试、凭据管理器往返测试、
clippy 和打包，然后用 `scripts/smoke-windows.mjs` 静默安装并启动真实应用：通过 WebView2
调试端口确认页面在 `http://tauri.localhost` 加载，经原生桥完成带认证头的 HTTP 请求和凭据
读写，确认不在允许范围内的地址被拒绝，截图后卸载。发布用的安装程序取自该工作流的产物。
在 Mac 上可以用 `cargo clippy --target x86_64-pc-windows-msvc` 做类型检查（构建脚本需要
`llvm-rc`）。

Expo 的桌面构建使用 SPA 输出，普通 Web 演示继续使用静态输出。WKWebView 加载包内
资源，Tauri IPC 只接受应用主窗口的调用，外部链接交给默认浏览器。
React Native Web 在运行时生成样式表，React 同时使用内联样式。CSP 的 `style-src` 保留
`'self' 'unsafe-inline'`，仅关闭 Tauri 对这一条的 nonce / hash 注入：同一条中出现 nonce
会让 WebKit 忽略 `unsafe-inline`，导致页面退回无样式的默认控件。脚本的自动 nonce / hash
注入和其它 CSP 规则保持启用。`npm test` 使用正式打包的 custom-protocol 资源路径，
检查实际生成的 HTML 与 CSP；测试用 MockRuntime，不打开窗口、不访问账号或钥匙串。
Rust 通过 reqwest 和 tokio-tungstenite 处理认证 HTTP/WebSocket，保持 Authorization
请求头、子协议、hello 顺序和连接取消语义。终端数据使用有序 Tauri Channel 回传。
复制操作使用系统剪贴板，确认弹窗在 Mac 上使用 NSAlert，在 Windows 上使用带自定义按钮的
任务对话框（运行时解析，缺失时退回消息框）；破坏性操作默认选择取消。WKWebView 的应用来源是
`tauri://localhost`，WebView2 是 `http://tauri.localhost`，原生命令只接受对应来源的主窗口。

凭据文件位于 `~/Library/Application Support/Panecast/credentials-v2.enc`，使用随机
nonce 的 AES-256-GCM 加密；密钥只保存在 macOS 钥匙串，读写串行化并原子替换。
从 Electron 0.1.0 升级时，通过原钥匙串解密 `credentials.enc`，自动迁移账号、电脑
配对和客户端 ID。首次访问可能需要允许系统钥匙串提示。迁移失败会明确报错并保留
原文件，不会用空数据或明文替代；成功后仍保留旧加密文件，便于回退。
旧 WebView 的显示偏好和本机历史缓存不迁移，连接后重新同步历史。
Windows 上凭据文件位于 `%LOCALAPPDATA%\com.nzx.panecast.desktop\credentials-v2.enc`，格式相同；
密钥保存在当前用户的 Windows 凭据管理器（普通凭据，仅限本机，不随漫游配置同步）。

发布见 [下载页维护说明](../distribution/README.md)。Mac 预览版不具备自动更新功能，
升级时下载新版本并替换应用，登录信息保留。

测试覆盖本机 HTTP/WS 实际连接、认证头、100ms hello、长消息、ping/pong、请求与握手
取消、会话撤销、凭据迁移和加密文件损坏。`cargo test --manifest-path src-tauri/Cargo.toml
system_keychain_roundtrip -- --ignored` 可单独验证系统钥匙串，测试后删除独立测试条目。
