# 分享窗口

把电脑上的一个 Claude 窗口交给别人用：对方拿到一把密钥，在 Panecast 里粘贴后只能看到、
只能操作这一个工作区里分享出去的终端，不用配对，也看不到这台电脑上的其他工作区、终端和通知。
访客可以在这个工作区里自己再开终端（最多 5 个），每个都运行同样设置的 Claude。

## 用法

```sh
panecast share create 论文 --guest 张三      # 新建目录和受限的 Claude 窗口，并给张三一把密钥
panecast share key 论文 --guest 李四         # 同一个窗口再发一把密钥
panecast share reopen 论文                   # 重新打开窗口（访客密钥不变，旧窗口关闭）
panecast share list                          # 查看分享和每把密钥的状态
panecast share revoke 论文 --guest 张三      # 只撤销张三的密钥
panecast share revoke 论文                   # 停止分享，所有密钥失效
```

- 默认目录是 `~/Panecast-Shares/<名称>`，可以用 `--dir` 指定。不能用主目录、它的上级目录，也不能用 `~/.ssh`、`~/.claude`、`~/.cmuxremote`、`~/Library` 这类目录。
- 密钥只显示一次，形如 `pcs1.…`。对方在 Panecast 的「添加电脑」里粘贴即可。
- 窗口第一次启动时，Claude 会问是否信任这个目录，在 cmux 里确认一次。
- 默认不能联网。需要装包或访问网站时加 `--allow-domain pypi.org`（可重复）。
- 需要网关已配置 broker（`panecast setup`），并且 broker 支持访客密钥。

## 联网分享（`--net`）

```sh
panecast share create 项目 --net             # 文件只限这个目录，网络放开
```

- 文件和受限分享一样：只能读写分享目录（和临时目录），读不到主目录下的其他文件，`!`、Ctrl-G 等照旧拦住。
- 网络：Claude Code 的沙箱不允许把白名单设成 `*`，所以改成不严格的白名单。GitHub、PyPI、npm（含 npmmirror）、清华/阿里镜像、Hugging Face、arXiv 直接可用；其他网站第一次连接时窗口里会问「Do you want to allow this connection?」，访客选 Yes 后这个窗口里不再问（`reopen` 后重新问）。还要常用的站点加 `--allow-domain`。
- 网页抓取（WebFetch）不再询问；它本身不访问本机和内网地址。沙箱拒绝 `localhost`、`127.0.0.1` 等本机地址，访客批准也连不上这台电脑上的服务。
- 需要注意：放开网络后，分享目录里的文件可以被传到任何网站。

## 完整权限分享（`--full`）

```sh
panecast share create 自己用 --full          # 不受限的 Claude，给自己或完全信任的人
```

- 窗口里运行的是你平时的 Claude：读你的个人设置、插件、MCP 和斜杠命令，用 `--dangerously-skip-permissions` 启动，没有沙箱，不弹权限确认。
- 访客的文字和按键原样送达，`!` shell 模式、Ctrl-G、Ctrl-V 等全部可用；`--dir` 可以是任何文件夹。
- 仍然只能看到和操作这个分享的终端，访客新开的终端同样是完整权限的 Claude；不能新建、关闭别的工作区，也收不到通知；文件列表和下载链接仍只限分享目录。
- **拿到密钥的人等于坐在这台电脑前**：能读写你所有文件（包括 `~/.ssh`、钥匙串里能读到的东西）、联网、运行任何命令。只给自己或完全信任的人，不用时 `panecast share revoke 名称`。
- `reopen` 保持完整权限。下面「访客能做什么」和「安全设计」说的是默认的受限分享。

## 任务接口（`--full --tasks`）

```sh
panecast share create 任务 --full --tasks   # 完整权限窗口，再加一个给程序用的任务接口
panecast share tasks 任务                    # 最近的任务和状态
```

程序拿分享密钥（`pcs1.…`）当 Bearer 令牌调用 broker 上的 HTTP 接口；任务排队，一个一个送进这个分享的第一个终端，Claude 回答完，它最后的回复就是结果。你在 cmux 和 Panecast 里看得到每个任务在跑，也可以插手。

| 请求 | 作用 |
|---|---|
| `POST /v1/tasks[?wait=秒]`，body `{"text": "…", "attachments": [{"name": "图.png", "data_base64": "…"}]}` | 提交任务，返回 201 `{task}`；带 `wait` 时在同一个请求里等结果（最多 300 秒） |
| `GET /v1/tasks/<编号>[?wait=秒]` | 查询任务；带 `wait` 时等到做完或超时再返回 |
| `GET /v1/tasks[?limit=20]` | 最近的任务，新的在前 |
| `POST /v1/tasks/<编号>/cancel` | 排队的移出队列；正在做的在窗口里按 Esc 打断 |

```sh
curl -s 'https://panecast.drinklake.com/cmux-remote/v1/tasks?wait=300' -H "Authorization: Bearer $PANECAST_KEY" \
  -H 'content-type: application/json' -d '{"text":"总结一下附件","attachments":[{"name":"a.png","data_base64":"…"}]}'
```

