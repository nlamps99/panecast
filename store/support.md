# Panecast 使用与支持

Panecast 让你在 iPhone 和 iPad 上查看和操作 Mac 上的终端。
当前支持的终端后端为 [cmux](https://github.com/manaflow-ai/cmux)。

## 先试用演示

第一次打开应用时，在连接页面点 **“还没有电脑可连？先看看演示”**。
演示不需要账号、Mac 或网络连接，可以体验工作区、终端输入和通知收件箱。

## 连接自己的 Mac

1. 在 Mac 上安装并运行 cmux。
2. 获取 [Panecast 项目](https://github.com/nlamps99/panecast)，按项目 README 中的
   relay 安装说明运行 `relay/scripts/install-launchd.sh`。该步骤需要 macOS 和
   Swift 工具链，并应在 cmux 的终端中执行。
3. 根据你的网络配置 relay。手机与 Mac 在同一网络时可以使用局域网；外网访问可
   配置自行托管的 broker。相关配置见
   [连接与部署说明](https://github.com/nlamps99/panecast/blob/main/legacy/README.cmux-remote.md)
   和 [broker 部署说明](https://github.com/nlamps99/panecast/blob/main/broker/README.md)。
4. 在 Mac 运行 `cmux-relay pair`，用 Panecast 扫描生成的二维码。
5. 选择工作区和终端，开始查看画面、输入命令或发送图片。

Mac 需要保持在线。使用中转服务器时，请选择你信任的运营者；终端内容会经过该服务器，
当前协议不是端到端加密。

## 常见问题

**连不上电脑**

确认 cmux 和 relay 正在运行，手机可以访问配置的局域网地址或 broker。检查 iOS
是否允许 Panecast 使用本地网络。Mac 休眠、relay 停止或服务器不可达都会中断连接。
配对失效时，可在 Mac 重新生成二维码并在 App 中重新配对。

**中文还没输入完就发送了**

Panecast 的输入框会等待输入法组字确认。请确认使用的是当前测试版本，并通过“整行”
和“逐字”模式分别复现；反馈时附上输入法名称、iOS 版本和具体步骤。

**没有后台通知**

前台收件箱在 App 与电脑保持连接时接收通知。iOS 后台推送还需要 relay 配置 APNs、
手机通过局域网登记，并在系统设置中允许通知。只通过中转服务器配对时，后台推送可能
不可用；应用“设置 → 通知”会显示当前状态。

**TestFlight 中没有新版本**

确认你已接受对应邮箱的测试邀请。打开 TestFlight，进入 Panecast 并检查更新。
测试构建有有效期，版本过期后需要安装新的构建。

## 报告问题

请通过 [GitHub Issues](https://github.com/nlamps99/panecast/issues) 提交：

- Panecast 版本、iOS 版本和设备型号；
- 连接方式：局域网、Tailscale 或自托管 broker；
- 可以重复问题的步骤和预期结果；
- 已移除敏感信息的截图或错误文本。

不要公开配对二维码、令牌、服务器密钥或包含私人信息的终端内容。
安全漏洞请使用 [私密漏洞报告](https://github.com/nlamps99/panecast/security/advisories/new)。

[隐私政策](privacy.md) · [项目主页](https://github.com/nlamps99/panecast)
