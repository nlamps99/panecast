# 账号与桌面客户端

桌面端复用手机客户端。0.2.0 起通过 Tauri 2 / Rust 桥接处理系统凭据、认证 HTTP/WebSocket、
剪贴板和确认弹窗，Mac 使用系统 WKWebView。相同的终端 / Codex / 文件协议用于两个平台，
不新增屏幕共享或系统鼠标控制。0.1.0 的 Electron 实现已由 Rust 桌面层替换。

## 账号契约

账号属于所选择的 broker。用户名为 3–64 位字母、数字、点、下划线或短横线，转为小写；
密码为 12–256 个字符。账号不依赖邮件或外部身份服务。

| 接口 | 行为 |
|---|---|
| `POST /v1/account/register` | 注册并签发登录令牌 |
| `POST /v1/account/login` | 登录并签发独立会话 |
| `GET /v1/account/me` | 读取当前账号 |
| `POST /v1/account/logout` | 撤销当前会话并关闭相应连接 |
| `POST /v1/account/password` | 验证旧密码，修改密码并撤销其他会话 |
| `DELETE /v1/account/me` | 验证密码后删除账号、会话和绑定关系 |
| `GET /v1/account/computers` | 返回有权访问的电脑及在线状态 |
| `POST /v1/account/relays` | 为当前账号分配一台新电脑：返回 `relay_id`、`relay_token`、`pairing_code`（仅此一次），并自动绑定 |
| `POST /v1/account/computers` | 使用配对码或旧设备令牌证明访问权限，绑定电脑 |
| `PATCH /v1/account/computers?relay_id=…` | 修改该账号中的电脑名称 |
| `DELETE /v1/account/computers?relay_id=…` | 解除绑定，关闭该账号到此电脑的所有连接 |

注册 / 登录参数为 `username`、`password`、`device_name`；响应为 `user`、`token`、
`expires_at`。其他接口使用 Bearer 令牌。绑定参数为 `relay_id`、`name`（可选）及
`pairing_code` 或 `device_token`。账号令牌只对该账号已绑定的 relay 有效。

自动分配的电脑记录在 `accounts.json` 的 `relays` 中，只存 relay token 和配对码的 SHA-256，
归属创建它的账号。分配者解除绑定或删除账号时，这台电脑连同其他账号对它的绑定一起删除，
隧道与手机连接立即关闭；其他账号解除绑定只移除自己的绑定。静态配置的 relay ID 优先，
不会被分配。每个账号最多 20 台，`CMUX_RELAY_ENROLLMENT=0` 关闭分配；此时 broker
仍需至少一个静态 relay。

服务端在与 `devices.json` 同目录的 `accounts.json` 保存 scrypt 密码摘要、登录令牌的
SHA-256 和电脑绑定关系。登录会话有效期 30 天，不保存明文密码或配对码。
写入串行化并原子替换，文件权限 0600。登录接口有每 IP 和总量限速。
每个会话、每台电脑都有独立的设备 ID，沿用现有 relay 的会话和通知同步机制。

客户端的账号令牌放入安全存储。登录后取回电脑列表，保持已有电脑的本机 ID，
退出或认证失效时关闭账号连接、删除本机账号凭据并清理相应输入和收件箱记录。
服务器撤销会话或绑定会主动关闭连接；会话自然过期由定期同步在 15 秒内关闭。
普通扫码配对与账号独立，删除账号不会删除其他客户端的原有配对。

## 发布与限制

此次不需要修改现有 relay、数据库卷或私有配置。升级 broker 镜像即可增加账号 API，
原手机客户端可继续使用原协议。客户端账号界面需要新构建；现有 Android build 13
没有账号入口。构建当前 APK 需要原发布签名密钥，不可新建密钥替代。

Mac 构建输出 Apple Silicon 的本地签名预览包，尚未经过 Apple 公证。Windows / Linux
安装包、账号找回、第三方登录、桌面后台系统推送和自动更新不在本次实现中。
网页演示不保存真实凭据，真实连接由手机与桌面 App 提供。

验证覆盖账号隔离、配对权限证明、跨会话设备发现、即时撤销、密码修改、账号删除、
过期与重启持久化、客户端退出与刷新竞态、桌面 socket 生命周期和加密凭据存储。
遵循用户的浏览器控制规则，本次通过代码、构建和自动化测试检查，没有操作浏览器页面。

