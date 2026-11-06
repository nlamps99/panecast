# Android APK 发布

Android 与 iOS 使用同一套 `client/` 代码。当前独立 APK 面向 ARM64 手机，最低
Android 7.0（API 24），不要求 Google Play 服务。Android 通知目前依赖 App 保持
连接，没有接入离线推送。

## 本地构建

需要 JDK 17、Android SDK/NDK 和已安装的项目依赖。默认 SDK 路径为
`~/Library/Android/sdk`，也可设置 `ANDROID_HOME`。构建工具默认使用 `36.0.0`，
可以通过 `PANECAST_ANDROID_BUILD_TOOLS` 调整。

```sh
cd client
npm ci
# 首次发布时创建一次；已有密钥时此命令拒绝覆盖。
npm run android:release -- init-key
npm run android:release
```

发布前递增 `app.json` 中的 `android.versionCode`。脚本通过 Expo prebuild 生成
Android 工程、构建 Release、进行 16 KB zip 对齐，再以独立发布密钥签名，最后
验证签名并生成 SHA-256。产物为 `build/android/panecast-<version>-<versionCode>-arm64.apk`。

签名密钥和密码仅保存在 `~/.cmuxremote/android-release/`，不进入仓库和下载目录。
请私下备份整个目录；之后的升级需要同一签名。可通过
`PANECAST_ANDROID_SIGNING_DIR` 指定已有签名目录。以前使用开发证书安装的构建
无法直接覆盖为发布证书，需要卸载旧版并重新配对；正式 APK 后续可原地升级。

## 服务器下载

统一下载与版本记录页面：**https://ningzx.cn/panecast/**。后续对外分享此固定页面。

[下载最新版 APK](https://ningzx.cn/static/panecast/panecast-latest.apk)。
当前为 **0.1.0（build 9）**，约 43 MB，2026-11-06 发布。
Codex 会话支持本机历史缓存、后台更新、连续上滑读取及下一段历史预取；重新打开时先显示已读内容。
工具调用默认折叠，点击摘要即可展开，失败提示和待确认请求仍然可见。
通知只保留需要处理的问题和任务完成，并合并重复事件。
[固定版本](https://ningzx.cn/static/panecast/panecast-0.1.0-9-arm64.apk)、
[SHA-256 校验文件](https://ningzx.cn/static/panecast/panecast-0.1.0-9-arm64.apk.sha256)和
[版本信息](https://ningzx.cn/static/panecast/latest.json)均可公开访问。

把 APK 和同名 `.sha256` 文件放入 HTTPS 静态目录，使用带版本号的文件名。
统一发布流程见 [下载页维护说明](../distribution/README.md)，页面从版本清单读取最新版本。
发布后从公网重新下载文件，核对 SHA-256 和签名。不要上传密钥、手机配对凭据、
本地配置或构建缓存。

Mac 后端启动和为其他电脑分配连接信息见 [Mac 接入指南](../docs/MAC-SETUP.md)。
