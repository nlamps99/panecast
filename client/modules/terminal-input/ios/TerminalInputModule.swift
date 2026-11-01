import ExpoModulesCore

public class TerminalInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TerminalInput")

    View(TerminalInputView.self) {
      Events("onCommitText", "onKeyAction", "onChangeState", "onSubmit")

      Prop("mode") { (view: TerminalInputView, mode: String) in
        view.setMode(mode == "live" ? .live : .line)
      }
      Prop("placeholder") { (view: TerminalInputView, text: String?) in
        view.setPlaceholder(text ?? "")
      }
      Prop("placeholderColor") { (view: TerminalInputView, color: UIColor?) in
        view.setPlaceholderColor(color)
      }
      Prop("textColor") { (view: TerminalInputView, color: UIColor?) in
        view.textView.textColor = color ?? .label
      }
      Prop("caretColor") { (view: TerminalInputView, color: UIColor?) in
        view.textView.tintColor = color
      }
      Prop("fontFamily") { (view: TerminalInputView, name: String?) in
        view.setFont(name: name, size: nil)
      }
      Prop("fontSize") { (view: TerminalInputView, size: Double?) in
        view.setFont(name: nil, size: size.map { CGFloat($0) })
      }
      Prop("editable") { (view: TerminalInputView, editable: Bool?) in
        view.textView.isEditable = editable ?? true
      }

      AsyncFunction("focus") { (view: TerminalInputView) in
        _ = view.textView.becomeFirstResponder()
      }
      AsyncFunction("blur") { (view: TerminalInputView) in
        _ = view.textView.resignFirstResponder()
      }
      AsyncFunction("clear") { (view: TerminalInputView) in
        view.clearText()
      }
    }
  }
}
