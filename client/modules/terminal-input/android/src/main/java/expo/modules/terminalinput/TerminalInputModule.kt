package expo.modules.terminalinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TerminalInput")

    View(TerminalInputView::class) {
      Events("onCommitText", "onKeyAction", "onChangeState", "onSubmit")

      Prop("mode") { view: TerminalInputView, mode: String ->
        view.setMode(if (mode == "live") TerminalInputView.Mode.LIVE else TerminalInputView.Mode.LINE)
      }
      Prop("placeholder") { view: TerminalInputView, text: String? ->
        view.editText.hint = text ?: ""
      }
      Prop("placeholderColor") { view: TerminalInputView, color: String? ->
        parseColor(color)?.let { view.editText.setHintTextColor(it) }
      }
      Prop("textColor") { view: TerminalInputView, color: String? ->
        parseColor(color)?.let { view.editText.setTextColor(it) }
      }
      Prop("caretColor") { view: TerminalInputView, color: String? ->
        parseColor(color)?.let { view.setCaretColor(it) }
      }
      Prop("fontFamily") { view: TerminalInputView, name: String? ->
        view.setFontFamily(name)
      }
      Prop("fontSize") { view: TerminalInputView, size: Double? ->
        view.setFontSize(size?.toFloat())
      }
      Prop("editable") { view: TerminalInputView, editable: Boolean? ->
        view.editText.isEnabled = editable ?: true
      }

      AsyncFunction("focus") { view: TerminalInputView ->
        view.focusAndShowKeyboard()
      }
      AsyncFunction("blur") { view: TerminalInputView ->
        view.blurAndHideKeyboard()
      }
      AsyncFunction("clear") { view: TerminalInputView ->
        view.clearText()
      }
    }
  }

  private fun parseColor(value: String?): Int? {
    if (value.isNullOrEmpty()) return null
    return try {
      android.graphics.Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      null
    }
  }
}
