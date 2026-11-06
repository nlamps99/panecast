# 发布到 TestFlight

Panecast 的 iOS 客户端在本目录，应用标识为 `com.nzx.panecast`。可以直接用
本机 Xcode 归档和上传，不需要 Expo 云构建账号。`ios/` 由 Expo 生成，不手动修改。

本项目的 App Store Connect 应用已创建：
[Panecast](https://appstoreconnect.apple.com/apps/6830419188/distribution/ios/version/inflight)，
Apple ID 为 `6830419188`。后续发版直接使用此记录及已有的 Bundle ID。

## 首次准备

1. 使用有效的 Apple Developer 付费会员，在 Xcode → Settings → Apple Accounts
   中登录相应团队。账号需要有创建应用、管理签名和上传构建的权限。
2. 在 [App Store Connect](https://appstoreconnect.apple.com/apps) 新建应用：
   - 平台：iOS
   - 名称：Panecast（以 Apple 检查名称可用性的结果为准）
   - 主要语言：简体中文
   - Bundle ID：`com.nzx.panecast`
   - SKU：`panecast-ios`
   - 用户访问权限：按团队需要选择；个人团队可选完全访问。
3. Bundle ID 从下拉列表选择已有的 `com.nzx.panecast`。如果找不到，先确认登录的
   团队正确，并在 Apple Developer 的 Identifiers 中检查。已存在的标识不需要
   重新注册；只有首次使用新标识时，才让 Xcode 自动注册或手动注册并启用
   Push Notifications。

Apple 要求的账号验证、会员注册和新协议接受需由账号持有人完成。应用记录只需
创建一次，后续构建可以继续通过命令行上传。已有 App Store Connect API 自动化
也可用于管理记录和测试，但不是本地构建的前提。

## 归档与上传

在 `client/` 中执行，将 `YOUR_TEAM_ID` 替换成自己的开发者团队 ID：

```bash
npm run typecheck
npm run lint
npx expo-doctor
APPLE_TEAM_ID=YOUR_TEAM_ID npm run ios:archive
```

该命令重新生成 iOS 工程、安装 CocoaPods 依赖，并构建 Release 归档。JavaScript
会打入应用，运行时不需要 Metro。归档位于 `build/ios/Panecast.xcarchive`。

先导出 App Store 分发包，检查分发签名是否可用：

```bash
npm run ios:export
```

IPA 位于 `build/ios/export/`。App Store Connect 应用记录准备好后上传：

```bash
npm run ios:upload
```

上传使用 Xcode 登录的账号及自动签名，可按需创建分发证书和描述文件。若 Xcode
要求重新登录，先在 Xcode 的 Apple Accounts 中处理，再重试。也可以打开归档，
通过 Organizer → Distribute App → App Store Connect 上传。

## 版本与测试

- 面向用户的版本号在 `app.json` 的 `expo.version`，初始为 `0.1.0`。
- 每次上传新构建前递增 `expo.ios.buildNumber`，初始为 `1`，然后重新归档。
  脚本不让 Xcode 自动改号，确保上传版本与配置一致。
- 当前客户端只使用系统网络传输加密、安全存储、随机数和校验摘要，配置了
  `ios.config.usesNonExemptEncryption: false`。如果以后加入其他加密实现，发布前
  重新评估该声明。
- 上传成功后，等待 Apple 处理，再到应用的 TestFlight 页面选择构建、配置测试组。
  内部测试与外部测试不同；外部测试通常需要 Beta App Review，并补充测试说明、
  联系方式等信息。
- TestFlight 构建使用生产 APNs。接收推送还需要 relay 配好此 Bundle ID 对应的
  APNs 凭据；应用上传本身不会配置 relay。

发布前至少在真机检查扫码配对、终端输入（含中文输入法）、图片发送、重新连接和
推送，并确认演示模式能独立打开，便于测试和审核。

参考：[Expo 本地发布](https://docs.expo.dev/guides/local-app-production/)、
[Xcode 上传流程](https://docs.expo.dev/submit/ios-manual/)。

图标、商店文案、截图及其 API 发布流程见 [商店素材说明](../store/README.md)。
