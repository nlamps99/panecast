# Panecast 桌面版

复用手机客户端的终端、工作区、Codex 来源、收件箱、图片附件和项目文件功能。
0.2.0 起使用 **Tauri 2 + Rust + 系统 WKWebView**，安装包不附带 Chromium 或 Node.js。
安装包面向 macOS 13+ 的 Apple Silicon 电脑。目标电脑继续运行已有 relay / hub。

## 使用

1. 从 [下载页](https://ningzx.cn/panecast/) 下载 Mac 桌面版，解压并移入「应用程序」。
2. 打开「账号登录与电脑管理」，确认服务器地址，注册或登录账号。
3. 在已配置网关的目标电脑运行 `panecast pair --url-only`，输入已有配对码，将输出的完整链接粘贴到桌面版，把电脑绑定到账号。旧 Swift 网关使用 `cmux-relay pair --url-only`。
4. 在另一台设备登录相同服务器上的同一账号，选择电脑即可连接。

也可以直接粘贴已有配对链接，不使用账号。已有手机配对不受影响。
账号按服务器隔离；不同服务器上的同名用户名不是同一个账号。桌面版不会安装或授权
本机的终端网关。要让其他设备访问本机，请按 [Mac 接入指南](../docs/MAC-SETUP.md) 配置。

此预览包使用本地签名，尚未经过 Apple 公证。macOS 可能需要在「系统设置 → 隐私与安全性」
中确认打开。当前没有 Windows / Linux 安装包。桌面端支持连接期间的收件箱和应用内提醒，
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
```

产物在 `build/desktop/`，包含 `.app`、带版本号的 ZIP、SHA-256 和元数据。
`npm start` 导出界面并启动开发客户端；`PANECAST_DESKTOP_ARCH=x64 npm run build`
可以构建 Intel 包（先安装 Rust 的 `x86_64-apple-darwin` target），需在相应机器上验证后再发布。

Expo 的桌面构建使用 SPA 输出，普通 Web 演示继续使用静态输出。WKWebView 加载包内
资源，Tauri IPC 只接受应用主窗口的调用，外部链接交给默认浏览器。
Rust 通过 reqwest 和 tokio-tungstenite 处理认证 HTTP/WebSocket，保持 Authorization
请求头、子协议、hello 顺序和连接取消语义。终端数据使用有序 Tauri Channel 回传。
复制操作使用系统剪贴板，确认弹窗使用 NSAlert，破坏性操作默认选择取消。

凭据文件位于 `~/Library/Application Support/Panecast/credentials-v2.enc`，使用随机
nonce 的 AES-256-GCM 加密；密钥只保存在 macOS 钥匙串，读写串行化并原子替换。
从 Electron 0.1.0 升级时，通过原钥匙串解密 `credentials.enc`，自动迁移账号、电脑
配对和客户端 ID。首次访问可能需要允许系统钥匙串提示。迁移失败会明确报错并保留
原文件，不会用空数据或明文替代；成功后仍保留旧加密文件，便于回退。
旧 WebView 的显示偏好和本机历史缓存不迁移，连接后重新同步历史。

发布见 [下载页维护说明](../distribution/README.md)。Mac 预览版不具备自动更新功能，
升级时下载新版本并替换应用，登录信息保留。

测试覆盖本机 HTTP/WS 实际连接、认证头、100ms hello、长消息、ping/pong、请求与握手
取消、会话撤销、凭据迁移和加密文件损坏。`cargo test --manifest-path src-tauri/Cargo.toml
system_keychain_roundtrip -- --ignored` 可单独验证系统钥匙串，测试后删除独立测试条目。