## 构建验证记录

2026-11-09，基于 main 的手机 build 13 与网关 0.1.1 完成集成。客户端 54 个测试套件、
622 项测试通过，TypeScript、Expo lint 和 Expo Doctor（20/20）通过。Broker 24 项
测试通过，7 项依赖 tmux 的历史故障测试因本机未安装 tmux 而跳过；桌面桥接与加密
存储的 2 项 Node 测试通过。Mac 应用完成打包、图标一致性与 codesign 深度校验。
独立桌面发布流程验证了保留已有 APK、CLI、校验清单和最新 APK 链接。

当前机器缺少原 Android 发布签名密钥，因此保留下载站的 build 13，不生成无法
覆盖安装的新签名 APK。手机账号入口随下一次使用原密钥的构建发布。

## 上线验证记录

实现提交 `101986c` 已推送至现有 main。两个既有 broker 均完成镜像更新，原私有配置
和两个数据卷已备份，旧 `devices.json` 在升级前后保持逐字节一致。容器重建引起 IP
互换，已用账号认证确认 nginx 缓存旧上游地址的根因，校验配置并平滑 reload 后恢复。

通过公网 HTTPS/WSS 验证了注册、两次独立登录发现相同电脑、读取真实在线电脑的
工作区、退出一个会话后立即关闭相应连接，以及另一会话继续有效。临时测试账号
均在检查后删除。原本离线的备用电脑仍离线，其 broker 服务正常。

下载站已增加 macOS 13+ Apple Silicon 的桌面 0.1.0 预览包，保留 Android build 13
和 CLI 0.1.1。ZIP 使用本地签名，未经过 Apple 公证。图形界面交互未做实机操作检查。

公网重新下载的 ZIP 与构建产物 SHA-256 一致：
`090ecfea69eca6efab4356a9bced31bbcc55a9aed33051cecefb910ee2bddc7a`。

## 自动分配电脑凭据上线记录

实现提交 `ff19c5c` 已推送 main。两个 broker 入口（`/cmux-remote`、`/cmux-remote-air`）于
2026-11-11 重建为新镜像，对任何账号开放自动分配（未设置 `CMUX_RELAY_ENROLLMENT`）。部署前备份
源码、镜像和两个数据卷；部署后两边 `devices.json` 与备份逐字节一致，`accounts.json` 除新增空的
`relays` 外不变。重建后执行 `nginx -t` 并平滑 reload，核对两个上游主机名与容器 IP 对应，
主入口的现有 relay 自动重连在线。

公网两入口分别用真实 `panecast setup` 注册临时账号验证：自动分配凭据、隧道连接与错误令牌
拒绝、同账号另一登录看到电脑在线并建立会话、`pair` 免输入配对码及扫码登记、删除账号后
隧道以 4003 关闭且凭据失效、setup 的临时登录已退出。临时账号、电脑与登记设备均已删除；
首次脚本错误留下的一个临时账号在短暂停止主 broker 后从数据文件移除，删除前已备份。

CLI 0.1.4 与安装脚本发布到下载站。公网 `releases.json`、`install.sh`、CLI 包、`SHA256SUMS`
与首页和构建产物一致，0.1.3 保留可下载，Homebrew tap 指向 `762f1f2`。用公网安装脚本在临时
目录安装得到 0.1.4，安装内容与仓库一致。已有网关配置不受影响，升级后运行 `panecast restart`。

## 网关来源全部权限上线记录

实现提交 `47fcb5e` 已推送 main，CI 在 macOS 与 Ubuntu（含真实 tmux）全部通过。网关不再区分
授权与只读：配置中的每个来源都拥有全部权限，旧配置的 `enabled`、`access` 字段被忽略，Codex
`history` 模式按 `managed` 处理。`serve` 与 `setup` 自动接入 tmux、Codex、已准备的桌面桥接，
并通过本机局域网 IP 向 cmux relay 自动登记设备。已在本机真实 cmux relay 上验证自动登记与
loopback 连接读取工作区，测试设备随后撤销。

CLI 0.1.5 已发布：公网 `releases.json`、`install.sh`、CLI 包、`SHA256SUMS` 与首页和构建产物一致，
0.1.4 保留可下载，Homebrew tap 指向 `6490e72`，公网安装脚本在临时目录装得 0.1.5。broker 未改动。
