# cmux DR2 for Windows

cmux 应用本身只支持 macOS。Windows 版使用 manaflow-ai/cmux 仓库里的 cmux TUI（`cmux-tui`，
终端界面版，官方 Windows 构建仍为实验阶段），固定在 `.github/workflows/cmux-dr2-windows.yml`
的 `CMUX_COMMIT`，不做源码修改；和 Node 运行时、Panecast 网关一起打包，手机登录同一账号即可
查看和操作 Windows 电脑上的终端。

## 包内容

`%LOCALAPPDATA%\cmux-dr2\`：

- `bin\cmux-tui.exe`，安装器建立的硬链接 `bin\cmux.exe`
- `bin\cmux-dr2.cmd`：开始菜单入口；网关维持的 `main` 会话在运行时 attach，否则新建交互会话
- `bin\panecast.cmd`：用自带 Node 运行网关，并通过 `PANECAST_CMUX_TUI` 告诉网关 cmux 的位置
- `node\node.exe`（版本与校验值见 `release.json`）、`panecast\`（网关及生产依赖）、`licenses\`

网关发现 `cmux-tui` 后加入来源 `{ type: "cmux-tui", name: "cmux DR2", session: "main", owner: true }`。
`owner` 表示网关在没有窗口时也保持 `cmux-tui server start --session main` 运行。后台服务是
「启动」文件夹里的隐藏 VBScript（`Panecast Gateway.vbs`），登录时运行、退出后 10 秒重启；
本地端点是由状态目录派生的命名管道。

## 构建与发布

1. 修改 `release.json` 的 `version`（以及需要时的 `CMUX_COMMIT`、Node 版本与校验值）。
2. 推送后 `cmux dr2 windows` 工作流在 Windows 上编译 cmux TUI，运行网关的 Windows 测试和
   真实 cmux TUI 集成测试，打包，再用 `smoke.ps1` 按用户方式安装、以服务启动网关、用
   `smoke-client.mjs` 以手机协议配对并在新工作区执行命令、打开 cmux DR2 窗口截图、停止服务，
   最后覆盖安装一次验证升级。
3. 下载该次运行的 `cmux-dr2-windows` 产物到 `build/cmux-windows/`，然后：

```sh
. ~/.config/tencentcloud/credentials.env
python3 distribution/cmux-windows/publish.py --host root@175.178.106.217 \
  --directory /var/lib/docker/volumes/card-note-web_static_vol/_data/panecast \
  --previous-index-sha256 "$(curl -fsS https://ningzx.cn/panecast/cmux/index.html | shasum -a 256 | cut -d' ' -f1)" \
  --notes '更新说明…'
```

ZIP、安装脚本和源码包上传到 COS（安装脚本以 `text/plain; charset=utf-8` 提供，供
`irm … | iex` 使用），随后写入 `cmux/windows.json`、各文件 `.sha256` 和页面文件。Mac 版的
`release.json` 不受影响；Mac 版发布会覆盖页面文件，所以发布 Mac 版前先合并最新 main，
保留页面上的 Windows 区块。

cmux TUI 遵循 GPL-3.0-or-later：每个版本都发布对应源码包（构建提交的 cmux TUI、Ghostty、
构建脚本和本目录的打包脚本）。
