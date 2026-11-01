# 终端窗口直接输入（UITextInput 方案）

参考 [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)（MIT）的 iOS 实现模式，不引入其依赖 ——
它是完整 VT100 模拟器，而本项目收的是 relay 推的屏幕 diff，已有自己的
`ANSIParser`/`CellGrid`/diff 重建，引入会和 diff 协议冲突。

## 已确认的前提事实

- `TerminalView.swift` 中 "cursor" 零匹配 —— **光标当前完全没有渲染**
- `TerminalVisualLayout`（`CellGrid.swift:127`）生产代码零调用，只有测试引用它
- 光标数据一路维护到 `grid.cursor`（`SurfaceStore.swift:156/167/311`）后断掉
- 渲染层：`UICollectionView` + `TerminalHistoryTextCell`（内含 `UITextView`），
  live tail 恒为最后一项，id = `SurfaceStore.liveHistoryAnchorID`
- cell 的 `textContainerInset = (top: 8, left: 16, bottom: 8, right: 12)`，
  `lineFragmentPadding = 0`，段落 `minimumLineHeight == maximumLineHeight == lineHeight`，
  `lineBreakMode = .byCharWrapping`
- SwiftTerm 的 `caretRect(for:)`/`firstRect(for:)` 直接返回 `bounds`，无单元格映射；
  `UITextInput` 文档模型不是 scrollback，只是在途输入缓冲 `textInputStorage`
- 主机侧 `surface.send_key` 合成 NSEvent，需 surface 处于聚焦态（`SurfaceStore.swift:248` 注释）
- 限速：`send_text` 100/s、`send_key` 200/s per device（`RateLimiter.swift:24-25`）

## 决策（已确认）

- CMD / LIVE / 终端直输 **三种模式共存**
- **一并支持外接硬件键盘**

## 阶段 1：光标渲染（其余全部依赖它）

新增 `ios/CmuxRemote/Terminal/TerminalCaretView.swift`：

- `TerminalCaretView: UIView`，`isUserInteractionEnabled = false`
- 块状光标，聚焦时实心、失焦时描边；0.7s `autoreverse`+`repeat` 闪烁动画
- 照 SwiftTerm `iOSCaretView.swift` 的做法，在 `willMove(toWindow:)`/`didMoveToWindow`
  和 `willEnterForegroundNotification` 时重建动画（窗口切换会丢动画）

几何计算 —— **用 TextKit 查询，不自己算**：

live tail cell 就是一个持有确切 `attributedText` 的 `UITextView`。把
`grid.cursor` 的 (y, x) 换算成该串的 UTF-16 offset，再问 text view 要 rect：

```
textView.position(from: beginningOfDocument, offset: n) → caretRect(for:)
```

这样换行折行、CJK 双宽、emoji 变体选择符全部由画出这段文本的同一个 TextKit
负责，不需要复现几何。offset 换算必须复用渲染器用的同一个
`TerminalGlyph.textStyleString(for:)`（它会返回多标量串，如 `●\u{FE0E}`），
列宽累加复用 `TerminalCellWidth.columns(for:)`。

不复用 `TerminalVisualLayout`：它按 1 列/字符算（`cursor.x % limit`），CJK 会偏，
且它产出的是另一条渲染路径的 `TerminalRenderRow`。阶段 1 结束后它仍是死代码，
本次不动它（删除属于额外范围）。

caret 挂在容器视图上（非 cell 内，避免 cell 复用问题），坐标从 cell 转换过来。
更新时机：live tail 内容变化、滚动（`scrollViewDidScroll` 已存在）、光标变化、
渲染配置变化。live tail cell 不可见时隐藏。

`TerminalHistoryTextCell` 需暴露内部 text view（internal 只读属性）。

## 阶段 2：`UITextInput` 输入面

新增 `ios/CmuxRemote/Terminal/TerminalInputSurface.swift`：

`final class TerminalInputSurface: UIView, UITextInput`，照 SwiftTerm 模式：

- 在途缓冲 `textInputStorage: String`，`beginningOfDocument` 恒 0，
  `endOfDocument` 为缓冲长度；回车后 `resetInputBuffer()`
- `canBecomeFirstResponder = true`
- **`hitTest` 返回 nil** —— 这样能当 first responder 但绝不截获触摸，
  collection view 的滚动手势完全不受影响
- 回调 `onText: (String) -> Void`、`onKey: (Key) -> Void`
- `insertText` → 过 `LiveTerminalInputTranslator.interpret`（已修好 CRLF）→
  `onText` / `onKey(.enter)`
- `deleteBackward` → `onKey(.backspace)`
- `setMarkedText` → 只更新缓冲和 marked range，**不发送**
- `unmarkText` → 照 SwiftTerm 显式 `insertText(previouslyMarkedText)` 提交，
  其源码注释理由是 "Ensure that multi-char input (Chinese-Japanese keyboards) works"
