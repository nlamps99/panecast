# Panecast：给 Claude / agent 的项目说明

Panecast 让你在手机上查看和操作电脑上的终端。它由 cmux Remote（NewTurn2017/cmux-remote）演变而来，保留了完整提交历史，以后不再和上游同步。

目标：
- 用一套 Expo 客户端覆盖 iOS、Android 和 Web。
- 上架 App Store，之后长期用 OTA 推送更新。
- 终端后端不只支持 cmux，之后还要支持 tmux 等。

用户用中文交流。VPS、手机、账号、正在运行的 relay 这些私人环境信息写在 @CLAUDE.local.md 里，这个文件不入库。

**当前任务：第 1 步，做原型（见下文）。**

## 目录

| 目录 | 内容 | 状态 |
|---|---|---|
| `client/` | Expo 客户端（SDK 58、expo-router、TypeScript），bundle id `com.nzx.panecast`。Expo 相关规则见 `client/AGENTS.md` | 只有占位页，正在开发 |
| `relay/` | Mac relay，Swift package（SwiftNIO），通过 cmux 的 JSON-RPC socket 读取屏幕、发送按键 | 可用 |
| `broker/` | VPS broker，Node（`src/server.mjs`），手机和 Mac 都主动连接它 | 可用 |
| `docs/specs/` | 协议设计、cmux 返回数据样例 | 参考 |
| `legacy/` | 原生 iOS（SwiftUI）和 Android（Kotlin/Compose）客户端 | 冻结，只作参考，新客户端功能追平后删除 |

## 路线图

1. **原型（当前）**：终端页、输入（含中文输入法）、broker 扫码配对，在真机上跑通。
2. **追平原生版**：工作区和 surface 的列表与管理、多台电脑、局域网和 broker 自动切换（AUTO）、Inbox 和推送、图片附件、设置、演示模式（给 App Review 用）。
3. **扩展后端**：支持 cmux 以外的终端后端，比如 tmux。
4. **发布**：TestFlight，然后上架 App Store；Android 的 APK 发到 GitHub Releases；之后的小改动走 OTA。

## 第 1 步要做的事

都在 `client/` 里完成。非路由代码放在 `src/` 下，不要放进 `src/app/`。

- **协议层**
  - 解析配对 URL，完成注册。
  - WebSocket 客户端：发送 hello、按 id 对应 RPC 请求和响应、处理推送帧、ping/pong、断线重连。
  - 屏幕状态：应用 `screen.full` 和 `screen.diff`，用 `screen.checksum` 校验，不一致就重新订阅。
- **终端页**
  - 等宽字体渲染，支持 256 色和真彩色的 ANSI 颜色。
  - 按词折行；只由横线组成的行截断到屏幕宽度（见「已知经验」）。
  - 往上滑时用 `surface.history` 加载更早的历史。
- **输入**
  - 两种模式：命令输入框（整行发送）和逐字输入。
  - 键盘辅助条：esc、方向键、tab、Ctrl-C。
  - 中文输入法还在组字时，不能把半截内容发出去。
- **扫码配对**：用 `expo-camera` 扫 `cmux://pair?...`，注册成功后把 token 存进 `expo-secure-store`。
- **验证**：先给协议层写单元测试，再在真机上验证。

## 协议要点（以 relay 和 broker 的源码为准）

参考实现：
- `legacy/android/app/src/main/java/com/genie/cmuxremote/net/` 下的 `Protocol.kt`、`RelayClient.kt`、`Endpoint.kt`，最短也最清楚。
- iOS 版在 `legacy/ios/CmuxRemote/Network/`。
- Swift 类型定义在 `relay/Sources/SharedKit/`。

**配对 URL**
- 格式：`cmux://pair?server=<broker URL>&relay=<relay id>&code=<配对码>`。
- 可以额外带 `lan=<http://局域网IP:4399>&lancode=<局域网配对码>`。这两个参数要么都有，要么都没有。
- 见 `relay/Sources/SharedKit/PairingPayload.swift`。

**注册**
- 请求：`POST /v1/devices/me/register`。
  - 局域网和 broker 模式：body 是 `{pairing_code, client_id, device_name}`，走 broker 时还要加 `relay_id`。
  - Tailscale 直连：靠 tailnet 身份认证，不需要配对码。
- 响应：返回设备 token 和 device id。
- broker 按来源 IP 限制每分钟 5 次。配对码错误返回 403 `pairing_rejected`，超过次数返回 429。