- 任务：`id`、`status`（`queued` 排队 → `sending` 送进窗口 → `running` 在做 → `done` / `failed` / `canceled`）、`result`（Claude 这一轮最后的回复）、`files`（Claude 存进 `tasks/<编号>/out/` 的文件，带 1 小时内有效的下载链接）、`attachments`、`position`（排队时第几个）、`error`。
- 附件也可以写成 data URL（`{"data": "data:image/png;base64,…"}`），每个任务最多 10 个、合计 20 MB，存进分享目录的 `tasks/<编号>/`；任务文字里会列出路径，Claude 用 Read 工具看图片和 PDF。文字最多 32,000 字。
- 同一个窗口一次只做一个任务，任务之间是同一段对话（上下文会累积，Claude 自己压缩）。你自己在窗口里提问时，任务等你这一轮结束再送。
- 窗口里的 Claude 用 `--disallowedTools=AskUserQuestion` 启动，不会停下来等人回答选择题。
- 任务窗口被关掉、或者 Claude 退出了，下一个任务来时网关在同一个工作区重新开一个（工作区也没了就新开一个工作区），等 Claude 启动后再送。
- 判断做完靠 Claude 的钩子：每个终端把 SessionStart、UserPromptSubmit、Stop、SessionEnd 追加到 `~/.cmuxremote/hub/shares/<编号>/events/<终端>.jsonl`，Stop 带着这一轮的 `prompt_id` 和最后一条回复。按 Esc 打断没有 Stop，网关从 Claude 的对话记录里看到「[Request interrupted by user]」后把任务标为失败，接着做下一个。任务记录在同一目录的 `tasks.json`（保留最近 200 个）。
- 送进窗口：先粘贴，停 0.4 秒再单独按回车（多行粘贴时随粘贴一起到的回车会被 Claude 吞掉）；10 秒和 25 秒时没看到 Claude 接收就再按一次回车，不会重复粘贴；60 秒还没开始就标为失败（之后 Claude 又接收了，任务会恢复）。
- 密钥就是完整权限分享的密钥：拿到它的程序能让这台电脑做任何事。broker 每个请求开一个访客连接、调一次方法就关，不保存任务；电脑离线时返回 503。

## 访客能做什么

对方的连接只能访问这个分享的终端：

- **新开和关闭终端**：终端标签旁的「新建」在同一个工作区里再开一个终端，运行和第一个窗口同样设置的 Claude（受限、联网、完整权限跟着分享走），各自一段对话，目录都是分享目录。连同第一个窗口最多 5 个终端（每个都是一个 Claude 进程，用你的额度）。终端可以关掉，第一个也可以，但只剩一个时不能关。你自己在这个工作区里开的终端访客看不到。新开的终端不抢你在 cmux 里的焦点。`reopen` 只重开一个终端，访客开的那些随旧工作区一起关掉。
- **能做**：看屏幕、读历史，在对话模式里读每个终端的 Claude 对话记录；像在自己电脑上一样打字和编辑，多行文字、以 `/` 开头的文字、退格、Delete、Tab、Shift-Tab（切换 Claude 的模式）、Home/End、Ctrl 和 Option 组合键（Ctrl-U、Ctrl-W、Ctrl-S、Option-P 等）都能用；取回分享目录里的文件，把任意大小的文件发进分享目录。
- 2026-11-17 之前创建的窗口没有下文的消息钩子，退格、删除这类会删字的键要先运行 `panecast share reopen 名称` 重新打开窗口；其余按键照常可用。
- **会被改写**：逐字输入的半角 `!` 变成全角 `！`；整句发送和粘贴的消息保留 `!`，只有开头的 `!` 变成全角。
- **被拒绝**：新建、关闭、重命名工作区，开终端以外的东西（浏览器等），关掉最后一个终端，超过 5 个终端，访问别的窗口和分享目录以外的文件，收通知；以半角 `!` 开头的消息；Ctrl-G、Ctrl-V、Ctrl-Z、Ctrl-R、Ctrl-Y、Option-Y 和 ⌘ 快捷键（原因见下文）。

## 取回和发送文件

- 访客的 Panecast 在输入框上方列出分享目录里最近改动的文件，刚改过的带绿点；「文件」按钮打开完整列表。
- 点一个文件，这台电脑把它传到文件中转服务器（nzx2），访客拿到 1 小时内有效的下载链接，用自己设备上的应用打开。Mac 桌面版把文件下载到「下载/Panecast」后直接用默认应用（WPS、预览）打开；脚本、网页、安装包等只在 Finder 里显示，不直接打开。列表里也可以「复制链接」发给别人。
- 访客把文件拖进或粘贴到输入框，文件存进分享目录，同名时自动编号，不覆盖已有文件；没有大小限制（分块上传，每块 4 MiB，旧版客户端单个最多 12 MB）。上传完成前的分块放在 `~/.cmuxremote/hub/shares/<编号>/uploads/`，不会出现在分享目录里；没传完的分块 24 小时后清理。文件名里的半角 `!` 会换成全角。
- 只能取回分享目录里的普通文件，单个最大 50 MB。隐藏文件夹（`.git`、`.claude`）、指向目录外的链接、有多个硬链接的文件都会被拒绝：这些可能是 Claude 被人指挥着放进来、指向你其他文件的。
- 需要 broker 开启文件链接（`/v1/health` 里 `file_links: true`，见 `broker/README.md`）。

