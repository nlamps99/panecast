# 统一网关：cmux、tmux、Codex

一台电脑运行一个 Panecast hub，手机配对一次后可以查看这台电脑授权的所有来源。
来源可以同时存在，手机的「来源」页显示连接状态和实际能力；终端从「工作区」打开，
Codex 使用独立的会话、消息、命令输出、文件修改和待确认请求界面。

需要 Node.js 22+。tmux 来源需要 tmux 3.2+；cmux 来源需要已运行的 Swift relay；
Codex 来源需要支持 App Server 的 Codex 安装。本地验证使用 codex-cli 0.166.0。

## 安装与配对

```sh
cd relay-tmux
npm ci
mkdir -p ~/.cmuxremote
cp hub.example.json ~/.cmuxremote/hub-relay.json
chmod 600 ~/.cmuxremote/hub-relay.json
```

编辑配置中的 broker 地址、relay ID 和 relay token。每台电脑使用独立的 relay ID，
同一电脑的多个来源都放在 hub 后面。**不要让旧 relay 和 hub 同时用同一个 ID 连接
同一 broker**：cmux relay 继续在电脑上提供本地接口，把它原来的 `broker` 配置移除，
由 hub 单独连接 broker。另一个选择是先给 hub 使用独立 broker 实例验证。

例子中的来源默认未授权。配置好后，在电脑端授予需要的权限：

```sh
npm run hub -- sources grant tmux --access control
npm run hub -- sources grant codex --access read
npm run hub -- sources list
npm run hub -- serve
```

另开一个终端运行 `npm run hub -- pair`，输入 broker 配对码，在手机上扫描二维码。
配对沿用现有协议，已有单一 cmux/tmux relay 和演示模式仍然可用。

可选局域网直连：在配置顶层添加 `"host": "0.0.0.0"`、`"port": 4400` 和
`"lan": { "pairing_code": "独立随机配对密钥" }`，然后运行
`npm run hub -- pair --lan-host 192.168.1.42`。4400 与旧 cmux relay 的 4399 分开。
不配置 `lan` 时不会打开手机 TCP 监听端口。

## 授权与撤销

- `enabled: true` 表示电脑所有者授权此来源接入；未启用的来源不会被连接。
- `access: "read"` 允许查看；`"control"` 才允许发送输入、创建/关闭终端或操作 Codex。
- 每个已配对设备继承本 hub 授予各来源的权限。目前没有按手机或按单个会话细分的授权。
- 手机不能提交任意来源地址、可执行程序、密钥或提升权限。来源配置和密钥留在电脑上。
- Codex 自身的登录、项目权限、沙箱和审批仍然有效。hub 不覆盖这些设置，审批需用户点击回应。
- broker 延续现有 TLS 中转协议，不是端到端加密。

```sh
npm run hub -- sources grant tmux --access read
npm run hub -- sources revoke codex
```

运行中的 hub 每秒重读来源配置，权限调整会关闭相应来源连接，后续请求按新权限执行。
已经开始的操作不能回滚。设备级撤销使用更新后的 broker 设备管理；通过管理 CLI
撤销的在线设备会在下一次同步时断开（默认最多 15 秒）；HTTP 撤销会立即断开。LAN 的
`DELETE /v1/devices/me` 会同时断开该设备已有连接。更改 broker、监听端口和 APNs
等非来源配置需要重启 hub。

## cmux

cmux 通过现有 Swift relay 接入，保留其终端订阅、历史和项目文件协议。
配置 `url`（通常为 `ws://127.0.0.1:4399/v1/ws`）、`device_id` 和 `token`。

手机终端顶部可切换「对话 / 终端」。对话模式把正文显示为气泡，连续工具执行默认
折叠，点按摘要可以展开；发送消息仍通过当前 surface 的输入通道发送文字和回车。
需要审批时可切回终端，或展开「终端按键」操作。

`terminal.conversation` 根据 cmux `surface.resume.get` 的精确会话绑定读取本机 Codex / Claude Code
记录，不按项目目录猜测会话。cmux 来源必须连接本机 loopback relay；远程来源、没有
绑定的普通 shell 和旧 relay 会显示终端输出。自定义记录目录可在来源配置中指定
`codex_home` 或 `claude_home`，默认使用环境变量和用户主目录。分页 cursor 绑定会话
和文件身份，读取不会恢复会话、创建任务或发送输入。
后两个值应来自该 relay 的正常设备登记，不是 broker 的 relay token。
可通过 relay 的 `POST /v1/devices/me/register`，使用其 LAN 配对码登记一个名为
Panecast hub 的独立设备；把返回凭据直接存到权限为 0600 的本地配置中。
然后执行 `npm run hub -- sources grant cmux --access control`。

