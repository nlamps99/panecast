import ExpoModulesCore
import UIKit

/// Text view that reports backspace even when it has nothing to delete, so
/// live mode can forward it to the terminal.
final class TerminalTextView: UITextView {
  var onDeleteWhenEmpty: (() -> Void)?

  override func deleteBackward() {
    if text.isEmpty && markedTextRange == nil {
      onDeleteWhenEmpty?()
      return
    }
    super.deleteBackward()
  }
}

/// Terminal input that only hands text to JavaScript once the input method has
/// committed it.
///
/// RN's TextInput reports Pinyin letters while they are still being composed
/// and offers no way to tell them from typed text. Here, text that is still
/// "marked" (being composed) never leaves the view.
///
/// - live mode: committed text is sent immediately (`onCommitText`) and the
///   field is emptied. Backspace on an empty field and Return arrive as
///   `onKeyAction`.
/// - line mode: the field keeps its text; JS gets `onChangeState` with the
///   text and whether it is composing, and `onSubmit` on Return.
///
/// `onContentSizeChange` reports the height the text needs (including the
/// vertical inset), so JS can grow the field; past that the view scrolls.
final class TerminalInputView: ExpoView, UITextViewDelegate {
  enum Mode { case line, live }

  static let verticalInset: CGFloat = 8

  let textView = TerminalTextView()
  private let placeholderLabel = UILabel()
  private var mode: Mode = .line
  private var submitOnEnter = true
  private var appliedInitialText = false
  private var fontName: String?
  private var fontSize: CGFloat = 15

