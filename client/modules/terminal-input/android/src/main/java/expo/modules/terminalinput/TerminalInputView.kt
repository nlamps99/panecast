package expo.modules.terminalinput

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import com.facebook.react.common.assets.ReactFontManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Terminal input that only hands text to JavaScript once the input method has
 * committed it. Pinyin letters inside the IME's composing span stay in the
 * field. See the iOS view for the modes.
 */
class TerminalInputView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  enum class Mode { LINE, LIVE }

  companion object {
    /** Matches the iOS view's text container inset. */
    const val VERTICAL_INSET_DP = 8f
  }

  private val onCommitText by EventDispatcher()
  private val onKeyAction by EventDispatcher()
  private val onChangeState by EventDispatcher()
  private val onSubmit by EventDispatcher()
  private val onContentSizeChange by EventDispatcher()

  private var mode = Mode.LINE
  private var batchDepth = 0
  private var flushPosted = false
  private var suppressWatcher = false
  private var fontFamily: String? = null
  private var fontSizeSp = 15f
  private var lastContentHeight = 0f

  // Text wraps and the field reports its height, so Android has to lay it
  // out when the line count changes.
  override val shouldUseAndroidLayout: Boolean = true

  val editText: EditText = object : EditText(context) {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
      val base = super.onCreateInputConnection(outAttrs) ?: return null
      outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_EXTRACT_UI or
        EditorInfo.IME_FLAG_NO_FULLSCREEN
      return TerminalConnection(base)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
      if (handleKey(keyCode)) return true
      return super.onKeyDown(keyCode, event)
    }
  }

  /** Watches IME batch edits and backspace on an empty field. */
  private inner class TerminalConnection(target: InputConnection) : InputConnectionWrapper(target, true) {
    override fun beginBatchEdit(): Boolean {
      batchDepth++
      return super.beginBatchEdit()
    }

    override fun endBatchEdit(): Boolean {
      val result = super.endBatchEdit()
      batchDepth = maxOf(0, batchDepth - 1)
      scheduleFlush()
      return result
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      if (editText.text.isEmpty() && beforeLength > 0 && !isComposing()) {
        if (mode == Mode.LIVE) repeat(beforeLength.coerceAtMost(64)) { emitKey("backspace") }
        return true
      }
      return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
      if (editText.text.isEmpty() && beforeLength > 0 && !isComposing()) {
        if (mode == Mode.LIVE) repeat(beforeLength.coerceAtMost(64)) { emitKey("backspace") }
        return true
      }
      return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
      if (event.action == KeyEvent.ACTION_DOWN && handleKey(event.keyCode)) return true
      if (event.action == KeyEvent.ACTION_UP &&
        (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_DEL) &&
        shouldConsumeKey(event.keyCode)
      ) {
        return true
      }
      return super.sendKeyEvent(event)
    }
  }

  init {
    editText.apply {
      layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
      background = null
      val inset = (VERTICAL_INSET_DP * resources.displayMetrics.density).toInt()
      setPadding(0, inset, 0, inset)
      gravity = Gravity.TOP or Gravity.START
      // No suggestions: keyboards like Gboard otherwise keep whole English
      // words in the composing span, which would delay live input to word ends.
      // A text (not multi-line) input type keeps Return an action key instead
      // of a newline; set it first, since it also switches single-line on.
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      imeOptions = EditorInfo.IME_ACTION_SEND
      // ...but wrap on screen so long commands stay readable.
      setHorizontallyScrolling(false)
      maxLines = Int.MAX_VALUE
      isVerticalScrollBarEnabled = false
      setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
      // Keyboards report the action key differently (SEND, DONE, UNSPECIFIED,
      // or a raw Enter event); this field has no other action, so any of them
      // means Enter. Only the key-up half of a raw event is ignored.
      setOnEditorActionListener { _, _, event ->
        if (event == null || event.action == KeyEvent.ACTION_DOWN) handleEnter()
        true
      }
      addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reportContentHeight() }
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) {
          if (suppressWatcher) return
          scheduleFlush()
        }
      })
    }
    addView(editText)
  }

  // MARK: Props

  fun setMode(next: Mode) {
    if (next == mode) return
    if (mode == Mode.LIVE) flushLive()
    mode = next
    editText.imeOptions = if (next == Mode.LIVE) EditorInfo.IME_ACTION_NONE else EditorInfo.IME_ACTION_SEND
    clearText()
    restartInput()
  }

  fun setCaretColor(color: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      editText.textCursorDrawable?.setTint(color)
    }
    editText.highlightColor = (color and 0x00FFFFFF) or 0x55000000
  }

  fun setFontFamily(name: String?) {
    fontFamily = name
    applyTypeface()
  }

  fun setFontSize(size: Float?) {
    if (size != null) fontSizeSp = size
    editText.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
  }

  private fun applyTypeface() {
    val name = fontFamily
    // Same lookup RN Text uses, so fonts embedded by the expo-font plugin resolve.
    editText.typeface = if (name.isNullOrEmpty()) {
      Typeface.MONOSPACE
    } else {
      ReactFontManager.getInstance().getTypeface(name, Typeface.NORMAL, context.assets)
    }
  }

  fun focusAndShowKeyboard() {
    editText.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(editText, InputMethodManager.SHOW_IMPLICIT)
  }

  fun blurAndHideKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(editText.windowToken, 0)
    editText.clearFocus()
  }

  fun clearText() {
    clearSilently()
    emitState()
  }

  // MARK: Input handling

  private fun isComposing(): Boolean {
    val text = editText.text ?: return false
    return BaseInputConnection.getComposingSpanStart(text) != -1
  }

  private fun scheduleFlush() {
    if (flushPosted) return
    flushPosted = true
    post {
      flushPosted = false
      if (batchDepth > 0) return@post
      if (mode == Mode.LIVE) flushLive()
      emitState()
    }
  }

  /** Sends committed text. Never sends text inside the composing span. */
  private fun flushLive() {
    if (mode != Mode.LIVE || isComposing()) return
    val text = editText.text?.toString() ?: return
    if (text.isEmpty()) return
    // Emptying the same Editable reports the new selection to the keyboard
    // without restarting input, which would reset its layout (symbols page,
    // shift) after every character.
    clearSilently()
    onCommitText(mapOf("text" to text))
  }

  private fun shouldConsumeKey(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> !isComposing()
    KeyEvent.KEYCODE_DEL -> editText.text.isEmpty() && !isComposing()
    else -> false
  }

  /** Hardware keys and IME key events. Returns true when consumed. */
  private fun handleKey(keyCode: Int): Boolean {
    if (!shouldConsumeKey(keyCode)) return false
    when (keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> handleEnter()
      KeyEvent.KEYCODE_DEL -> if (mode == Mode.LIVE) emitKey("backspace")
    }
    return true
  }

  private fun handleEnter() {
    if (isComposing()) return
    when (mode) {
      Mode.LIVE -> {
        flushLive()
        emitKey("enter")
      }
      Mode.LINE -> onSubmit(mapOf("text" to (editText.text?.toString() ?: "")))
    }
  }

  /** Height the text needs at the current width, in dp, including the inset. */
  private fun reportContentHeight() {
    val layout = editText.layout ?: return
    val density = resources.displayMetrics.density
    val px = layout.getLineTop(maxOf(1, editText.lineCount)) + editText.paddingTop + editText.paddingBottom
    val dp = kotlin.math.ceil(px / density)
    if (kotlin.math.abs(dp - lastContentHeight) < 0.5f) return
    lastContentHeight = dp
    onContentSizeChange(mapOf("height" to dp.toDouble()))
  }

  private fun emitKey(key: String) {
    onKeyAction(mapOf("key" to key))
  }

  private fun emitState() {
    onChangeState(mapOf("text" to (editText.text?.toString() ?: ""), "composing" to isComposing()))
  }

  private fun clearSilently() {
    suppressWatcher = true
    editText.text?.clear()
    suppressWatcher = false
  }

  /** Tells the IME the field changed under it (new action key, dropped composing state). */
  private fun restartInput() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.restartInput(editText)
  }
}
