# 桌面版 0.2.2：修复全局样式失效

## 根因

用户在 0.2.1 中看到黑色标题、系统默认按钮和堆在左上角的控件。共享界面已经定义了
深色主题、字体、按钮样式、间距及居中布局，但这些 React Native Web 样式未获准加载。

Tauri 在构建 HTML 时为 Expo 的静态 `<style id="expo-reset">` 注入 nonce，并在返回资源时
将该 nonce 加入 `style-src 'self' 'unsafe-inline'`。CSP 规定，同一来源列表中含有 nonce
或 hash 时，`unsafe-inline` 不再生效。React Native Web 0.21.4 运行时创建的 style 元素
没有 nonce，React 的内联样式也受影响，因此界面退回浏览器默认外观。

回归测试在修改前通过真实 Tauri asset resolver 取得的 CSP 为
`style-src 'self' 'unsafe-inline' 'nonce-…'`，明确复现失败。没有操作用户的窗口或浏览器。

## 修复

只将 `style-src` 加入 Tauri 的 `dangerousDisableAssetCspModification` 列表，使运行时样式
使用原本配置的 `'self' 'unsafe-inline'`。脚本来源、脚本 nonce / hash 自动处理、对象与
frame 限制保持启用，应用继续仅加载包内脚本。修复位于桌面打包配置，适用于所有共享页面；
没有给单个页面添加临时 CSS 或修改手机端设计。

参考：[Tauri CSP 文档](https://v2.tauri.app/security/csp/)，以及实际依赖的
`tauri-utils 2.10.2 html2::inject_nonce_token`、`tauri 2.12.5 manager::set_csp` 和
`react-native-web 0.21.4 createCSSStyleSheet`。

## 验证

- 新测试通过 MockRuntime 读取真实导出资源及最终 CSP，检查运行时样式可用，并确认脚本
  自动处理仍开启、脚本策略未允许任意内联脚本或 eval、object / frame 仍受限。
- `npm test` 使用 `tauri/custom-protocol`，确保覆盖正式打包的资源处理路径；4 项 JS 桥接
  测试与 8 项默认 Rust 测试通过。2 项需要真实外部环境的测试保持显式忽略。
- Rust Clippy（all targets，警告视为失败）、fmt，以及客户端 typecheck / lint 通过。
- 0.2.2 的 release 构建、ZIP / DMG 完整性、包内应用签名、arm64 架构、最低系统版本与
  两份安装说明检查通过。安装器的首次安装、升级备份、损坏下载、无关应用 / 符号链接保护、
  运行检测、失败恢复和响应截断检查通过，全部使用临时目录。

本次没有打开图形窗口或进行点击验证，样式兼容性由实际打包资源的 CSP 回归测试确认。

## 产物

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| panecast-desktop-0.2.2-mac-arm64.dmg | 3,617,749 | 3312abc995467159d167feb5e37a2dd1777a6b3e0ca0e9b0f66547f275e5d0b8 |
| panecast-desktop-0.2.2-mac-arm64.zip | 3,371,640 | aa0201b6a1190ab4e1867e28c8be527e2843da86cdb75faf0dba508d847b3fdd |
| install-desktop-0.2.2-mac-arm64.sh | 5,630 | b3e3c875e663de6bfad36ccfb2271e9df6ad5e553e5dbacc3f2424687c855a39 |
