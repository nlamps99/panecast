# Mac 安装与连接

统一下载与更新入口：**https://ningzx.cn/panecast/**。

每台 Mac 运行自己的 Panecast hub，公网 broker 负责中转。一台 hub 可以接入
tmux、cmux 和 Codex。当前手机端需要先通过 broker 登记，因此首次接入仍需管理员
为这台电脑分配独立的电脑 ID、连接密钥和手机配对码。

## Homebrew（推荐）

```sh
brew tap panecast/tap https://ningzx.cn/panecast/homebrew-tap.git
brew install panecast/tap/panecast
```

Formula 会安装 Node.js 22 和 tmux，不需要下载项目源码或编译 Swift。
这是自托管的 Homebrew tap，可正常使用 brew update、brew upgrade 和 brew uninstall。

## 一条命令安装

```sh
curl -fsSL https://ningzx.cn/panecast/install.sh | bash
```

支持 Apple Silicon 与 Intel Mac，自带独立 Node.js 运行时，不需要 sudo。
程序安装在 `~/.local/share/panecast/`，命令在 `~/.local/bin/panecast`，安装器会
将命令目录加入 shell 登录配置。当前终端直接使用 `~/.local/bin/panecast`，或新开终端。
使用 tmux 来源仍需安装 tmux；Homebrew 安装方式会一并处理这个依赖。

Node.js 22+ 用户也可以使用下载页中的 `npm install -g <版本包 URL>`，安装到 npm
管理的全局命令目录。包内包含运行依赖，无需克隆项目或配置私有 npm registry。

## 首次配置、启动与配对

```sh
panecast setup
panecast start
panecast pair
```

setup 引导填写 broker 地址、独立电脑 ID 和连接密钥，并选择授权的来源。
已有 `~/.cmuxremote/hub-relay.json` 时保留配置，不重置权限或配对。密钥输入不回显，
配置文件权限为 600。pair 提示输入手机配对码，二维码只显示在本机终端。
选择可信 Wi-Fi 直连时生成独立的 LAN 配对码，配对时自动探测物理网卡地址。

start 使用用户级 LaunchAgent，登录后自动运行。关闭终端不停止后台 hub。
tmux 工作需要在 tmux 会话中启动，例如 `tmux new -s work`，然后从手机工作区访问。
其他来源的配置见 [统一网关指南](../relay-tmux/HUB.md)。

批量配置可通过文件传入连接密钥，避免出现在命令参数中：

```sh
panecast setup --broker-url https://relay.example.com --relay-id my-mac --token-file /private/path/relay-token --source tmux
```

其他来源可运行 `panecast sources list`、`panecast sources grant tmux --access control`
或 `panecast sources revoke tmux`。cmux 仍需安装本地 Swift relay；仅 tmux 不需要 Swift。

## 管理、更新与卸载

```sh
panecast status
panecast logs
panecast restart
panecast stop
```

Homebrew 升级：`brew update`，然后 `brew upgrade panecast/tap/panecast`。
独立安装器升级：重新运行相同安装命令。npm 升级：使用下载页中的最新版本安装 URL。
升级后执行 `panecast restart`，使常驻服务使用新版本。

卸载前先执行 `panecast stop`。Homebrew 使用 `brew uninstall panecast`；npm 使用
`npm uninstall -g panecast-cli`。独立安装器可运行：

```sh
curl -fsSL https://ningzx.cn/panecast/install.sh | bash -s -- --uninstall
```

这些操作保留 `~/.cmuxremote/` 中的配置和设备数据；重新安装后可继续使用。
安装器添加的 PATH 行可以保留，也可以从 .zprofile / .bash_profile 中移除。

服务标签为 `com.nzx.panecast.hub`，不操作原 cmux 服务的 `com.genie.cmuxremote`。
同一个配置不要同时用多个进程管理器启动。日志位于配置目录下的 hub-log/。

管理员增加新电脑的操作见 [broker 多电脑配置](../broker/README.md#一个域名连接多台电脑)。
当前凭据分配还需要管理员操作，不是开放的自助注册服务。
