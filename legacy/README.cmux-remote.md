[🇰🇷 한국어](README.ko.md) · [🇺🇸 English](README.en.md) · 🇨🇳 简体中文

# cmux Remote

> 通过 Tailscale 或自建 VPS，用 iPhone 或 Android 手机操作 Mac 上
> [cmux](https://github.com/manaflow-ai/cmux) 终端的非官方远程客户端。

cmux Remote 是一套手机应用 + Swift 守护进程的组合，让你在 iPhone
（SwiftUI）或 Android 手机（Kotlin + Jetpack Compose）上读取和操作
Mac 上 cmux 里运行的终端。Direct 模式走你的 Tailscale tailnet；
可选的 Server 模式让手机和 Mac 各自通过 TLS 主动连接到你自己控制的
VPS Broker。

> **不想在手机上装 Tailscale：** 参考
> [自建 Broker 指南](broker/README.md)。Server 模式有 TLS 保护，但**不是**
> 端到端加密——Broker 能看到中转的终端帧。

本项目是社区作品，**并非** Manaflow 制作或官方支持。cmux Remote 是一个
独立的网络客户端，只通过已公开文档的 JSON-RPC 协议与 cmux 通信。

---

## 本次更新 — v1.0.6

<p align="center">
  <img src="docs/launch-assets/source/cmux-remote-brandmark-transparent.png" alt="cmux Remote 品牌标识" width="320">
</p>

相比 v1.0.5 的新增与变更：

- 🤖 **Android 客户端（新）** — `android/` 目录新增原生客户端（Kotlin +
  Jetpack Compose，**不依赖 Google Play 服务**）：扫码配对、工作区 /
  surface 管理、ANSI 终端镜像、CMD/LIVE 输入面板、快捷键行与事件 Inbox，
  界面结构与 iOS 版一致（底部四个 Tab：Workspaces / Active / Inbox /
  Settings）。
- 🔔 **原生推送通知（APNs）** — relay 通过 APNs 投递 cmux 事件和 Claude/Codex 风格的 `needs input` 提示。在 relay 上配置 `apns` 块后，即使应用被切到后台或已被杀掉也能收到横幅；不配置则回落到现有的本地通知。
- ⌨️ **Ctrl-C 快捷键** — 终端键盘条上新增独立的 Ctrl-C 键，用于中断正在运行的命令。
- 🖼️ **五张 App Store 截图全部更新** — 工作区、终端、键盘、Inbox 和设置页的最新界面。

<table>
  <tr>
    <td align="center" width="20%"><img src="docs/launch-assets/screenshots/app-store-6.9/01-workspaces-remote-control.png" alt="工作区远程控制" width="180"><br><sub>工作区 / surface 芯片条</sub></td>
    <td align="center" width="20%"><img src="docs/launch-assets/screenshots/app-store-6.9/02-terminal-live-control.png" alt="终端实时控制" width="180"><br><sub>实时终端镜像</sub></td>
    <td align="center" width="20%"><img src="docs/launch-assets/screenshots/app-store-6.9/03-keyboard-shortcuts.png" alt="按键辅助条" width="180"><br><sub>按键辅助条 · Ctrl-C</sub></td>
    <td align="center" width="20%"><img src="docs/launch-assets/screenshots/app-store-6.9/04-inbox-notifications.png" alt="Inbox 通知" width="180"><br><sub>通知 Inbox · 推送</sub></td>
    <td align="center" width="20%"><img src="docs/launch-assets/screenshots/app-store-6.9/05-settings-connection-guide.png" alt="设置 · 配对" width="180"><br><sub>设置 · 配对引导</sub></td>
  </tr>
</table>

> v1.0.5 及更早版本的变更见下方 **变更历史**。

---

## 当前状态

**早期预览（v1.0.6）。** 已经可以：

- 列出、打开、创建、重命名、关闭 cmux 工作区和 surface
- 近实时镜像任意终端 surface（15 Hz 差分轮询，120 行有界历史）
- 发送按键、组合键、原始文本、命令行和逐字符实时输入，并有独立的 Ctrl-C 快捷键
- 把 cmux 通知呈现在 Inbox 里作为 iOS 本地通知，或在 relay 配置了 `apns` 块时作为 APNs 推送
- 把 iPhone 剪贴板文本粘贴进命令编辑框
- 附加 iPhone 照片：保存到 Mac 的 `~/Downloads/cmux-remote/` 下并插入保存路径
- 在工作区标题栏显示已连接 MacBook 的电池状态
- 把 Claude/Codex 风格的 `needs input` 事件呈现在 Inbox 里
- 让终端输入面板贴紧底部边缘，并留出额外滚动空间以便看到被遮住的终端行
- 每次发送前重新固定 cmux pane 焦点

已在 macOS 14 + iOS 17 上完成冒烟测试，涵盖局域网和跨 Tailnet
（Tailscale 1.84+）、模拟器和真机 iPhone。

> **关于通知投递** — 从 1.0.6 起，在 relay 上配置 `apns` 块即可通过 APNs
> 投递横幅，应用被杀掉或长时间处于后台时也能收到。不配置 APNs 时通知行为
> 与以前相同：只在应用处于前台、或仍存活于后台且 WebSocket 未断开时触发
> 本地横幅。（见 **配置** 一节的 `apns` 块。）

---

## 变更历史

> 最近的变更，新的在前。格式：`日期 · 版本/范围 · 摘要`。
> 范围 — `app`（iOS 应用）· `relay`（Mac 守护进程）· `setup`（安装/文档）。
> 各版本的 App Store 发布说明见
> [`docs/launch-assets/release-notes/`](docs/launch-assets/release-notes/)。

- **2026-06-23 · v1.0.6（app + relay）** — 原生 APNs 推送通知（relay 配置 `apns` 块后横幅可送达已被杀掉的应用，否则回落到本地通知）、终端键盘条上的独立 Ctrl-C 快捷键，以及五张 App Store 6.9" 截图全部更新。
- **2026-06-06 · relay** — 跟踪 cmux 迁移后的 socket 路径：cmux 1.0.5 把 Unix socket 从 `~/Library/Application Support/cmux` 移到了 `~/.local/state/cmux`。`cmuxSocketPath()` 现在按最新约定优先的顺序跟随标记文件（`/tmp/cmux-last-socket-path` → `~/.local/state/cmux/last-socket-path` → 旧的 Application Support），最后回落到 `~/.local/state/cmux/cmux.sock`。**iOS 应用无变更 → 无需重新提交 App Store。**
- **2026-06-05 · v1.0.5（app）** — LIVE 逐字符输入模式、韩语/谚文 IME 保护（不再拆散字母）、输入面板贴底、终端额外五行滚动空间、改进 `needs input` 的 Inbox 覆盖。
- **2026-06-05 · setup** — 傻瓜式 relay 安装脚本 + 连接指南（`docs/connection-guide.md`）。
- **2026-05-29 · v1.0.4（app）** — 缓存解析后的行/样式段以加快终端渲染、120 行有界历史、256 色/真彩 ANSI、更好的校验和对齐。
- **2026-05-28 · v1.0.3（relay）** — 修复 cmux 轮换 socket 时反复出现的 "Connection refused"、重装后默认动态发现 socket、socket 路径回归测试。
- **2026-05-24 · v1.0.2（app）** — 移动键盘行为、工作区创建/重命名/关闭、图片附件、已连接电脑的电池状态、Inbox 改进。

---

## 为什么做这个？

cmux 是一款很出色的 Mac 原生终端，很适合配合 AI 编码 agent 使用，但你一
离开电脑它就成了黑屏。cmux Remote 给你一块薄薄的玻璃窗，让你在沙发上、
火车上、咖啡馆里也能看到同样那些工作区。所有活儿还是 Mac 在干——iPhone
只是一个遥控器。

---

## 架构

```
iPhone / Android         Tailscale            Mac
┌─────────────────────┐                       ┌────────────────────────────────┐
│ cmux Remote (app)   │── HTTP + WS ─────────▶│ cmux-relay (Swift, launchd)    │
│  · 工作区列表        │   (Tailscale 加密)     │  · HTTP/1.1 路由                │
│  · 终端镜像          │                       │  · /v1/stream WebSocket        │
│  · 辅助键条          │◀── events.stream ─────│  · DiffEngine (15 Hz 轮询)      │
│  · 本地通知          │                       │  · Tailscale whois 鉴权         │
└─────────────────────┘                       │  · 设备令牌 + 限速               │
                                              └─────────────┬──────────────────┘
                                                            │ Unix socket
                                                            │ JSON-RPC
                                                            ▼
                                              ┌────────────────────────────────┐
                                              │ cmux.app                       │
                                              │ ~/.local/state/cmux/cmux.sock  │
                                              └────────────────────────────────┘
```

Server 模式的链路是 `手机 -- HTTPS/WSS --> VPS Broker <-- WSS -- Mac relay`。
Mac 不需要开放任何入站端口，Direct 模式仍是默认。

需要装两个东西：

1. **`cmux-relay`** — 一个跑在 cmux 同一台 Mac 上的小型 Swift 守护进程。
   它用 JSON-RPC 与 cmux 的本地 Unix socket 通信，并在 tailnet 接口上暴露
   HTTP + WebSocket API。TLS 由 Tailscale 的 WireGuard 传输层本身提供。
2. **cmux Remote（iOS / Android）** — 手机上的客户端应用：iOS 是 SwiftUI
   应用（`ios/`），Android 是 Kotlin + Jetpack Compose 应用
   （`android/`）。两者都只与你自己的 relay 通信，任何数据都不会离开
   你的 tailnet / broker。

本仓库刻意**不包含**任何 cmux 源代码。它是一个通过已公开文档的 JSON-RPC
schema 与 cmux 通信的网络客户端。

---

## 功能

### 工作区 / surface

- 工作区与终端 surface 列表
- **多 cmux 窗口支持** — cmux 的 `workspace.list` 只返回当前 key 窗口的
  内容，所以第二个打开的窗口以前在应用里完全看不到。现在用 `window.list`
  枚举窗口，并用 `window_id` 限定列表范围。只有窗口多于一个时才显示切换器。
- 创建工作区时把输入的标题作为 cmux `workspace.create` 的 `title` 传入
- 在工作区列表里重命名（`workspace.rename`）/ 关闭（`workspace.close`）
- 在芯片条里创建 / 关闭 surface（带确认对话框和自动回退选择）
- 切换工作区 / surface 时自动重新订阅并滚动到底部
- 首个 RPC 门控（`CMUXClient.awaitReady`），确保入站桥接装好后才发出调用

### 终端镜像

- 15 Hz 差分轮询 + 全文回落 + 基于校验和的对齐
- 120 行有界历史，避免切换 surface / 刷新时突然缩到 24 行
- 底部额外五行滚动空间，让被输入辅助条遮住的行能完整拉出来查看
- 缓存渲染行和样式段，按段批量走 Canvas 绘制，让大屏下的滚动和缩放更快
- Tokyo Night Storm 配色、ANSI 256 色 / 真彩渲染基础，以及 CRT 扫描线着色器
- 正确计算东亚宽字形的单元格宽度
- 阻止 iOS 把 ● ⏺ ✔ ▶ 这类字形自动升格成彩色 emoji
  （用 Variation Selector-15 加一张小的替换表）

### 输入

- 辅助键条：`esc` `OK` `/` `$` `tab` `← ↑ ↓ →` `/new` `space`
- **LIVE 输入模式** — 不按提交键，逐字符即时发送到终端
- 独立的收起键盘、退格、iPhone 剪贴板粘贴和照片附加按钮
- 命令编辑框把文本 + 回车作为一次发送；软键盘在提交后自动收起
- 韩语/谚文 IME 文本不进入 LIVE 即时发送模式，避免组合中的音节被拆成字母
- 照片附件由 Mac relay 保存在 `~/Downloads/cmux-remote/` 下，然后把保存
  路径插入命令输入框
- `surface.send_key` 在 Mac 侧通过 `NSEvent` 合成事件投递，所以多字节序列
  （方向键、ctrl 组合键）会原子到达——这对基于 Ink 的 TUI（Claude Code
  等）很重要，它们的 ESC 解析器只要序列剩余部分晚几毫秒就会对单独的 ESC
  字节做出反应。
- **焦点门控** — 每次订阅、重新订阅和每次 `sendKey` 都会先重新固定
  `surface.focus`。即使 Mac 那边焦点移动过，iPhone 的按键也会落在你想要的
  surface 上。

### 通知

- 通过 `UNUserNotificationCenter` 把 cmux 的 `events.stream` 通知呈现为
  iOS 本地通知，并用 `threadIdentifier` 按工作区分组
- 权限按需申请，在应用启动时预热一次
- 重复 id 防护 — 重连后重复推送同一条通知只会触发一次横幅
- Inbox 视图保留最近 200 条（新的在前）
- Claude/Codex 风格的 `needs input`、`needs attention` 和审批事件被提升到
  同一个 Inbox 流里
- 配置了 `apns` 块后，cmux 事件 / `needs input` 会作为 APNs 推送投递
  （能送达已被杀掉的应用）；不配置则 Inbox 回落到本地通知
- 深链 `cmux://surface/<id>`（基于 payload 的深链自动跳转计划在 v1.1）
- 设置里的 `SEND TEST NOTIFICATION` 按钮：本地注入用于立即确认
  Inbox/横幅，另有一行独立状态显示 relay→cmux→events.stream 的往返情况

### Mac relay

- HTTP/1.1 加 WebSocket 升级（`SwiftNIO`）
- JSON-RPC 2.0 分发
- DiffEngine — 基于 actor、按设备的 FPS 预算、行粒度差分
- 通过 Tailscale UDS `whois` 鉴权（前台服务），带 GUI 回落
- 每设备一个哈希后的 bearer 令牌，可从菜单栏单独吊销
- 按设备限速，以及由 `boot_id` 驱动的重置广播
- 以 launchd 用户代理形式分发，并注入 `PATH`，使 `tailscale` CLI 在被精简
  过的 launchd 环境里仍可访问
- 通过 `host.battery` 查询已连接 Mac 的电池状态，在 iPhone 标题栏显示为角标
- iPhone 照片上传通过 `file.upload` 仅保存在 `~/Downloads/cmux-remote/` 下
- 事件流使用独立的 cmux UDS 通道（已订阅的通道变为只推送，不再接受后续
  RPC 响应）
- APNs 推送扇出（`APNsProvider`）— 按设备令牌投递，未配置 `apns` 块时禁用

### 安全

- relay 绑定 `0.0.0.0`，但在应用层拒绝非 Tailscale 来源地址
  （`EndpointPolicy`）
- 每设备令牌，可从菜单栏吊销
- 通知负载从不包含终端内容——只有工作区/surface id 和一个简短标题
- 无遥测、无分析、无第三方网络调用

---

## 环境要求

### Mac（运行 relay）

- macOS 13 Ventura 或更新
- 一个可用的 [cmux](https://github.com/manaflow-ai/cmux) 安装，且已暴露
  Unix socket（默认 `~/.local/state/cmux/cmux.sock`）
- 从源码构建需要 Swift 5.10 工具链（Xcode 15.3+）
- Direct 模式需要已安装并登录的 Tailscale，或者自建 Broker
- Direct 模式需要一个空闲 TCP 端口（`4399`）；纯 Broker 模式不需要

### iPhone

- iOS 17 或更新
- Direct 模式下需与 Mac 在同一 Tailnet；Server 模式下手机不需要 VPN
- 侧载需要 Apple 开发者账号（免费的 7 天个人证书够用；上架 App Store
  需要付费账号）

### Android 手机

- Android 8.0（API 26）或更新
- **不需要 Google Play 服务**——扫码解码用的是 ZXing，国行/无 GMS 机型可用
- 用源码构建 APK（见下方「快速开始」），或 `adb install` 已构建的
  `app-debug.apk`

### 网络

- Direct：两端都需 Tailscale 1.84+；不需要 Funnel 或公网主机名
- Server：一台 VPS 加一个带受信 HTTPS 的域名，见 `broker/README.md`

---

## 快速开始

> **连不上？** 如果这是首次安装，或者应用提示无法访问你的 Mac，请按这份
> 任何人都能照做的分步安装 + 排查指南操作 →
> **[连接指南（docs/connection-guide.md）](docs/connection-guide.md)**

### 0. 开始之前（在 Mac 上）

relay 跑在 cmux 所在的同一台 Mac 上。先确认这三件事：

```bash
cmux --version                 # cmux 必须已安装并正在运行
tailscale status               # Tailscale 必须已登录且在线
swift --version                # 构建需要 Swift 5.10+（Xcode 15.3+）
```

- **cmux 必须正在运行**，relay 才能连上它的 socket（否则会报
  `socketMissing`）。
- 你的 iPhone 和 Mac 必须登录**同一个 Tailnet**。

### 1. 在 Mac 上构建并安装 relay

```bash
git clone https://github.com/NewTurn2017/cmux-remote.git
cd cmux-remote

# 构建并作为 launchd 用户代理安装（登录时自动启动）。
# 脚本会自动执行 swift build -c release。
./scripts/install-launchd.sh
```

安装脚本会构建 release 二进制并复制到 `~/.cmuxremote/bin/`，在
`~/.cmuxremote/relay.json` 不存在时写入默认配置，渲染
`~/Library/LaunchAgents/com.genie.cmuxremote.plist`，然后引导启动服务。
日志落在 `~/.cmuxremote/log/`。

### 2. 确认 relay 已启动

```bash
# 健康检查 —— 在 Mac 上访问自己的 Tailscale IP
curl -s http://$(tailscale ip -4):4399/v1/health
# {"ok":true,"version":"0.1.0"}   ← 出现这个说明 relay 正常

# 确认它也连上了 cmux socket
./scripts/cmux-probe.sh
# {"id":"probe-1","result":{...}}
```

没有响应或者结果不对？先看日志：

```bash
tail -n 40 ~/.cmuxremote/log/stderr.log
```

依次出现 `starting cmux-relay on 0.0.0.0:4399` → `listening …` →
`cmux event stream attached` 就说明正常。否则跳到下方的
**连接排查**。

### 3. 配对手机

先找到 Mac 的地址：

```bash
tailscale ip -4          # 例如 100.x.y.z  ← 在应用里填这个
tailscale status         # 想用 MagicDNS 名称（例如 my-mac）时看这个
```

#### Android：构建、安装、扫码

```bash
cd android
gradle :app:assembleDebug        # 产出 app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

打开应用后点 **Scan QR to pair**，对准 Mac 上 `cmux-relay pair` 打印的
二维码即可（二维码内容见下方「二维码配对」）。也支持粘贴
`cmux://pair` 链接和手动填写直连 / Server 字段。

#### iPhone

在 iPhone 上打开 cmux Remote：

1. 点 **Add Mac**
2. 填入上面查到的 Tailscale IP 或 MagicDNS 名称，端口 `4399`
3. 点 **Add** —— relay 会解析你的 Tailscale 身份并完成配对

relay 会自动允许自己这台 Mac 的 tailnet 登录名，所以 iPhone 只要在同一个
Tailscale 账号下，通常不需要额外设置就能连上。只有账号不同、或 relay 跑在
tag 节点上时，才需要在下方 **配置** 的 `allow_login` 里手动加上你的登录名
（其他登录名会得到 `403 Forbidden`）。配对时会签发一个按设备的令牌，随时
可以用 `~/.cmuxremote/bin/cmux-relay devices revoke <id>` 吊销。

#### 二维码配对（Server 模式）

Server 模式否则就得往手机里输入服务器 URL、relay id，以及一个由
`openssl rand -hex 32` 生成的 64 位配对码。错一个字符就会得到
`pairing_rejected`，而 Broker 按来源 IP 把配对请求限制在每分钟 5 次，所以
输错几次就会被挡上一分钟。改用扫码：

```bash
# 从 stdin 提示输入配对码
~/.cmuxremote/bin/cmux-relay pair

# 或者直接从 VPS 用管道取（不会留在 shell 历史里）
ssh <vps> "docker exec cmux-remote-broker-broker-1 printenv CMUX_PAIRING_CODE" \
  | ~/.cmuxremote/bin/cmux-relay pair

# 只要 URL，不要二维码
cmux-relay pair --url-only
```

服务器 URL 和 relay id 会从 `relay.json` 自动读取。只有配对码通过参数或
stdin 传入，这是刻意的：`relay.json` 里存的是 relay 自己的
`relay_token`，不是手机的配对密钥，Mac 没有理由保管后者。从 stdin 读取还能
让它不出现在 shell 历史和 `ps` 输出里。终端上只打印脱敏后的形式。

在手机上打开 **设置 → 连接**（Android 未配对时直接显示在首屏），把模式
切到 `SERVER`，就会出现 **[ 扫描 MAC 二维码 ]** 按钮。扫码会填好那三个
字段，但 iOS 上**不会**自动重连——仍需你点 **[ 保存并重新连接 ]** 确认，
这样扫错码不会静默顶掉一个能用的配置；Android 上扫码后直接自动连接。
负载是一个 `cmux://pair` URL，所以用系统相机或任意扫码器扫也能跳回应用，
和应用内扫码效果一样。

> **二维码本身就是密钥。** 它把配对码以明文形式带在里面，而且 Broker 的
> `register` 不会消耗这个码，所以二维码可以反复使用。用完请执行 `clear`，
> 并注意不要让它出现在截图、投屏和录屏里。

### 4. 开始使用

#### 保存和切换多台电脑

在 **设置 → 电脑 → +** 添加电脑，可以分别配置直连、Server 或 AUTO，
也可以在添加窗口扫描 Mac 的二维码。每台电脑的地址、Relay ID、连接偏好
和凭证独立保存，顶部电脑菜单用于切换；终端页显示当前电脑名称，返回列表后
即可切换。重启应用会恢复上次选择，旧版单电脑配置和此前多电脑版本的数据会自动迁移。

同一时间只连接一台电脑。切换时关闭旧连接，并清空当前终端、工作区和 Inbox，
不合并不同电脑的通知历史。编辑或移除一台电脑不会清除其他电脑的凭证。
AUTO 仍然优先局域网、不可达时使用 Broker，两个传输各自保留认证凭证。

配对码按电脑保存在本机 Keychain，成功注册对应传输后清除已使用的配对码。
解除配对只清除当前电脑的本机凭证；Mac/Broker 端的注册撤销仍需在服务端执行。

- **Workspaces** —— 工作区列表。点一个会展开它的 surface 芯片条，也可以在
  这里创建、重命名、关闭工作区。
  当有多个 cmux 窗口时，列表上方会出现窗口切换器，每个芯片显示
  `window:N` 和该窗口的工作区数量（● 标记 cmux 当前的 key 窗口）。
- **Terminal** —— 点中的 surface 在这里镜像。底部辅助条上有
  esc / 方向键 / tab / 鼠标模式 / pane 切换。
- **Notifications** —— cmux 通知的 Inbox。应用存活期间到达的通知会按时间
  倒序堆叠，同时也会弹 iOS 横幅（仅前台或短暂后台）。
- **Settings** —— 主机/端口、二维码扫码配对、重新连接、发送测试通知。

---

## 配置

relay 读取 `~/.cmuxremote/relay.json`。文件不存在时，
`install-launchd.sh` 会写入下面这份默认配置（已存在的文件永远不会被覆盖）：

```json
{
  "listen":      "0.0.0.0:4399",
  "default_fps": 15,
  "idle_fps":    5
}
```

`listen` 是 `0.0.0.0`，但非 Tailscale 来源地址无论如何都会在应用层被拒绝。
开发时想放行 localhost，用 `CMUX_DEV_ALLOW_LOCALHOST=1` 运行安装脚本。

省略的键会回落到上面的默认值，所以这三行配置足以让 relay 正常启动。配对
只接受 tailnet 登录名列在 `allow_login` 里的设备（其他人得到
`403 Forbidden`），但 relay 会**自动加入自己这台 Mac 的登录名**，所以
iPhone 只要在同一 Tailscale 账号下，`allow_login` 留空通常也能配对。想关掉
这个行为，用 `CMUX_NO_SELF_LOGIN=1` 运行安装脚本。

只有账号不同、或 relay 跑在 tag 节点上时，才需要手动添加登录名。可以在
Tailscale 管理后台查到，或者通过 `tailscale status --json` 里
`Self.UserID` 指向的 `User[…].LoginName` 找到（例如
`you@example.com`）。加上之后重启 relay：

```json
{
  "listen":      "0.0.0.0:4399",
  "allow_login": ["you@example.com"],
  "default_fps": 15,
  "idle_fps":    5
}
```

```bash
launchctl kickstart -k "gui/$(id -u)/com.genie.cmuxremote"
```

默认情况下，relay 按最新约定优先的顺序跟随 cmux 的 `last-socket-path`
标记文件：先是固定的 `/tmp/cmux-last-socket-path`，然后
`~/.local/state/cmux/last-socket-path`，再然后是旧的
`~/Library/Application Support/cmux/last-socket-path`；都解析不到时回落到
`~/.local/state/cmux/cmux.sock`。这样当 cmux 轮换 socket 名（例如
`cmux-501.sock`）或某次更新把它从 `~/Library/Application Support/cmux` 移到
`~/.local/state/cmux` 时，relay 不会被钉死在一个失效的 socket 上。只有当你
确实需要固定某个 socket 时，才设置 `CMUX_SOCKET_PATH=/path/to/socket`。

> **APNs 推送（`apns` 块）。** 在 `relay.json` 里加上 `apns` 块，cmux 通知
> 就会通过 APNs 投递，即使应用已被杀掉也能收到。不加这个块时通知仅限本地。
>
> ```json
> {
>   "apns": {
>     "key_path": "~/.cmuxremote/AuthKey_XXXXXXXXXX.p8",
>     "key_id":   "XXXXXXXXXX",
>     "team_id":  "XXXXXXXXXX",
>     "topic":    "com.genie.CmuxRemote",
>     "env":      "prod"
>   }
> }
> ```
>
> 开发/侧载构建把 `env` 设为 `"sandbox"`，App Store / 正式构建设为 `"prod"`。

---

## 运维 relay

relay 以 launchd 用户代理（`com.genie.cmuxremote`）运行。因为设了
`RunAtLoad` + `KeepAlive`，它会在登录时自动启动，挂掉后自动重启。

```bash
SERVICE="gui/$(id -u)/com.genie.cmuxremote"

# 重启（不重新构建 —— 最常用）
launchctl kickstart -k "$SERVICE"

# 状态（state / pid / 上次退出码）
launchctl print "$SERVICE" | grep -E "state|pid|last exit"

# 实时日志
tail -f ~/.cmuxremote/log/stderr.log

# 暂停（用 bootout，因为 KeepAlive 会把它拉起来）
launchctl bootout "$SERVICE"
```

要让源码改动生效，重新运行安装脚本——它会一次性完成构建、复制、重新渲染
plist，以及 bootstrap + kickstart：

```bash
./scripts/install-launchd.sh            # 包含 swift build -c release
./scripts/uninstall-launchd.sh          # bootout + 删除 plist
```

---

## 连接排查

如果 iPhone 应用连不上，**在 Mac 上**按顺序执行下面这些检查，一行一行来。
多数问题在第 ① 或 ② 步就能解决。完整的分步说明和一份可以直接发给用户的
提示，见 **[连接指南](docs/connection-guide.md)**。

```bash
SERVICE="gui/$(id -u)/com.genie.cmuxremote"
```

| 检查项 | 命令 | 失败怎么办 |
|---|---|---|
| ① cmux 在运行吗？ | `cmux --version` | 启动 cmux 应用，然后 `launchctl kickstart -k "$SERVICE"` |
| ② relay 起来了吗？ | `curl -s http://$(tailscale ip -4):4399/v1/health` | `launchctl kickstart -k "$SERVICE"`；仍然不行就重新执行 `./scripts/install-launchd.sh` |
| ③ 日志正常吗？ | `tail -n 40 ~/.cmuxremote/log/stderr.log` | 见下面按日志分类的处理办法 |
| ④ 两端 Tailscale 都在线吗？ | `tailscale status` | 确认 Mac 和 iPhone 在同一个 Tailnet |
| ⑤ 应用里的地址对吗？ | `tailscale ip -4` | 确认应用用的是这个 IP 加端口 `4399` |

按日志分类的处理办法：

- `cmux event stream unavailable: socketMissing` —— **cmux 没在运行。**
  启动 cmux 应用，然后 `launchctl kickstart -k "$SERVICE"`。
- 反复出现 `Connection refused` —— **socket 路径变了**（cmux 轮换了 socket
  名，或者某次更新把它移到了 `~/.local/state/cmux`）。较新的 relay 会自动
  跟踪标记文件，所以重新执行 `./scripts/install-launchd.sh` 即可修好。急的
  话可以用 `cat /tmp/cmux-last-socket-path` 查出路径，再用
  `CMUX_SOCKET_PATH` 钉住。
- 健康检查通过但只有应用连不上 —— **网络/地址问题。** 确认 iPhone 和 Mac
  在同一 Tailnet、应用里的地址和端口（`4399`）正确，以及设备令牌没有被吊销
  （`.build/release/cmux-relay devices list`）。

启动日志应当依次打印 `starting cmux-relay on 0.0.0.0:4399` →
`listening …` → `cmux event stream attached`。如果你经常重启 cmux，socket
轮换后重新连上最快的办法是 `launchctl kickstart -k "$SERVICE"`。

---

## 路线图

- [x] v1.0 —— 工作区列表、surface 创建/关闭、终端镜像、按键发送、鼠标模式、
      pane 切换、本地通知、Tokyo Night Storm UI
- [x] v1.0.2 —— 键盘布局修复、照片附加、MacBook 电池角标、
      `needs input` 的 Inbox 处理、工作区创建/重命名/关闭
- [x] v1.0.3 —— 真机上 relay socket 轮换 / 重连的可靠性
- [x] v1.0.4 —— 终端渲染性能、120 行历史、ANSI 256 色 / 真彩基础、真机
      iPhone 实时 relay 冒烟验证
- [x] v1.0.5 —— LIVE 输入模式、谚文 IME 防护、输入面板贴底、终端五行滚动
      空间、Claude/Codex Inbox 回归覆盖
- [x] v1.0.6 —— 原生 APNs 推送（可送达已被杀掉的应用）、Ctrl-C 快捷键、
      五张 App Store 截图全部更新
- [ ] **v1.1 —— 推送后续** —— 基于 payload 的深链自动跳转到对应 surface、
      投递可靠性 / 重试
- [ ] v1.2 —— iPad 布局、外接键盘打磨
- [ ] v1.3 —— cmux "在 pane 中打开" 意图的文件预览
- [x] Android 客户端 —— Kotlin + Jetpack Compose（`android/`），扫码配对、
      与 iOS 相同的四 Tab 界面和功能集，无需 Google Play 服务
- [ ] v2.0 —— 面向高频 TUI（vim、htop、k9s）的字节流 RPC

明确不做的：公网暴露（Tailscale Funnel）、多用户共享、超出实时会话范围的
服务端持久化。

---

## 项目结构

```
cmux-remote/
├─ README.md / README.en.md / README.ko.md
├─ LICENSE
├─ docs/
│  ├─ screenshots/          # README 素材
│  └─ specs/                # 设计文档、RFC
├─ Package.swift            # SharedKit / CMUXClient / RelayCore / cmux-relay
├─ Sources/
│  ├─ SharedKit/            # Codable 模型、JSON-RPC 信封、按键表、屏幕哈希
│  ├─ CMUXClient/           # cmux UDS JSON-RPC 客户端（仅 Mac）
│  ├─ RelayCore/            # 鉴权、会话、DiffEngine、RowState、DeviceStore
│  └─ RelayServer/          # @main、NIO HTTP+WS、launchd 入口
├─ Tests/                   # 单元 + 集成测试
├─ ios/
│  ├─ CmuxRemote.xcodeproj
│  └─ CmuxRemote/
│     ├─ CmuxRemoteApp.swift / ContentView.swift
│     ├─ Network/           # RPCClient、WSClient、AuthClient、EndpointPolicy
│     ├─ Notifications/     # LocalNotificationPresenter、NotificationCenterView
│     ├─ Stores/            # WorkspaceStore、SurfaceStore、NotificationStore、HostStatusStore
│     ├─ Terminal/          # CellGrid、ANSIParser、TerminalView、单元格宽度
│     ├─ Workspace/         # WorkspaceListView、WorkspaceDrawer、WorkspaceView
│     ├─ Settings/          # SettingsView、PairingScannerView
│     ├─ Keyboard/          # CommandComposer
│     ├─ UI/                # Tokyo Night 主题、启动页、Metal 着色器
│     ├─ Security/          # HardeningCheck
│     └─ Storage/           # Keychain
├─ android/
│  └─ app/src/main/java/com/genie/cmuxremote/
│     ├─ net/               # Endpoint、RelayClient（OkHttp WS RPC）、Protocol
│     ├─ term/              # AnsiParser、ScreenState（diff/checksum）
│     ├─ state/             # AppViewModel（连接、凭据、工作区、Inbox）
│     └─ ui/                # MainShell 四 Tab + Connect/Workspace/Terminal/
│                           #   Inbox/Settings 页（Compose）
└─ scripts/
   ├─ install-launchd.sh    # cmux-relay launchd 安装脚本
   ├─ uninstall-launchd.sh
   ├─ relay.plist.tmpl
   ├─ cmux-probe.sh         # 探测 cmux socket
   ├─ smoke-relay.sh        # 端到端 tailnet 冒烟
   └─ evaluate-terminal-keyboard.sh
```

> 内部标识符使用驼峰式的 `CmuxRemote`（Xcode target、Swift 模块名、
> bundle ID `com.genie.CmuxRemote`）。主屏幕显示名是带空格的
> **cmux Remote**。两者都是对的。

---

## 开发

```bash
# 跑全部 Swift 测试（relay + 共享模块）
swift test

# 生成 iOS 应用的 Xcode 工程
cd ios && xcodegen generate

# 构建 Android APK（产出 app/build/outputs/apk/debug/app-debug.apk）
cd android && gradle :app:assembleDebug

# 用进程内的假 relay 跑 iOS 测试套件
xcodebuild test -project CmuxRemote.xcodeproj \
  -scheme CmuxRemote -destination 'platform=iOS Simulator,name=iPhone 15'

# 对真实 cmux + 真实 Tailscale 的完整冒烟（慢；使用临时节点）
SMOKE_EPHEMERAL=1 ./scripts/smoke-relay.sh
```

冒烟脚本会拉起一个临时 Tailscale 节点和一个隔离的配置目录，注册一个假设备，
然后跑一遍所有已公开文档的 relay 端点（`/v1/health`、
`/v1/devices/me/register`、`/v1/state`、`/v1/devices/me/apns`、WebSocket
hello、`workspace.list`、`surface.list`、`surface.subscribe`、
`screen.diff`、`screen.checksum`）。每次改动 relay 的线上格式后都跑一次。

iOS 应用使用 `FakeRPCDispatch`（DEBUG 模拟器构建下默认启用，或用
`FAKE_RPC=1`），所以不接真实 relay 也能构建、运行和通过 UI 测试。

---

## 贡献

欢迎提 issue 和 PR。几条基本规则：

- 一个 PR 一个功能，diff 保持小。
- 补充或更新测试。relay 有不错的单元测试覆盖，iOS 应用有假 relay 分发用于
  UI 测试。两边都不要退化。
- 不要把 cmux 源代码粘进本仓库。我们刻意保持这一侧的许可证清洁（见下文）。
- Bug 报告请附上 relay 日志行和 cmux 版本（`cmux --version`）。

更大的想法（新传输方式、新鉴权模型、字节流 RPC）请先开个 discussion，或者
先在 `docs/specs/` 下放一份设计文档。

---

## 安全

- relay 只绑定 tailnet 接口——非 Tailscale 来源地址会在应用层被拒绝
  （唯一的例外是开发用的 `CMUX_DEV_ALLOW_LOCALHOST=1`）。
- 每台 iPhone 在配对时获得一个按设备的令牌。令牌可以从 relay 的菜单栏单独
  吊销。
- 通知负载从不包含终端内容——只有工作区/surface id 和一个简短标题。
- 无遥测。无分析。无第三方网络调用。

如果你发现安全问题，请给维护者发邮件（见 `SECURITY.md`），不要开公开
issue。

---

## 许可证

cmux Remote 以 **MIT 许可证** 发布，见 [`LICENSE`](LICENSE)。

### 与 cmux 的关系

[cmux](https://github.com/manaflow-ai/cmux) 版权归 Manaflow, Inc. 所有，
以 GPL-3.0-or-later 或商业许可证双重授权。cmux Remote 是一个**独立的网络
客户端**：它不包含、不链接、也不修改任何 cmux 源代码，只通过已公开文档的
JSON-RPC 协议与 cmux 通信。自由软件基金会的一般立场是，纯粹通过已公开文档
的网络协议与 GPL 程序交互的程序，不构成该程序的衍生作品，cmux Remote 正是
在此基础上分发的。

### 商标声明

"cmux" 是 Manaflow, Inc. 用于标识其终端产品的名称。cmux Remote 使用
"cmux" 这个名字仅作描述性用途，用来标识本客户端所要互操作的软件。cmux
Remote 与 Manaflow, Inc. 没有任何隶属、赞助或背书关系。如果你来自
Manaflow 并希望我们改名，请开一个 issue —— 我们会无条件改。

---

## 致谢

- [cmux](https://github.com/manaflow-ai/cmux) 团队，做出了本应用所扩展的
  这款终端。
- [Tailscale](https://tailscale.com)，提供了平淡但完美的传输层。
- [SwiftNIO](https://github.com/apple/swift-nio)，支撑了 relay 的 HTTP/WS
  栈。