终端窗口、工作区、surface 和通知 ID 都带来源命名空间，因此不同后端相同 ID
不会互相覆盖。cmux 和 tmux 的文字输入、按键、终端管理、历史、附件和项目读取
使用现有手机界面。cmux 来源掉线不会阻断其他来源。

## tmux

默认连接当前用户的 tmux server；用来源字段 `tmux_socket` 指定 `tmux -L` 名称。
可添加多个不同 ID 的 tmux 来源。关闭工作区会结束对应 tmux session 及其进程。

任务通知 hook 可在 tmux 内调用：

```sh
node /path/to/panecast/relay-tmux/src/hub/cli.mjs notify \
  --source tmux --needs-input --title '等待确认'
```

任务完成用 `--completed`，失败或阻塞用 `--failed`。普通进度不推送；省略这些标记时，
只识别明确的“任务完成”“等待确认”等通知标题。APNs 配置沿用 [tmux relay 文档](README.md)。

## Codex 的三种接入模式

| mode | 数据与能力 | 适用情况 |
|---|---|---|
| `history` | 通过独立的本地 App Server 读取已保存会话，禁止 resume、发送、停止、审批 | 当前桌面 App 没有可连接的控制 socket |
| `attach` | 连接已有 App Server，读取其历史和状态；授权 control 后可续写、追加、停止、回应审批 | 已有服务开放本地 socket 或 WebSocket |
| `managed` | hub 启动并管理一个独立 App Server，可以新建和继续它管理的会话 | 希望从手机启动 Codex 工作流 |

`history` 和 `managed` 使用 `codex app-server --listen stdio://`；`attach` 默认连接
Codex 数据目录下的 `app-server-control/app-server-control.sock`，可通过 `socket`
指定控制 socket，也可配置 `url` 与可选 `token`。Unix socket 上使用 WebSocket
握手与帧；CLI 的 `app-server proxy` 是原始字节通道，不能直接作为 JSONL 使用。
`codex_home` 可以指定本地 Codex 数据目录，`executable` 可以指定 Codex 二进制路径。
这些路径和命令只接受电脑端配置。手机新建对话时可以选择已有会话使用过的项目目录，
也可以选择个人目录。电脑端设置 `cwd` 可提供默认目录；设置 `projects` 列表则把
可新建项目限制在该列表，例如 `[{ "name": "Panecast", "cwd": "/path/to/panecast" }]`。
手机提交项目 ID，不能指定任意本地路径。

已有 socket 的来源示例：

```json
{
  "id": "codex-live",
  "type": "codex",
  "name": "Codex 实时会话",
  "enabled": true,
  "access": "control",
  "mode": "attach",
  "socket": "/absolute/path/to/app-server-control.sock",
  "cwd": "/absolute/path/to/project"
}
```

**桌面 App 仅通过私有 stdio 运行时，hub 不会接管那条管道。** 新建一个 App Server
或共用历史目录，并不等于取得原桌面进程的实时任务。此时用 `history` 查看历史，
或将后续任务放到明确配置的共享/独立服务上。界面会持续标注模式。

