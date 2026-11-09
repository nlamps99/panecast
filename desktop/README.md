# Panecast 桌面版

复用手机客户端的终端、工作区、Codex 来源、收件箱、图片附件和项目文件功能。
首个安装包面向 macOS 13+ 的 Apple Silicon 电脑。目标电脑继续运行已有 relay / hub。

## 使用

1. 从 [下载页](https://ningzx.cn/panecast/) 下载 Mac 桌面版，解压并移入「应用程序」。
2. 打开「账号登录与电脑管理」，确认服务器地址，注册或登录账号。
3. 在目标电脑运行 `panecast pair`，在桌面版粘贴配对链接，将电脑绑定到账号。
4. 在另一台设备登录相同服务器上的同一账号，选择电脑即可连接。

也可以直接粘贴已有配对链接，不使用账号。已有手机配对不受影响。
账号按服务器隔离；不同服务器上的同名用户名不是同一个账号。桌面版不会安装或授权
本机的终端网关。要让其他设备访问本机，请按 [Mac 接入指南](../docs/MAC-SETUP.md) 配置。

此预览包使用本地签名，尚未经过 Apple 公证。macOS 可能需要在「系统设置 → 隐私与安全性」
中确认打开。当前没有 Windows / Linux 安装包。桌面端支持连接期间的收件箱和应用内提醒，
不接入 APNs，关闭应用后不会接收手机推送。

## 开发与验证

```sh
cd client
npm ci
npm run typecheck
npm run lint
cd ../desktop
npm ci
npm test
npm run build
```

产物在 `build/desktop/`，包含 `.app`、带版本号的 ZIP、SHA-256 和元数据。
`npm run export && npm start` 可启动开发客户端；`PANECAST_DESKTOP_ARCH=x64 npm run build`
可以构建 Intel 包，需在相应机器上验证后再发布。

Expo 的桌面构建使用 SPA 输出，普通 Web 演示继续使用静态输出。Electron 只加载包内
资源，启用 sandbox、context isolation 和 webSecurity，不向页面开放 Node.js。
HTTP 和 WebSocket 通过受限的本机桥接沿用手机协议；无需改动旧 relay 的认证方式，
也无需把令牌放进 URL。配对和账号信息由系统安全存储加密，保存于应用数据目录。

发布见 [下载页维护说明](../distribution/README.md)。Mac 预览版不具备自动更新功能，
升级时下载新版本并替换应用，登录信息保留。
