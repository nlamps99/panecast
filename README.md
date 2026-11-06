[English](README.en.md) · 简体中文

# Panecast

在手机上查看和操作电脑上的终端。

> **早期阶段。** Panecast 由 [cmux Remote](https://github.com/NewTurn2017/cmux-remote)
> 演变而来，支持 [cmux](https://github.com/manaflow-ai/cmux) 和 tmux。
> 手机端使用 Expo，iOS、Android 和网页演示共用一套代码。

## 工作方式

Panecast 由三部分组成：

- **relay**：跑在终端所在的电脑上，读取终端画面、转发按键。目前是 macOS 上的
  Swift 守护进程，通过 cmux 的 JSON-RPC socket 工作；tmux 使用独立的 Node relay，支持 macOS 和 Linux。
- **broker**（可选）：部署在你自己的 VPS 上。手机和电脑都主动连接它，电脑不用
  开放入站端口。broker 能看到中转的终端内容：连接有 TLS 保护，但不是端到端加密。
- **client**：手机 App，用 Expo（React Native）写。

手机和电脑在同一个局域网或 Tailscale 网络里时直接连 relay；在外面时经过
broker 中转。

## 目录

| 目录 | 内容 |
|---|---|
| `client/` | Expo 手机 App |
| `relay/` | Mac relay（Swift） |
| `relay-tmux/` | tmux relay 与 cmux / tmux / Codex 统一网关（Node） |
| `broker/` | VPS broker（Node） |
| `docs/specs/` | 协议设计和 cmux 返回数据样例 |
| `legacy/` | 原 cmux Remote 的原生 iOS / Android 客户端和旧文档，新 App 功能追平后删除 |

## 快速开始

**[下载与安装 Panecast](https://ningzx.cn/panecast/)**：Android APK、Mac 一键安装、Homebrew 和 npm 安装入口及版本记录。

Mac 推荐使用 Homebrew：

```sh
brew tap panecast/tap https://ningzx.cn/panecast/homebrew-tap.git
brew install panecast/tap/panecast
panecast setup
panecast start
panecast pair
```

让其他人从自己的 Mac 接入，见 [Mac 接入指南](docs/MAC-SETUP.md)。
Android APK 构建和发布见 [Android 说明](client/ANDROID.md)。

仅 cmux 原生 relay 需要 macOS 和 Swift 5.10+，并且要在 cmux 里的终端中安装：

```bash
cd relay
./scripts/install-launchd.sh
```

broker 的部署见 [`broker/README.md`](broker/README.md)。
tmux 的安装与配对见 [`relay-tmux/README.md`](relay-tmux/README.md)。

同时管理 cmux、tmux 和 Codex：使用[统一网关](relay-tmux/HUB.md)，在电脑端授权来源，
手机配对一次后从「来源」集中查看。Codex 支持历史读取和 App Server 会话操作；
能否接管现有桌面会话取决于该 App Server 是否开放可连接的接口。

手机端支持按终端保存草稿、发送结果反馈、常用输入与历史、直接发送 Ctrl + ↑、
输出搜索与跨行复制、待处理收件箱与稍后提醒、项目文件预览/保存、Git 差异和连接自检。
新功能的服务端升级要求与限制见[功能说明](docs/specs/2026-11-04-mobile-workflow.md)。
会话恢复、全屏长文本、自定义快捷键、宽屏侧栏及多电脑配置见
[连续使用与输入](docs/specs/2026-11-04-continuity-and-input.md)；通知补齐和免打扰规则见
[通知恢复说明](docs/specs/2026-11-04-notification-recovery.md)。

client：

```bash
cd client
npm install
npm run ios
```

relay 的完整配置（`relay.json`、Tailscale 直连、局域网配对、问题排查）暂时还在
[`legacy/README.cmux-remote.md`](legacy/README.cmux-remote.md) 里。

## 路线图

- [x] 拆分仓库，搭好 Expo 骨架
- [x] 原型：终端页、输入（含中文输入法）、broker 扫码配对
- [x] 工作区和 surface、多台电脑、局域网和 broker 自动切换、
      Inbox 和推送、图片附件、演示模式
- [x] tmux 后端（macOS / Linux，Node）
- [x] 手机工作流：草稿、常用输入、搜索复制、待处理状态、项目结果与诊断
- [x] Android 发布 APK：[下载最新版](https://ningzx.cn/static/panecast/panecast-latest.apk)
- [ ] 上架 App Store，之后的小改动走 OTA 更新

## 来源与许可

Panecast 源自 [NewTurn2017/cmux-remote](https://github.com/NewTurn2017/cmux-remote)，
保留了完整的提交历史。采用 MIT 许可，见 [`LICENSE`](LICENSE)。

本项目是社区作品，与 Manaflow 和 cmux 官方无关。