Codex 接口按版本适配：当前支持 `thread/list`、`thread/read`、分页 turns、
`thread/resume`、`thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、
归档及本连接收到的命令/文件审批和用户提问。不支持的审批要求回到电脑处理。
历史分页不支持时仅对 `method_not_found` 回退到旧版 `thread/read`。
Codex 通知目前显示在会话界面；尚未接入终端 Inbox 或后台 APNs。

### 桌面 App 与手机操作同一个任务（实验性）

桥接启动器保留桌面 App 的原始 JSONL 交互和配置参数，让它启动的同一个 Codex
进程在私有 Unix socket 上接受 Panecast。只使用本机入口，不额外开放 TCP 端口。
App 退出时由桥接器关闭自己启动的进程；手机断开不关闭该进程。桥接优先使用桌面
App 自带的签名 Node 运行时，保留内置工具连接需要的进程签名链。
只有桌面 App 直接启动的 Codex 会创建该入口。终端或工具内部继承到启动覆盖点时，
会原样调用真实 CLI，不会占用桌面入口。带 `desktop_app` 的来源还会检查入口所属
进程，避免把独立 CLI 的历史服务误报为桌面实时服务。

```sh
cd relay-tmux
npm run desktop -- prepare
```

默认检查 `/Applications/ChatGPT.app`，旧版路径可以传 `--app /Applications/Codex.app`。
准备步骤生成 `~/.cmuxremote/desktop/` 下的启动器、清单和 `source.json`，不重启 App、
不改写现有配置，也不会重复覆盖生成文件。

1. 等当前任务完成，正常退出桌面 App。已运行任务的内存状态不能中途无损迁移。
2. 打开生成的 `Launch Panecast Codex.command`。App 已运行时启动器会拒绝继续，不会强制退出。
3. 运行 `npm run desktop -- check`，确认连接成功并能列出已加载会话。
4. 把生成的 `source.json` 条目加入 hub 配置的 `sources`，执行
   `npm run hub -- sources grant codex-desktop --access control`。
5. 在桌面打开或发起任务；手机「来源 → Codex 桌面会话」会标出「正在运行 · 已连接」。
   点开后可以追加指令、停止任务、回应本连接收到的审批。

每个会话都会检查是否已加载在所连接的服务里。只有保存记录的会话会标为「已保存的历史」，
点开仅查看记录。用户可以明确点击「继续对话」在当前服务恢复已结束的会话，或点击
「从历史新建」分支为新会话。若记录最后一轮仍为运行中而当前服务没有加载它，直接恢复
会被拒绝，以免与另一个进程重复执行；可选择分支或在原服务中结束任务。

新客户端先显示本机已缓存的会话，再更新最新消息；向上滑自动续接历史，并提前读取下一段。
每次默认请求 10 轮，网关最多接受 20 轮；旧客户端仍按 5 轮读取。
手机默认折叠连续的工具调用，优先显示对话正文，点击摘要可展开查看。
进行中及失败的数量在摘要中显示，任务错误和等待回应的请求直接显示。
手机使用虚拟列表展示消息；工具输出和 diff 使用有长度上限的片段，
每轮保留最近 30 条工具记录，并明确显示截断或省略提示。用户消息和回复仍可按轮分页，
完整工具记录在电脑上查看。旧 relay 返回的大记录也会在客户端做格式检查和限量处理。

追加输入使用 `turn/steer`，收到接受回执后显示“已送达”，并通过 Codex 返回的消息
`clientId` 确认它已写入对话。模型通常在当前步骤结束后消费追加内容。历史刷新不会
覆盖刚收到的实时消息，旧历史里的 `inProgress` 不再作为当前任务依据。如果 Codex
明确拒绝追加并说明当前回合已结束，网关会把同一条输入作为下一轮发送一次；超时、
未知结果或任务 ID 不匹配时不会自动重发，手机保留草稿。

这条启动路径使用桌面包中现有的 `CODEX_CLI_PATH` 启动覆盖点，不属于官方承诺稳定的
桌面扩展 API。已在本机 ChatGPT 26.1027.51404 / 内置 Codex 0.166.0-alpha.5.1 上验证
真实桌面启动、通过公网 broker 读取会话列表和详情，以及签名运行时下的内置工具启动。
隔离集成测试使用同一真实 Codex 二进制和本地模拟模型，验证两个客户端共享同一运行
回合、追加指令、停止以及新会话读取。回退时退出 App 并按原方式打开，不再使用此启动器即可。

`npm run desktop -- wait-and-launch` 可在独立进程中等待 App 正常退出、启动并自检，
状态写入启动器目录中的 `pending-launch.json`，启动诊断写入 `desktop-startup.log`。
不要配置无限重启此一次性任务，否则用户正常退出 App 后它可能再次打开。

运行隔离集成测试（不会使用真实账号或发送请求到 OpenAI）：

```sh
PANECAST_TEST_CODEX=/absolute/path/to/codex npm test
```

官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 验证与常驻

`npm test` 验证真实隔离 tmux、cmux 协议模拟服务、Codex 协议模拟服务、统一手机
WebSocket、权限拒绝、来源隔离和撤销，不修改用户的日常会话。

常驻运行可使用 [tmux 指南](README.md) 中的 systemd 模板，把 `ExecStart` 改为：

```ini
ExecStart=/usr/bin/node src/hub/cli.mjs serve --config /home/USER/.cmuxremote/hub-relay.json
```

macOS 安装 `panecast` 命令后，可用 `panecast start` 设置登录后常驻，使用
`panecast status`、`panecast logs`、`panecast restart` 和 `panecast stop` 管理。
安装入口见 [下载页](https://ningzx.cn/panecast/)。hub 不改动现有 cmux launchd 服务。