- `caretRect(for:)` → 返回真实光标 rect（转换到本视图坐标系）。
  比 SwiftTerm 返回 `bounds` 更好：候选窗会锚定在光标处而非整个视图。
  自定义 `UITextInput` 系统不画插入点，由阶段 1 的 caret 负责
- UTF-16 offset 算术照 `iOSTextStorage.swift`：offset 落在字素簇中间或代理对内时
  按方向向外扫描到合法边界
- `UITextInputTraits`：`autocorrectionType = .no`、`autocapitalizationType = .none`、
  `smartQuotesType/smartDashesType/smartInsertDeleteType = .no`、`spellCheckingType = .no`

预编辑显示：组字期间在光标处显示 marked text。SwiftTerm 源码注明这只是个未实现的
设想（"could show an overlay"），但中文用户看不到预编辑无法选词，所以本次要做 ——
一个锚定在 caret 的小视图，用终端同款字体和配色。

## 阶段 3：接线

`TerminalHistoryCollectionView` 的 `makeUIView` 改为返回容器 `UIView`，内含
collection view + caret + 输入面 + 预编辑视图。representable 的关联类型跟着改，
改动局限在该文件内。

`WorkspaceView`：
- `TerminalInputMode` 加 `.terminal`，三态循环切换，标签 `CMD` / `LIVE` / `TERM`
- 点终端区域 → 输入面 `becomeFirstResponder()`
- 现有 SwiftUI accessory 面板（含快捷键栏）**保持原样**，不改成
  `inputAccessoryView` —— 你刚修的键盘布局逻辑（`containerBottomInset`、
  浮动键盘判定）继续有效，不推翻
- 复用现有 `sendText`/`sendKey`，走同一条 `surface.focus` + `send_key` 路径

`cmux.defaultLiveInput`（Bool）无法表达三态。新增 `cmux.defaultInputMode`（String），
读取时若旧键为 true 则迁移为 `.live`，设置页把开关换成三选一。

## 阶段 4：硬件键盘

在输入面实现 `pressesBegan(_:with:)`：

- 普通字符键（无修饰）→ 调 `super`，走 `insertText`，保持输入法链路完整
- 带 ctrl/alt/cmd 的键、方向键、功能键 → 自己映射成 `Key` 走 `onKey`
- 修饰键映射照 SwiftTerm：`.shift → shift`、`.control → ctrl`、`.alternate → alt`、
  `.command → cmd`
- 功能键按 `UIKeyboardHIDUsage` 解析（方向键、home/end、pgup/pgdn、F1–F12）
- 组字期间（`markedTextRange != nil`）不拦截，让候选词选择拿到方向键和回车
- 键名限定在主机词汇表内：`enter`/`tab`/`escape`/`up`/`down`/`left`/`right`/
  `home`/`end`/`pgup`/`pgdn`/`backspace`/`delete` + `ctrl-c` 这类组合
  （`KeyEncoder.swift:14-28`、`docs/specs/2026-05-09-cmux-iphone-bridge-design.md:187`）

限速注意：硬件键盘连打时字符仍走 `send_text`，只有特殊键走 `send_key`，
在 100/s、200/s 限额内。

## 测试

iOS 端用 XCTest（`ios/CmuxRemoteTests/`），SharedKit 用 swift-testing —— 分别照各自框架写。

- `TerminalCaretGeometryTests`：(row, col) → UTF-16 offset 换算，覆盖 ASCII、
  CJK 双宽、emoji 变体选择符、行尾越界、空行
- `TerminalInputSurfaceTests`：`insertText` 的文本/回车拆分、CRLF、`deleteBackward`、
  `setMarkedText` 不发送、`unmarkText` 提交、缓冲在回车后重置
- `HardwareKeyMappingTests`：`UIKey` → `Key` 映射，含修饰键组合和功能键，
  组字期间不拦截
- 跑构建 + 现有全部 iOS 测试确认无回归

## 风险

- **输入法时序**：`setMarkedText`/`shouldChangeTextIn` 的调用顺序各 iOS 版本不完全一致，
  单元测试覆盖不到，必须真机或模拟器用实际拼音键盘验证。这是最不确定的一块。
- **`hitTest` 返回 nil 能否 `becomeFirstResponder`**：设计依赖此点。这是 UIKit
  的既定行为（first responder 与命中测试解耦），但我没有在本环境实测。若不成立，
  退路是让输入面尺寸为 1×1 置于容器左上角，仍由 `caretRect` 提供候选窗锚点。
- VibeTunnel 移动端[明确放弃自定义 IME](https://docs.vibetunnel.sh/docs/cjk-ime-input)
  改用可见输入框，理由是「OS 键盘自带 IME」。三模式共存正好留了退路：
  终端直输若在真机上表现不佳，CMD/LIVE 仍可用。
- 它还记录了两个坑：不要轮询抢焦点（干扰候选词选择）、坐标要相对容器算。
