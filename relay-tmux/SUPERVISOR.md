# 监工

监工运行在 Mac 本地独立的 cmux「监工」工作区，使用已安装并登录的 Claude Code。
微信消息默认交给这个会话；监工通过 Panecast 工具管理执行者，后台用 SQLite 保存
目标、会话归属、指令回执、结果证据和待处理消息。模型推理使用本机 Claude 已配置的服务。

需要 macOS、Node.js 22.13+、本地 cmux、已登录的 Claude Code，以及正在运行的 Panecast 网关。

```sh
panecast supervisor start
panecast supervisor status
```

首次启动会创建并选中「监工」工作区。请在这个可见窗口中完成 Claude 的信任或登录
提示。窗口不会因等待超时自动关闭；后台等 MCP 工具连通后再投递首个请求。
再次 `start` 会复用仍然存在的监工工作区。网关重启会继续使用任务数据库和现有
会话，不会重跑未确认的指令或自动创建另一份监工。

微信绑定仍用 `panecast weixin login --browser`。启用监工后，可以直接发送：

- “看看现在有哪些任务在做。”
- “继续登录修复，测试通过后告诉我。”
- “网站配色先暂停，把登录问题优先处理。”
- “这个问题选第二项。”

监工通过终端标题、项目路径和近期正文定位原会话；确实有歧义时才用项目名询问。
它可以登记已有任务，也可以在已发现的本地项目目录中另开 Claude 执行会话。
现有执行者继续使用自己的会话和写入进程，监工不会恢复同一会话的另一个副本。
监工自己启动的执行者通过私有登记表保存确定的会话 ID，直接读取对应记录；不会改写
cmux 的恢复命令或触发额外的恢复授权弹窗。投递前同时核对终端与执行者进程，执行者
退出后不把编码指令送入遗留 shell。

## 操作与状态

微信 `/status` 查看概况，`/read` 查看最近汇报。“暂停监工”和“恢复监工”控制自动
调度。暂停期间普通文字不会落回以前选择的原始终端。

```sh
panecast supervisor pause
panecast supervisor resume
panecast supervisor message "看看登录任务的进展"
panecast supervisor status --json
```

暂停监工会停止自动调度，已运行的工人继续保持自己的状态。要停止某个任务，请明确
告诉监工任务名称，或直接在其终端操作。任务被暂停后，尚未发出的指令会取消。

任务状态区分已登记、排队、执行中、需要用户回答、阻塞、待验收、已完成和已暂停。
执行者产生 final 结果时先进入待验收；监工需要引用该任务的实际结果事件，检查目标
后才能标记完成和推送完成消息。一次工具执行成功、没有新输出或进程空闲不等于完成。

## 独立模块与边界

`supervisor/` 是独立的控制模块，注入 `gateway` 和 `launcher` 接口；cmux、Claude
启动和网关宿主适配位于 `src/hub/supervisor.mjs`。微信入口仅负责交付用户请求和发送
监工明确发布的回复，后续可接其他消息入口而不重写任务逻辑。

| 文件 | 作用 |
| --- | --- |
| `supervisor/store.mjs` | SQLite 事务、任务、事件、输入和输出记录 |
| `supervisor/controller.mjs` | 派工、结果核对、有限跟进和恢复 |
| `supervisor/tools.mjs` | 监工工具契约与角色说明 |
| `supervisor/mcp.mjs` | Claude 的 MCP stdio 入口 |
| `supervisor/ipc.mjs` | 带本机凭据的私有 Unix socket |
| `supervisor/launch.mjs` | 在真实终端启动独立 Claude 进程 |

监工自身只启用自己的 MCP 工具，内置 shell、文件编辑和其他子代理工具不开放。
执行者保留原生工具与权限交互。选项问题必须有明确用户答复，并在提交前重新核对
问题和高亮选项；多选或无法可靠识别的菜单提示到 Panecast 中处理。

后台按任务状态和新事件唤醒监工，普通工具输出不会触发微信推送。同一触发事件的
相同指令复用同一个操作记录。写入前记录 attempting；重启后 attempting 变为 unknown，
不会自动重发。后来在真实会话中发现匹配的用户输入，可以把未知回执核对为已接收。

未确认指令仍需人工核查时，可以在电脑使用：

```sh
panecast supervisor resolve OPERATION_ID received
# 或确认应取消这一条：
panecast supervisor resolve OPERATION_ID cancelled
```

自动跟进每个任务最多连续三次，持续失败转为需要用户处理。没有汇报时最多提醒监工
一次，随后报告异常，避免空转。指令和会话身份仍由后台检查，不仅靠模型记忆。

数据位于 `state_directory/supervisor/`，默认 `~/.cmuxremote/hub/supervisor/`。文件只
允许当前用户访问。数据库与会话独立；请备份整个目录。SQLite/锁异常只停用监工模块，
不应关闭已有终端网关。命令结果不确定时应先核查，不要删除数据库来重试。

当前第一版重点是本机 cmux 的 Claude/Codex 会话；新建执行者使用 Claude Code。
远程来源、普通 shell 与不能验证身份的终端不自动执行编码指令。多用户、跨主机调度、
完整工作流编排和自动合并不在这一版范围。

## 验证

```sh
cd relay-tmux
node --test test/supervisor.test.mjs test/weixin.test.mjs test/weixin-hub.test.mjs
npm test
```

自动化测试覆盖任务绑定、重复派工、繁忙队列、未知回执恢复、真实证据验收、问题
变化拒绝提交、微信收件人隔离、暂停后不回退到原始终端、MCP/IPC 和启动参数传递。
真实 Claude 验证应使用单独且可见的 cmux 工作区，让用户完成信任提示；保留窗口供查看。
