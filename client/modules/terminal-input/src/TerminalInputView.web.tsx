import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
import { StyleSheet } from 'react-native';

import type { TerminalInputHandle, TerminalInputProps } from './TerminalInput.types';

/**
 * Browser version: an uncontrolled textarea that uses composition events to hold back
 * text the input method has not committed yet.
 */
const TerminalInputView = forwardRef<TerminalInputHandle, TerminalInputProps>(function TerminalInputView(props, ref) {
  const { mode, placeholder, textColor, caretColor, fontFamily, fontSize, editable, style } = props;
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const previousMode = useRef(mode);
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    focus: async () => input.current?.focus(),
    blur: async () => input.current?.blur(),
    clear: async () => {
      if (input.current) input.current.value = '';
      latest.current.onChangeState?.({ text: '', composing: false });
    },
    insertText: async (text: string) => {
      const element = input.current;
      if (!element || !text) return;
      const end = element.value.length;
      element.setRangeText(text, element.selectionStart ?? end, element.selectionEnd ?? end, 'end');
      flushLive();
      report();
    },
    getState: async () => ({ text: input.current?.value ?? '', composing: composing.current,
      selectionStart: input.current?.selectionStart ?? 0, selectionEnd: input.current?.selectionEnd ?? 0 }),
    applyEdit: async (expectedText, text, start, end) => {
      const element = input.current;
      if (!element || composing.current || latest.current.mode !== 'line' || element.value !== expectedText) return false;
      element.value = text;
      element.setSelectionRange(Math.max(0, Math.min(start, text.length)), Math.max(0, Math.min(end, text.length)));
      report();
      return true;
    },
  }));

  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    if (input.current) input.current.value = '';
  }, [mode]);

  const flushLive = () => {
    const element = input.current;
    if (!element || composing.current || latest.current.mode !== 'live') return;
    const text = element.value;
    if (!text) return;
    element.value = '';
    latest.current.onCommitText?.(text);
  };

  const report = () => {
    latest.current.onChangeState?.({ text: input.current?.value ?? '', composing: composing.current });
  };

  const flat = (StyleSheet.flatten(style) ?? {}) as CSSProperties;

  return (
    <textarea
      ref={input}
      rows={1}
      defaultValue={props.initialText ?? ''}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      disabled={editable === false}
      placeholder={placeholder}
      enterKeyHint={mode === 'live' || props.submitOnEnter === false ? 'enter' : 'send'}
      style={{
        ...flat,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        padding: 0,
        margin: 0,
        minWidth: 0,
        resize: 'none',
        display: 'block',
        lineHeight: 1.3,
        color: textColor,
        caretColor,
        fontFamily,
        fontSize,
      }}
      onCompositionStart={() => {
        composing.current = true;
        report();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        flushLive();
        report();
      }}
      onInput={() => {
        flushLive();
        report();
      }}
      onKeyDown={(event) => {
        // keyCode 229: the input method is handling this key.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        const { mode: currentMode, onKeyAction, onSubmit } = latest.current;
        if (event.key === 'Enter') {
          if (currentMode === 'line' && latest.current.submitOnEnter === false) return;
          event.preventDefault();
          if (currentMode === 'live') {
            flushLive();
            onKeyAction?.('enter');
          } else {
            onSubmit?.(input.current?.value ?? '');
          }
        } else if (event.key === 'Backspace' && currentMode === 'live' && !input.current?.value) {
          event.preventDefault();
          onKeyAction?.('backspace');
        }
      }}
    />
  );
});

export default TerminalInputView;
