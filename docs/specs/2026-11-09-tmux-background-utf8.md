# tmux 后台服务的 UTF-8 输出契约

## 问题与根因

通过 macOS LaunchAgent 运行网关时，进程可能没有 LANG、LC_ALL 或 LC_CTYPE。
tmux 客户端在非 UTF-8 环境中转换输出，把格式中的制表符及中文替换为下划线。
网关按制表符解析 list-sessions 和 list-panes，转换后整行被当作终端 ID，
后续输入请求因 ID 不是 `%数字` 而被拒绝，画面及标题也会损坏。

在真实 tmux 3.8 的隔离 socket 上，LC_ALL=C 时格式中的两个制表符变成下划线；
LC_ALL=en_US.UTF-8 或全局参数 `-u` 均保留两个制表符。列表命令的 `-r` 不解决
这个客户端编码问题。原服务的 LaunchAgent 确认没有设置这三个 locale 变量。

## 修复

所有 TmuxBackend 调用显式添加 tmux 全局参数 `-u`，让 tmux 输出 UTF-8，
与网关的 UTF-8 解码和字段协议一致。该设置同时覆盖列表、捕获画面和项目路径。
不修改用户的 shell 环境、tmux 配置、现有来源权限或终端 ID 校验。

## 验证

在 macOS arm64、tmux 3.8、Node 23.11.0 上使用独立测试 socket 执行：

- tmux 和 hub 定向测试共 16 项通过。
- 完整网关测试共 91 项，90 项通过；1 项会操作真实 Codex 运行任务的测试按原设定跳过。
- 新回归用例把三个 locale 变量都设为 C，检查中文工作区名称、终端 ID、尺寸、
  光标、中文标题和程序实际输出。用 raw stdin 接收器核对中文、制表符、换行及回车
  的原始字节，避免把 shell 回显误认为输入成功。

网关包升级为 0.1.2；桌面客户端保持 0.2.2。部署到已有开发 checkout 时只更新
经过哈希核对的 tmux 后端文件，备份旧文件，保留该机器其他未提交修改和私有配置。

## 发布与跨电脑验证

实现提交 `b288444` 已推送现有 main。0.1.2 已发布至
<https://ningzx.cn/panecast/>，CLI 包 SHA-256 为
`118ffcfffa4331f7378f9b76b336ad0af90ee57736af49b3ca5e4db6b326352b`。
安装器首次安装及重复安装、npm 离线安装、已安装源文件比对、Homebrew Formula
语法检查通过。公网下载的 CLI、安装脚本、校验清单及页面与构建产物一致；
Homebrew tap 指向 `eccaf1d`，元数据保持 no-cache，两个 broker 容器健康。
桌面 0.2.2 和 Android build 13 保持原发布内容。

目标 Mac 的桌面 0.2.2 签名验证通过；网关应用上述单文件修复并重启后运行正常。
部署前后核对原有 14 个修改文件及网关配置的哈希，均未改变。使用为本机登记的
设备凭据完成 HTTPS/WSS 连接，在远端独立临时 tmux 工作区执行唯一标记输出及
`uname -m`，精确读回标记和 arm64，随后删除测试工作区。cmux、tmux、Codex
历史、Codex 桌面会话四个来源均在线，原有工作区未改动。

配对记录写入本机 AES-256-GCM 加密存储，钥匙保存在系统 Keychain；重启已安装
的 Panecast 后观察到应用与 broker 建立连接。临时明文凭据、导入辅助程序、隔离
测试目录及 SSH 控制连接均已清理，没有执行界面点击或操作用户的 Codex 任务。
不含凭据的验证记录保存在忽略目录 `build/evidence/macpro-setup-20261109/`。
发布回滚暂存目录为 `/tmp/panecast-publish-ed91e4ced5094221b69d48c5f5582810`。