## 安全设计

一共四层，任何一层出问题都不会退化成完整权限：

1. **broker**：访客密钥由网关用自己的 relay 令牌申请，单独存放在 `guests.json`，不进 `devices.json`；broker 回滚到旧版后这些密钥直接失效。连接只会转给在连接时声明支持访客的网关，所以退回旧版 relay 时访客会被拒绝。访客不能注册推送。
2. **网关**：每个请求都重新核对分享记录，只放行上面列出的操作。读不到或解析不了分享记录时，拒绝所有访客。
3. **输入过滤**：只拦会越出这个窗口的输入，在 Claude Code 2.1.326 上逐项实测过：
   - 半角 `!`：在空的输入框里打出 `!`、粘贴以 `!` 开头的内容、用方向键上调出以 `!` 开头的历史、用 Ctrl-Y 把删掉的 `!…` 放回空输入框，Claude 都会进入 shell 模式，命令**不经过沙箱**直接在这台电脑上执行。对策：
     - 网关不知道输入框此刻是不是空的（菜单会吃掉前面的字，数字 1 会直接选中菜单项），所以逐字输入的 `!` 一律换成全角 `！`；整句发送走粘贴，粘贴是整体到达的，只改开头的 `!`。
     - 把已有文字编辑成以 `!` 开头不会进入 shell 模式，但这样的消息发出去会留在历史里，以后用方向键上调出来就是 shell 模式。所以窗口的 Claude 带一个 `UserPromptSubmit` 钩子（`share.mjs` 的 `PROMPT_HOOK`），拒绝以半角 `!` 开头的消息；被拒绝的消息不进历史，Claude 忙的时候排队的消息也一样。有了这个钩子才放开退格等删字键；钩子要在 Claude 启动时就在设置里（改设置文件不会对运行中的 Claude 生效），所以旧窗口要 `reopen`。
     - Ctrl-Y、Option-Y 拒绝。
   - Ctrl-R 搜索的是这台电脑上**所有项目**的输入历史，会把你在别处输入的内容给访客看，拒绝。方向键上只调出这个目录的历史。
   - Ctrl-G 会用 `$EDITOR` 打开输入框，编辑器在沙箱外运行（vim 的 `:!` 就是完整的 shell）；Ctrl-V 会读取这台电脑剪贴板里的图片；Ctrl-Z 会挂起 Claude，窗口卡死；⌘ 快捷键由电脑上的 cmux 处理（粘贴这台电脑的剪贴板、关闭标签页）。这些不论加不加其他修饰键都拒绝。
   - 实测过不会进入 shell 模式的：编辑成以 `!` 开头、Ctrl-S 暂存再恢复、Ctrl-_ 撤销。
   - 文字里的控制字符（除了 Tab、换行、回车）：转义序列可以拼出任何按键，包括 Ctrl-G，也能提前结束粘贴。
   - 以 `/` 开头的文字照常发送：窗口里的 Claude 关闭了所有斜杠命令，`/hooks`、`/login` 只会显示「No commands match」。
4. **Claude 本身**：启动参数是 `claude --restricted --disable-slash-commands --strict-mcp-config --permission-mode acceptEdits`。
   - `--restricted` 不读你个人和项目的设置，文件工具只能访问这个目录，并且拒绝 bypass。
   - 所有斜杠命令（包括 `/add-dir`、`/cd`、`/hooks`、`/login`）都被禁用。
   - Bash 在 Claude Code 的系统沙箱里运行：只能写这个目录和临时目录，读不到主目录下的其他文件，默认没有网络，也关闭了绕过沙箱重试的逃生口。
   - 这些设置文件放在 `~/.cmuxremote/hub/shares/<编号>/`，在分享目录之外，访客改不到。

## 已知限制

- 目录里的所有文件访客都能读、能改。不要在里面放密钥。访客写进来的文件也要当作不可信：在这个目录里自己运行 `git`、`npm`、编辑器任务之前，先检查内容。Claude 的写文件工具被禁止改 `.git`、`.claude`、`.vscode` 和 `.mcp.json`，沙箱也保护 `.git/hooks`。
- 下载链接在 1 小时内谁拿到都能下载；文件在中转服务器上保存 2 小时。
- 访客发的任务用的是你的 Claude 额度。
- 方向键上能调出这个目录里的历史输入。不要自己在分享窗口里输入命令，尤其不要在里面用 `!` 运行 shell 命令：访客调出这条历史就能在沙箱外再运行一次。
- 输入过滤按已知的快捷键逐项拦截。Claude Code 以后新增会在沙箱外运行程序的快捷键时，要同步加进 `relay-tmux/src/hub/guest-session.mjs`。
- 一个窗口同一时间只处理一条消息，多位访客的消息会排队。
- 沙箱对钥匙串、本机 socket（cmux、tmux）、AppleScript 和 launchd 的隔离还没有逐项实测。