  let onCommitText = EventDispatcher()
  let onKeyAction = EventDispatcher()
  let onChangeState = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onContentSizeChange = EventDispatcher()
  private var lastContentHeight: CGFloat = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    textView.delegate = self
    textView.backgroundColor = .clear
    textView.isScrollEnabled = true
    textView.showsVerticalScrollIndicator = false
    textView.textContainer.lineFragmentPadding = 0
    textView.textContainerInset = UIEdgeInsets(top: Self.verticalInset, left: 0, bottom: Self.verticalInset, right: 0)
    // Long input wraps; JS grows the view up to a limit, then it scrolls.
    textView.autocorrectionType = .no
    textView.autocapitalizationType = .none
    textView.spellCheckingType = .no
    textView.smartDashesType = .no
    textView.smartQuotesType = .no
    textView.smartInsertDeleteType = .no
    if #available(iOS 17.0, *) {
      textView.inlinePredictionType = .no
    }
    textView.keyboardAppearance = .dark
    textView.returnKeyType = .send
    textView.onDeleteWhenEmpty = { [weak self] in self?.deleteOnEmpty() }
    addSubview(textView)

    placeholderLabel.numberOfLines = 1
    placeholderLabel.textColor = .placeholderText
    placeholderLabel.isUserInteractionEnabled = false
    addSubview(placeholderLabel)

    applyFont()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    let lineHeight = textView.font?.lineHeight ?? fontSize * 1.2
    placeholderLabel.frame = CGRect(x: 0, y: Self.verticalInset, width: bounds.width, height: lineHeight)
    if textView.contentSize.height <= bounds.height + 0.5, textView.contentOffset.y != 0 {
      textView.contentOffset = .zero
    }
    reportContentHeight()
  }

  /// Height the current text needs at the current width, including the inset.
  private func reportContentHeight() {
    guard bounds.width > 0 else { return }
    let fitted = textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
    let height = ceil(fitted)
    guard abs(height - lastContentHeight) > 0.5 else { return }
    lastContentHeight = height
    onContentSizeChange(["height": height])
  }

  // MARK: Props

  func setMode(_ next: Mode) {
    guard next != mode else { return }
    if mode == .live { flushLive() }
    mode = next
    textView.returnKeyType = next == .live || !submitOnEnter ? .default : .send
    clearText()
    if textView.isFirstResponder { textView.reloadInputViews() }
  }

  func setInitialText(_ text: String) {
    guard !appliedInitialText else { return }
    appliedInitialText = true
    guard (textView.text ?? "").isEmpty, textView.markedTextRange == nil else { return }
    textView.text = text
    textView.selectedRange = NSRange(location: (text as NSString).length, length: 0)
    updatePlaceholder()
    emitState()
    reportContentHeight()
  }

  func setSubmitOnEnter(_ submit: Bool) {
    guard submitOnEnter != submit else { return }
    submitOnEnter = submit
    textView.returnKeyType = mode == .live || !submit ? .default : .send
    if textView.isFirstResponder { textView.reloadInputViews() }
  }

  func snapshot() -> [String: Any] {
    let text = textView.text ?? ""
    let length = (text as NSString).length
    let selection = textView.selectedRange
    let start = selection.location == NSNotFound ? length : min(selection.location, length)
    return ["text": text, "composing": textView.markedTextRange != nil,
            "selectionStart": start, "selectionEnd": min(length, start + selection.length)]
  }

  func applyEdit(expected: String, text: String, start: Int, end: Int) -> Bool {
    guard mode == .line, textView.markedTextRange == nil, (textView.text ?? "") == expected else { return false }
    let length = (text as NSString).length
    let lower = max(0, min(start, length)), upper = max(0, min(end, length))
    textView.text = text
    textView.selectedRange = NSRange(location: min(lower, upper), length: abs(upper - lower))
    textViewDidChange(textView)
    textView.scrollRangeToVisible(textView.selectedRange)
    return true
  }

  func setPlaceholder(_ text: String) {
    placeholderLabel.text = text
    updatePlaceholder()
  }

  func setPlaceholderColor(_ color: UIColor?) {
    placeholderLabel.textColor = color ?? .placeholderText
  }

  func setFont(name: String?, size: CGFloat?) {
    if let name { fontName = name }
    if let size { fontSize = size }
    applyFont()
  }

  private func applyFont() {
    let font = fontName.flatMap { UIFont(name: $0, size: fontSize) }
      ?? .monospacedSystemFont(ofSize: fontSize, weight: .regular)
    textView.font = font
    placeholderLabel.font = font
    lastContentHeight = 0
    setNeedsLayout()
  }

  func clearText() {
    textView.unmarkText()
    textView.text = ""
    updatePlaceholder()
    emitState()
    reportContentHeight()
  }

  /// Inserts `text` at the caret, replacing any selection, as if it had been
  /// typed: the placeholder, live mode, `onChangeState` and the height update
  /// the same way. Text the input method is still composing is committed
  /// first, so it is neither lost nor sent half-finished.
  func insertText(_ text: String) {
    guard !text.isEmpty else { return }
    if textView.markedTextRange != nil { textView.unmarkText() }
    let current = (textView.text ?? "") as NSString
    var range = textView.selectedRange
    if range.location == NSNotFound || range.location > current.length {
      range = NSRange(location: current.length, length: 0)
    }
    range.length = min(range.length, current.length - range.location)
    textView.text = current.replacingCharacters(in: range, with: text)
    textView.selectedRange = NSRange(location: range.location + (text as NSString).length, length: 0)
    // Setting `text` does not call the delegate; run the same path as typing.
    textViewDidChange(textView)
    textView.scrollRangeToVisible(textView.selectedRange)
  }

  // MARK: UITextViewDelegate

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    guard text == "\n" else { return true }
    // While composing, Return belongs to the input method (it confirms the
    // candidate or the raw letters); never treat it as a submit.
    if textView.markedTextRange != nil { return true }
    switch mode {
    case .live:
      flushLive()
      onKeyAction(["key": "enter"])
    case .line:
      if !submitOnEnter { return true }
      onSubmit(["text": textView.text ?? ""])
    }
    return false
  }

  func textViewDidChange(_ textView: UITextView) {
    updatePlaceholder()
    if mode == .live {
      flushLive()
    }
    emitState()
    reportContentHeight()
  }

  // MARK: Live mode

  /// Sends whatever the input method has committed. Never sends marked text.
  private func flushLive() {
    guard mode == .live, textView.markedTextRange == nil else { return }
    let text = textView.text ?? ""
    guard !text.isEmpty else { return }
    textView.text = ""
    updatePlaceholder()
    onCommitText(["text": text])
  }

  private func deleteOnEmpty() {
    if mode == .live {
      onKeyAction(["key": "backspace"])
    }
  }

  private func emitState() {
    onChangeState([
      "text": textView.text ?? "",
      "composing": textView.markedTextRange != nil,
    ])
  }

  private func updatePlaceholder() {
    placeholderLabel.isHidden = !(textView.text ?? "").isEmpty || textView.markedTextRange != nil
  }
}
