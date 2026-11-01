[English](README.en.md) · 简体中文

# Panecast

在手机上查看和操作电脑上的终端。

> **早期阶段。** Panecast 由 [cmux Remote](https://github.com/NewTurn2017/cmux-remote)
> 演变而来，目前终端后端只支持 [cmux](https://github.com/manaflow-ai/cmux)。
> 手机端正在用 Expo 重写，iOS、Android 和网页共用一套代码。

## 工作方式

Panecast 由三部分组成：

- **relay**：跑在终端所在的电脑上，读取终端画面、转发按键。目前是 macOS 上的
  Swift 守护进程，通过 cmux 的 JSON-RPC socket 工作。
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
| `broker/` | VPS broker（Node） |
| `docs/specs/` | 协议设计和 cmux 返回数据样例 |
| `legacy/` | 原 cmux Remote 的原生 iOS / Android 客户端和旧文档，新 App 功能追平后删除 |

## 快速开始

relay 需要 macOS 和 Swift 5.10+，并且要在 cmux 里的终端中安装：

```bash
cd relay
./scripts/install-launchd.sh
```

broker 的部署见 [`broker/README.md`](broker/README.md)。

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
- [ ] 原型：终端页、输入（含中文输入法）、broker 扫码配对
- [ ] 追平原生版功能：工作区和 surface、多台电脑、局域网和 broker 自动切换、
      Inbox 和推送、图片附件、演示模式
- [ ] 支持 cmux 以外的终端后端，比如 tmux
- [ ] 上架 App Store，Android 发布 APK，之后的小改动走 OTA 更新

## 来源与许可

Panecast 源自 [NewTurn2017/cmux-remote](https://github.com/NewTurn2017/cmux-remote)，
保留了完整的提交历史。采用 MIT 许可，见 [`LICENSE`](LICENSE)。

本项目是社区作品，与 Manaflow 和 cmux 官方无关。
