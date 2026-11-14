# 微信接入

微信入口复用 Panecast 网关中已经授权的 cmux 终端。绑定本人微信后，可以选择终端、
发送文字和接收 Codex / Claude Code 的问题与完成结果。不会启动另一份 agent 会话。
首版运行在 macOS 网关，支持本人私聊和文字；群聊、其他用户与附件不会作为终端输入执行。

## 绑定

先启动配置好的 Panecast 网关，然后运行：

```sh
panecast weixin login --browser
```

浏览器展示仅本机可访问的二维码。用本人微信扫码，并在微信中确认。如果微信要求
PIN，在页面输入手机显示的数字。完成后网关会自动启用通道，无需重启终端任务。
绑定者的微信 ID 来自确认绑定的响应，不接受“第一个发消息的人”认领。

无浏览器时运行 `panecast weixin login`，在终端扫码并输入 PIN。
`--qr-file /absolute/path/login.svg` 可另存本次二维码；二维码只能在有效期内使用。
自定义配置沿用 `--config /absolute/path/hub-relay.json`。

## 微信里的命令

| 消息 | 效果 |
| --- | --- |
| `/list` | 列出可访问的 cmux 终端及固定编号 |
| `/use 编号` | 选择终端，并从当前位置开始订阅问题与完成消息 |
| 普通文字 | 输入所选终端并发送回车 |
| `/send /某个命令` | 将以斜线开头的内容原样发给终端 |
| `/read` | 查看最新正文；普通 shell 显示当前画面 |
| `/status` | 检查终端绑定和未确认回复 |
| `/key up`、`/key down`、`/key enter` | 在终端选择菜单中操作 |
| `/key escape`、`/stop` | 取消菜单，或发送 Ctrl-C 停止任务 |
| `/unbind` | 取消终端选择及其待发通知 |
| `/dismiss` | 清除未确认的微信回复记录，不重跑终端指令 |
| `/help` | 查看帮助 |

同目录中的多个终端仍以来源、workspace、surface 分别绑定。关闭终端、撤销来源、
或该 surface 换了新的会话后，旧选择不会自动落到其他终端。遵循当前网关的来源配置；从配置移除来源会阻止其后续输入和消息发送。
新版 cmux 优先使用目标明确的 `terminal.paste` 一次完成粘贴与提交；旧版沿用文字、
聚焦、回车的顺序。任何发送结果不确定时都不会换一个发送路径再试。

连续工具执行与普通进度不会推送。结构化记录中的 final、显式提问、当前决策菜单，
以及已有的完成/问题事件可以触发消息。不会因为屏幕暂时停止变化就推断任务完成。
长回复按文字边界分段；图片、语音和文件支持留待后续版本。

## 状态、退出及恢复

```sh
panecast weixin status
panecast weixin logout
```

登录与发送状态位于网关 `state_directory/weixin/`，默认是 `~/.cmuxremote/hub/weixin/`。
凭据与消息记录仅允许本机当前用户读写。`logout` 清除本机登录凭据，后台停止收发；
微信侧的 Bot 绑定可在微信里解除。未确认消息的本地记录仍保留，便于核查。

消息与轮询游标同时保存后才处理，外部输入开始前先记录 processing。重启恢复尚未
开始的消息；执行中断或回执丢失的指令不自动重跑。先 `/read` 检查实际结果，再决定
是否重新发送。该机制不宣称跨微信、磁盘和终端的严格 exactly-once。

微信回复需要入站消息的 `context_token`。令牌被服务端明确拒绝时，保留未发送的部分，
待收到新的微信消息后使用新上下文再发；网络断开造成结果不确定时不自动重发。
首次主动通知前，需要先在微信发消息并选择终端。长任务回推是否被平台接受仍以实际
微信服务响应为准。登录失效会停止通道，重新 `login` 即可恢复。

## 开发验证

```sh
cd relay-tmux
node --test test/weixin.test.mjs test/weixin-hub.test.mjs
npm test
```

测试涵盖扫码/PIN、私聊身份、消息去重、崩溃恢复、未知回执、上下文更新、终端精确
路由、原子粘贴、权限撤销及完成过滤。端到端 fixture 使用隔离的 WebSocket cmux
后端和临时会话文件，不操作用户真实终端，也不会给真实微信账号发测试消息。

协议参考腾讯公开的 [Weixin Backend API Protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)。
这是 Panecast 自己的协议适配，不需要安装 OpenClaw；首次真实登录与收发需要用户扫码联调。
