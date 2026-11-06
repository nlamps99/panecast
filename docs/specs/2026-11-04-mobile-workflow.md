# 手机工作流与升级说明

## 手机操作

- 终端主按键栏的 `^↑` 直接发送 `ctrl-up`。原来的 Ctrl 粘滞键仍支持更多组合。
- 命令模式按电脑、工作区、终端保存草稿；切换输入模式或终端后可恢复。
  只有文字和回车都收到响应后才清空。断线或超时会保留原稿并提示确认远端状态，
  不会自动重新执行命令。逐字模式继续实时发送已确认的输入法文字。
- 「常用输入 · 最近输入」支持收藏、编辑、搜索、项目筛选和导入电脑的 snippets。
  点击内容填入命令框，编辑后发送；支持清除最近输入、单条删除和移除电脑时清理。
- 「搜索 · 复制输出」冻结当前画面，搜索已加载的历史，继续加载更早内容，
  查看匹配上下文、跨行选择或复制逻辑行。复制内容去除 ANSI、隐藏文本和补齐空格。
  URL 仅支持 HTTP/HTTPS，在手机浏览器打开；电脑的 localhost 链接不会自动代理。
- 收件箱区分已读与已处理，支持待处理筛选、重新打开和 15 分钟后提醒。
  工作区显示待处理数量。提醒使用系统本机通知，需要通知权限。
- 终端右上角「文件」查看项目目录、文本、图片以及 Git 暂存/未暂存差异，
  可以保存或分享文件。文件路径限定在终端报告的目录内，包括符号链接检查。
  cmux 使用其提供的目录元数据，tmux 使用 `pane_current_path`；界面显示实际读取的根目录。
- 配对页和设置提供安装指南；连接诊断分别检查中转、局域网、身份连接与终端后端，
  可复制不包含凭据的诊断报告。

## 服务端升级

本地草稿、输入收藏、搜索复制和收件箱处理状态可直接用于旧 relay。
导入电脑 snippets、项目文件和详细后端诊断需要新版 relay；旧服务器会提示升级。
新增文件系统/分享原生模块后，需要重新构建手机 App，不能仅通过 OTA 增加原生模块。

仅服务器配对的 iOS 后台推送需要同时升级 broker 和 relay。协议过程：

1. 手机 POST `/v1/devices/me/apns?relay_id=…`，携带自身 bearer 与 APNs token/env。
2. broker 验证设备，通过隧道发送 `push.register`；设备 ID 来自鉴权结果。
3. relay 保存登记后回复 `push.result`。HTTP 成功响应包含
   `{ok:true, forwarded:true, push_enabled:boolean}`；未配置 Apple 密钥/环境时界面显示待配置。
4. 旧 broker 的 204 响应仍兼容，但客户端将其标为旧的仅服务器登记状态。
5. 测试接口 `/v1/devices/me/apns/test` 报告 Apple 是否接收请求，手机实际显示由用户验证。

broker 通过 `push.sync` 每 15 秒续期设备列表。relay 只向最近 45 秒授权仍有效的设备
推送；隧道断开即暂停，重新启动也须先收到授权。原始 APNs token 和签名密钥不落盘到
broker。APNs 内容保持通用提示，仅附带工作区、终端和 relay ID，不携带终端输出。

推送的 topic 应与 App bundle identifier 一致（Panecast 为 `com.nzx.panecast`）；
开发包通常使用 sandbox，TestFlight/App Store 使用 prod。实际投递还依赖有效的 Apple
推送凭据、设备权限及网络。Android 不引入 GMS；被系统终止后仍没有远程推送通道。

## 新增 RPC

| 方法 | 参数 | 结果 |
|---|---|---|
| `relay.snippets` | 无 | `snippets: [{label,text}]` |
| `relay.diagnostics` | 无 | `backend, backend_ready, project_access` |
| `project.list` | `workspace_id, surface_id, path` | `root, path, entries, truncated` |
| `project.read` | 同上 | `name, mime_type, size, data_base64, text?` |
| `project.diff` | `workspace_id, surface_id` | `root, working, staged, truncated` |

项目文件最多 4 MB，文本预览最多 512 KB；手机长文本预览显示前 80,000 个字符。
目录最多 500 项，忽略 `.git`、`node_modules`、`.build`。Git 操作禁用外部 diff 和
textconv，限定当前目录，不执行客户端传来的 shell 命令。Swift relay 对过大的 diff
返回截断标记；tmux relay 对超过限额的 diff 明确报错。

tmux 支持及 agent 通知 hook 的安装说明见 [tmux relay](../../relay-tmux/README.md)。
tmux 不会推断 agent 状态，需由工具 hook 调用 `notify`；处理完成状态由用户在手机标记。

## 验证

```sh
cd client
npm run typecheck
npm run lint
npm test -- --runInBand
npx expo-doctor

cd ../broker
npm test

cd ../relay
swift test

cd ../relay-tmux
npm ci
npm test
```

tmux 测试创建专用服务器和临时会话，验证中文输入、真实 Ctrl + ↑ 字节、历史游标隔离、
文件路径范围和手机 WebSocket 协议；不操作用户日常 tmux 会话。
