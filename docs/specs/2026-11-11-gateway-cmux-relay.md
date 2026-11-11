# 网关自带 cmux relay

## 问题

按下载页安装 Panecast 的电脑，手机能连上网关，却始终看不到 cmux。2026-11-11 一台用账号
自动分配凭据的 Mac（cmux DR2 + CLI 0.1.5）上，broker 与 nginx 日志显示手机 WebSocket 均返回
101、网关在线，问题在网关到 cmux 这一段：

1. 网关不直接连 cmux，只向已安装、开启局域网配对的 Swift relay 登记。下载页和安装器从不安装
   relay，所以 0.1.5 及更早的公开安装都没有 cmux 来源。
2. cmux DR2 的 bundle ID 是 `com.cmuxterm.app.debug.dr2.selfhost`，cmux 视为带标签开发版：
   socket 在 `/tmp/cmux-debug-dr2-selfhost.sock`，标记文件为
   `/tmp/cmux-dev-dr2-selfhost-last-socket-path`。relay 只认官方版标记，找不到它。
3. cmux 默认「仅限 cmux 进程」，只接受自己终端里启动的进程或其签发的能力令牌。launchd 启动的
   relay 两者都不是。开发版身份每次启动都换能力令牌的密钥，保存的令牌在 DR2 重启后失效。

## 设计

- CLI 包在 `vendor/darwin/cmux-relay` 附带通用（arm64 + x86_64）、去符号、ad-hoc 签名的 relay，
  macOS 13+。`distribution/build.mjs` 构建并校验。
- 本机有 cmux（应用或任何版本的 socket 标记）且没有可用 relay 时，网关在配置目录的
  `cmux-gateway/` 写入只监听 `127.0.0.1` 的 relay 配置（4401 起找空闲端口，不开配对路由），
  用新命令 `cmux-relay devices add --state-dir` 发凭据，来源带 `managed` 与 `state_dir`。
  `ManagedCmuxRelay` 随网关启停，退避重启，清理异常退出留下的进程。relay 的 `--state-dir`
  让设备库与已安装 relay 的 `~/.cmuxremote/devices.json` 分开，避免互相覆盖。
- relay 在官方标记之后按修改时间查找 nightly、RC、staging、带标签开发版的标记。0.1.7 起优先选
  有进程监听的 socket，官方版异常退出留下的 socket 文件不会挡住正在运行的 DR2。
- 授权：在 cmux 终端运行 `panecast setup/start/restart/serve` 时保存 `CMUX_SOCKET_CAPABILITY`
  到 `cmux-gateway/socket-control-capability`（0600），relay 通过 `CMUX_SOCKET_CAPABILITY_FILE`
  使用；不把启动终端的能力或 socket 变量传给 relay。cmux 拒绝或未运行时，来源页给出可操作的
  中文说明。DR2 r2 对 `*.selfhost` 包默认「自动化模式」（只接受同一 macOS 用户的进程），用户
  选过的模式不变。

## CLI 0.1.6 上线记录

源码提交 `11b0cd8`（分支 `cmux-gateway-autoconnect`）。包 `panecast-cli-0.1.6.tgz`，10,928,998
字节，SHA-256 `a1512ffe2876ebb185d1eee64f5ff1fc3eb9ee6e6ee06cdac0a83ab8f9544e04`；内含 relay
SHA-256 `1ad5ae565927e0ee1981f5a2cf2f080cf3b43473555cc211e696fa4d4037b78b`。Homebrew tap
`c77edd4`，从线上 tap `6490e72` 快进。

验证：网关 104 项测试通过（2 项可选跳过），Swift relay 全部通过（1 项真实 socket 测试跳过）。
本机真实官方 cmux 上，用隔离配置与临时 HOME、脱离 cmux 进程树的网关：无授权时来源页显示
「cmux 拒绝了网关的连接」；保存授权后在线并经自带 relay 读到工作区；强杀网关后再次启动会清理
遗留 relay；停止网关后 relay 和端口均释放。用本地静态服务器执行安装器得到 0.1.6，并以安装后的
包从零发现、连接 cmux。x86_64 部分在 Rosetta 下可运行。

发布前比对线上页面：仅 `install.sh`、`releases.json`、`SHA256SUMS` 变化，页面文件一致。发布后
公网完整下载 CLI 包核对 SHA-256，安装脚本、`releases.json`、`SHA256SUMS`、tap `info/refs` 均指向
0.1.6，0.1.5 保留可下载；公网安装脚本在临时目录安装得到 0.1.6，relay 签名有效。远程暂存
`/tmp/panecast-publish-65af979339a1414b94e0652a8b45f392` 保留以便回滚。broker 未改动，本机日常
网关和 cmux relay 未重启。

## CLI 0.1.7 与 COS 下载上线记录

源码提交 `b3cc7b7`（每个 cmux 应用各一个来源）及之后的文档提交。包 `panecast-cli-0.1.7.tgz`，SHA-256
`5912d760f044a69c8fc2ec23de3b54bc3575d6427d48b1568680f4f763050e33`，内含 relay SHA-256
`d44fd70315122e55fb682faa404a899f99c6db17d308f25ef183dfbea7f9c09d`。网关 107 项、relay 42 项测试通过；以发布产物
实测正式版与 DR2 r3 同时在线，DR2 退出后显示「没有找到正在运行的 cmux」。

下载改走 COS：ningzx.cn 实测约 0.7 MB/s，COS 约 7.7 MB/s。`distribution/cos.py` 只写 `panecast/` 前缀、对象级
公开读、`x-cos-meta-sha256` 记录 SHA，拒绝以不同内容覆盖；两个发布脚本在更新元数据前先上传并校验。
`releases.json` 与 DR2 `release.json` 的 `downloadBase` 指向 COS，页面、安装脚本、Homebrew 配方与 appcast
使用它；历史版本、页面、校验和与元数据仍在 ningzx.cn。公网安装命令实测 14 秒装好 0.1.7。
