# Panecast 商店素材

这套素材使用应用的深色配色、窗口轮廓和终端提示符。文案依据当前支持的功能编写，
并说明 cmux / relay 要求、通知限制和中转连接的数据处理方式。

## 文件

- `listing.zh-Hans.json`：中文名称、副标题、介绍、关键词、宣传文本、网址和测试说明。
- `privacy.md`、`support.md`：隐私政策和使用支持文档。
- `screenshots/overview.png`：四张 iPhone 宣传图的总览。
- `screenshots/raw/`：真实 iOS 模拟器截图，来自应用内的离线演示。
- `screenshots/zh-Hans/`：已排版的商店图片，每种尺寸四张。
- `screenshots/manifest.json`：图片尺寸与设备类别，供上传脚本读取。
- `../client/assets/brand/`：可编辑 SVG 标志和完整图标。
- `../client/assets/panecast.icon/`：iOS Icon Composer 资源。

| 图片组 | 尺寸 | 内容 |
|---|---|---|
| iPhone 中等屏幕 | 1206 × 2622 | 终端、工作区、收件箱、设置 |
| iPhone 大屏幕 | 1320 × 2868 | 相同功能，按对应尺寸排版 |
| iPad 13 英寸 | 2064 × 2752 | 真实 iPad 界面，独立排版 |

所有最终图片都是无透明通道的 RGB PNG。图片中的项目、通知和终端输出为离线演示
生成的示例数据；应用界面来自实际客户端，不是重画的界面模型。

## 重新生成

```bash
python3 store/generate_brand.py
python3 store/render_screenshots.py
```

图像脚本依赖 Pillow 和 `rsvg-convert`。中文排版使用 macOS 的 Hiragino Sans GB。

重新采集原始画面时，在独立 checkout 中创建并启动 iPhone 与 iPad 模拟器，安装
本项目的 Debug iOS 构建。随后在 `client/` 启动 Metro：

```bash
EXPO_PUBLIC_STORE_CAPTURE=1 npx expo start --localhost --port 8081 > build/ios/store-metro.log 2>&1
```

在项目根目录运行：

```bash
python3 store/capture_screenshots.py --iphone IPHONE_UDID --ipad IPAD_UDID
```

采集脚本会等应用发出就绪信号，再通过模拟器接口截图。它只在专用 checkout 中临时
设置场景；正式 Release 构建通过 `__DEV__` 条件排除此启动逻辑。演示本身仍可由用户
从正常连接页面进入。采集后的图片需要目视检查，再运行排版脚本。

## 通过 App Store Connect API 发布

凭据从本机 `~/.appstoreconnect/profiles/panecast.json` 读取，也可通过
`ASC_PROFILE_PATH` 指定。配置保存 Key ID 和仓库外的私钥路径；个人密钥使用
`sub: user`，团队密钥使用 Issuer ID。不要把私钥、JWT 或本机配置提交到仓库。

```bash
node store/publish.mjs metadata
node store/publish.mjs screenshots
node store/publish.mjs attach-build 2
```

脚本只编辑 `PREPARE_FOR_SUBMISSION` 状态的 iOS 版本。截图通过 Apple 的
**App Asset Library** 上传，并根据实时参考数据校验尺寸、创建展示位置和设置顺序。
同一图片可恢复上传流程；文件变化时采用新的内容摘要，并替换同名素材的展示位置。
运行结果保存在被 Git 忽略的 `client/build/ios/` 中。

`attach-build` 会选择已处理完成的指定构建，写入测试说明，并关联已有内部测试组。
它不会提交 App Review。正式构建与上传命令见 [TESTFLIGHT.md](../client/TESTFLIGHT.md)。

## 在线支持文档

商店网址指向本仓库的 `app-store-support` 分支：

- [使用与帮助](https://github.com/nlamps99/panecast/blob/app-store-support/store/support.md)
- [隐私政策](https://github.com/nlamps99/panecast/blob/app-store-support/store/privacy.md)

更新这些文档时应同步该分支。若以后改用独立网站，先更新 App Store Connect 与
应用“关于”中的链接，再删除旧分支。
