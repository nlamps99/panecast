# Mac 桌面版 0.2.1 安装发布

## 问题与原因

用户下载安装 0.2.0 后，macOS 提示应用已损坏或移到废纸篓。重新下载线上 ZIP，SHA-256
与发布清单一致，解包后通过 `codesign --verify --deep --strict`；`spctl --assess --type execute`
仍拒绝运行。应用签名为 ad hoc，没有 TeamIdentifier，也未经过 Apple 公证。本机构建环境
没有 Developer ID Application 或 Developer ID Installer 签名身份。

本次补齐安装载体与引导；DMG 本身不能代替受信任签名。正式消除此类首次打开提示仍需
Developer ID Application 签名及 Apple 公证。说明中先提供系统「仍要打开」入口，再给
官方来源应用的签名完整性校验与限定到该应用的隔离标记处理命令。明确恶意软件警告不适用。

参考：[Apple 打开 Mac App](https://support.apple.com/zh-cn/102445)、
[Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)。

## 安装方式

- DMG 内包含 Panecast.app、指向 /Applications 的链接，以及离线 HTML 和 TXT 中文说明。
- 下载页与 `/panecast/mac-install.html` 说明如何打开终端、粘贴命令，以及处理首次打开提示。
- `install-desktop.sh` 提供桌面客户端安装，与电脑网关的 `install.sh` 分开。
- 版本化脚本固定下载 ZIP 的 SHA-256，验证 bundle ID、版本与签名完整性后，先在目标
  文件系统准备安装副本，再替换应用。只清除这份验证通过的应用的 quarantine 属性，不修改
  系统 Gatekeeper 设置，也不运行 sudo 或自动打开应用。
- 无系统应用目录写权限时使用个人 Applications；升级保留旧应用备份，替换失败恢复原应用。
  账号与配对保存在应用包外。运行中的应用、同名其他应用和符号链接目标不会被替换。
- 脚本完整解析后才执行安装，避免 curl 响应截断时执行部分替换流程。

## 验证

Tauri release 构建、DMG 容器校验、ZIP 完整性、codesign 深度严格检查、arm64 架构与
macOS 13 最低版本通过。DMG 只读挂载确认两个安装说明与源文件一致，Applications 链接正确。
HTML 的 ID、复制目标与 JavaScript 语法检查通过；桌面 JS 桥接的 4 项既有测试通过。
未操作图形界面或浏览器。

`cd desktop && npm run verify:installer` 使用真实发布 ZIP、本地 HTTP 服务和临时应用目录：

- 带空格路径的首次安装，版本、签名与隔离属性检查。
- 从测试旧版升级，旧应用保持有效签名并保存在备份目录。
- 损坏下载被拒绝，已有应用和目录内容不变。
- 同名其他应用与符号链接在下载前被保留。
- 用临时 bundle 内的 `/bin/sleep` 检测运行状态，包括 `/var` 与 `/private/var` 路径别名；不启动实际 GUI。
- 模拟最终重命名失败，原应用恢复，临时安装目录清除。
- 截断安装脚本不会开始创建安装目录。

发布流程共用三种桌面产物的校验与复制代码。不可变 DMG、ZIP、版本化脚本先上传，随后
替换可变安装入口、页面和元数据。桌面独立发布继续保留手机与 CLI 清单及历史文件。
用临时发布目录执行实际远端发布代码，确认产物先于元数据上线，且损坏上传、版本化脚本
覆盖和并发手机版本变动均会停止发布并保留原清单；旧版下载与校验记录保持可用。

## 产物

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| panecast-desktop-0.2.1-mac-arm64.dmg | 3,615,200 | 8868f2c542cf2cc9b30bf91d5f0d239341a096c428ce0c2ed5f2c8d997ca1185 |
| panecast-desktop-0.2.1-mac-arm64.zip | 3,366,986 | 9e594c0e805db57517d5af42903c45ecabffea1f6c1a685d7a8d637e63bb6dbf |
| install-desktop-0.2.1-mac-arm64.sh | 5,630 | fdc424fbbfb5a51aa568f4a46dbcce5a636566a661383afd438dd3c8cbd540b8 |

适用 macOS 13+ / Apple Silicon。包内应用仍是未公证预览版。

## 发布记录

实现提交 `e027e83` 已推送到现有 main，并通过桌面独立发布流程上线到
<https://ningzx.cn/panecast/>。公网重新下载 DMG、ZIP 和版本化脚本，大小及 SHA-256 与上表
一致；每个校验文件与总清单一致，可变 `install-desktop.sh` 与版本化脚本完全一致。
首页、样式、脚本和安装说明与本次源文件一致，`releases.json` 返回 `Cache-Control: no-cache`。

直接执行公网下载的安装脚本，从正式 HTTPS 地址下载 ZIP 并安装到临时 Applications 目录，
版本、签名与隔离属性检查通过，没有打开应用。公网 DMG 只读挂载后，应用签名、arm64 架构、
Applications 链接及两份离线说明再次确认通过。测试目录与挂载均已清理。

发布前后除 desktop 外的线上元数据完全一致，Android build 13 与 CLI 0.1.1 保留；两个 broker
容器均为 running，本次未修改或重启。发布暂存目录为
`/tmp/panecast-publish-c3ca71624a0f4d13832cc5cc54becea4`，线上校验记录在忽略的
`build/evidence/desktop-0.2.1/`。