**WebSocket**
- 地址：走 broker 是 `wss://<server>/v1/ws?relay_id=<id>`，直连 relay 是 `ws://<host>:4399/v1/ws`。
- 升级请求要带 `Authorization: Bearer <token>`，子协议是 `cmuxremote.v1`。
- Mac relay 离线时，broker 返回 503。
- 连上后，**第一帧必须在 100ms 内**发送 hello：`{"deviceId","appVersion","protocolVersion":1}`。注意这里的键是 camelCase。超时 relay 会断开连接。

**RPC**
- 请求：`{"id","method","params"}`。响应：`{"id","ok","result"}` 或 `{"id","ok","error"}`。
- relay 自己处理的方法：`surface.subscribe`（参数 `workspace_id`、`surface_id`、`lines`）、`surface.unsubscribe`、`surface.history`、`host.battery`、`file.upload`。
- 其余方法原样转发给 cmux，比如 `workspace.list`、`surface.list`、`surface.send_text`、`surface.send_key`。

**推送帧**：没有 id，按 `type` 区分，键是 snake_case。
- `screen.full`
- `screen.diff`，ops 有 `row`、`cursor`、`clear` 三种
- `screen.checksum`
- `event`
- `ping` / `pong`

**relay 的其它接口**：`GET /v1/health`、`GET /v1/state`、`POST /v1/devices/me/apns`、`DELETE /v1/devices/me`。

**React Native 的注意点**：RN 的 `WebSocket` 支持一个非标准的第三个参数 `{ headers }`，可以用来带 Authorization，实现前先按 SDK 58 的文档确认。浏览器里的 WebSocket 不能带自定义请求头，所以 Web 端要另想鉴权办法，这一项还没定。

## 已知经验

- **终端宽度**：Mac 上的 pane 通常有 150 列以上，iPhone 竖屏在默认字号下只放得下约 40 列，所以大部分行都会折。原生 iOS 版（`legacy/ios/CmuxRemote/Terminal/TerminalView.swift`）是这样处理的，新客户端照此实现：
  - 按词折行。
  - 只含横线字符的行（`─━═╌╍┄┅┈┉-=`）截断到屏幕宽度，不要折成好几行。
  - 列数 = 可用宽度 ÷ 字符宽度。GeistMono 的字符宽度是 0.6em。
- **没有颜色**：目前 cmux 的 `surface.read_text` 只返回纯文本，不带颜色转义序列。ANSI 解析照样要做，但现在显示不出颜色不是 bug。
- **输入法**：只支持中文输入法，不做韩文等其它语言的特殊处理。中文输入法组字时，RN 的受控 TextInput 容易把字拆散，而且 JS 层分不清哪些是还在组字的拼音字母，所以输入框用的是 `client/modules/terminal-input` 原生组件，它只把输入法确认过的文字交给 JS。逐字输入模式要等组字结束后再发送。
- **不依赖 GMS**：Android 版刻意不依赖 Google Play 服务，因为很多国内机型没有 GMS。扫码等功能选型时要保持这一点。没有 GMS 的手机收不到 FCM 推送，这是已知限制。

## 约定

- 装包用 `npx expo install`（见 `client/AGENTS.md`）。国内的 npmmirror 有时比官方源晚几天同步 Expo 新包。遇到 `No matching version found` 时，加 `--registry https://registry.npmjs.org` 装一次就行，不要改用户的全局 npm 配置。
- 不要改 Mac 和 VPS 端现有的命名：`cmux-relay`、`~/.cmuxremote/`、`CMUX_*` 环境变量、launchd 标签 `com.genie.cmuxremote`、broker 容器名。用户的环境正在用这些名字，要改名得单独规划迁移。
- 保持协议兼容：新客户端要能直接连上现在正在运行的 relay 和 broker。
- App 名字和品牌里不要用 "cmux"。App Store 上已经有 "Cmux Remote"，而且 cmux 是 Manaflow 的产品名。描述里可以写 "for cmux"。
- 提交信息用英文祈使句，写清楚为什么改。
- 不要提交密钥。relay token、配对码、设备 token 都是密钥，日志和截图里也要打码。

## 验证命令

```bash
cd client && npm run typecheck && npm run lint && npx expo-doctor
cd relay && swift build && swift test
cd broker && npm test
```

## 待定

- 扩展到 tmux 时 relay 用什么语言写：让 Swift relay 支持 Linux，还是用 TypeScript 重写，好和客户端共用协议代码。
- OTA 用 EAS Update，还是在自己的 VPS 上搭更新服务。国内访问 Expo 的服务器可能比较慢。
- 新 App 的配对 URL scheme：继续用 `cmux://pair`，还是改成 `panecast://`，同时兼容旧的二维码。
- Web 端的 WebSocket 鉴权方式。
- 上架前要换掉 Expo 模板自带的图标和启动图，并写一份新的隐私政策（旧的在 `legacy/PRIVACY.cmux-remote.md`）。
