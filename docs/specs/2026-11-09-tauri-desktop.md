# Tauri 2 桌面版 0.2.0

Electron 0.1.0 的压缩包为 120,624,905 字节，大部分来自随包分发的 Chromium / Node.js。
0.2.0 将桌面实现替换为 Tauri 2.12.5 / Rust，界面仍复用 Expo 的 SPA 导出，Mac 使用系统
WKWebView。无需修改 broker 或目标电脑网关的协议。

## 实现与升级

- Rust 使用 reqwest 和 tokio-tungstenite 处理认证请求及长连接，保持 Bearer 请求头、
  `cmuxremote.v1` 子协议、hello 顺序、取消、关闭码和服务器撤销语义。
- Tauri Channel 有序传递终端输出；JS 桥接串行发送输入，并在 Rust 注册请求后交付
  提前发生的取消，避免 IPC 调度竞态。
- WKWebView 只加载本地界面，CSP 限制页面访问；本机接口验证主窗口来源。
- 系统剪贴板替代 WebKit 中受异步调用限制的浏览器复制接口。NSAlert 保留自定义按钮
  和取消默认操作；外部链接经系统浏览器打开。
- 原 `Panecast Safe Storage` 钥匙串与 Chromium v10 加密格式用于迁移 0.1.0 的账号、
  电脑配对及 client ID。新的 AES-256-GCM 加密文件使用独立钥匙串密钥、随机 nonce 和
  原子写入；旧文件保持完整，解密失败不覆盖数据。旧界面的偏好和本机历史缓存不迁移。
- 桌面发布暂存目录每次重建，避免上一版本 ZIP 混入新版本的校验清单和上传。

## 构建与验证

已通过：客户端 54 个套件、622 项测试，以及 TypeScript / Expo lint；4 项 JS 桥接测试；
7 项默认 Rust 测试；Rust Clippy（所有 target，警告视为失败）。另显式运行并通过了
独立系统钥匙串测试及线上账号/终端测试。

线上测试使用临时账号，通过新的 Rust HTTPS/WSS 连接验证注册、绑定、另一会话登录
发现电脑、读取真实 `workspace.list`、退出后收到 4003 撤销连接、另一会话继续有效。
测试结束已删除临时账号。系统钥匙串测试使用独立条目，检查结束已删除。

图形界面交互未完成自动验证。预览版支持 macOS 13+ / Apple Silicon，使用本地签名，
尚未经过 Apple 公证。手机和网关不需要本次更新。

Apple linker 27037.1 与当前 Rust 工具链在 deployment target 13 下，使用任一 stripping
模式会产生未对齐的 Mach-O LINKEDIT string pool，导致 dyld 拒绝加载 proc-macro 动态库。
独立编译探针确认：目标 11 下三种模式均可加载，目标 13 下只有不剥离模式可加载。
release 保留符号表（本身不生成调试信息），解决构建产物格式错误；不绕过签名或加载校验。

## 产物

- 版本：0.2.0；bundle ID：`com.nzx.panecast.desktop`。
- ZIP：`panecast-desktop-0.2.0-mac-arm64.zip`，3,371,349 字节，比旧版缩小 97.21%。
- ZIP 内展开文件合计：7,827,643 字节。不存在 Electron Framework 或 app.asar，动态依赖
  仅为 macOS 系统库，包含 WebKit / AppKit / Security。
- SHA-256：`5d0f9d0f0fb7761794148c95fafc86ee556faf7b56288bdb793b92fa06b91792`。
- ZIP 完整性、arm64 架构、最低系统版本和 codesign 深度严格校验通过。
