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
final class TerminalInputView: ExpoView, UITextViewDelegate {
  enum Mode { case line, live }

  let textView = TerminalTextView()
  private let placeholderLabel = UILabel()
  private var mode: Mode = .line
  private var fontName: String?
  private var fontSize: CGFloat = 15

  let onCommitText = EventDispatcher()
  let onKeyAction = EventDispatcher()
  let onChangeState = EventDispatcher()
  let onSubmit = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    textView.delegate = self
    textView.backgroundColor = .clear
    textView.isScrollEnabled = true
    textView.showsVerticalScrollIndicator = false
    textView.textContainer.lineFragmentPadding = 0
    // Long input wraps and the view scrolls to keep the caret visible.
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
    // Center one line vertically.
    let lineHeight = textView.font?.lineHeight ?? fontSize * 1.2
    let inset = max(0, (bounds.height - lineHeight) / 2)
    textView.textContainerInset = UIEdgeInsets(top: inset, left: 0, bottom: inset, right: 0)
    placeholderLabel.frame = CGRect(x: 0, y: inset, width: bounds.width, height: lineHeight)
  }

  // MARK: Props

  func setMode(_ next: Mode) {
    guard next != mode else { return }
    if mode == .live { flushLive() }
    mode = next
    textView.returnKeyType = next == .live ? .default : .send
    clearText()
    if textView.isFirstResponder { textView.reloadInputViews() }
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
    setNeedsLayout()
  }

  func clearText() {
    textView.unmarkText()
    textView.text = ""
    updatePlaceholder()
    emitState()
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
