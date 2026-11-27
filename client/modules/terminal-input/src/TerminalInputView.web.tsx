import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
import { StyleSheet } from 'react-native';

import type { TerminalHardwareKey, TerminalInputHandle, TerminalInputProps } from './TerminalInput.types';

/** A key as the field sees it; keys handed over by `pressKey` are never part of a composition. */
type FieldKey = TerminalHardwareKey & { isComposing?: boolean; keyCode?: number };

/** Inline styles the field takes while it composes at the terminal cursor; restored afterwards. */
const ANCHOR_STYLES = ['transform', 'position', 'zIndex', 'backgroundColor', 'width', 'fontSize', 'lineHeight', 'clipPath'] as const;

let measuring: CanvasRenderingContext2D | null | undefined;
/** The drawn width of `text` in the field's current font; null where the page cannot measure. */
function textWidth(element: HTMLTextAreaElement, text: string): number | null {
  if (measuring === undefined) {
    try { measuring = element.ownerDocument.createElement('canvas').getContext('2d'); } catch { measuring = null; }
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!measuring || !style) return null;
  measuring.font = `${style.fontSize} ${style.fontFamily}`;
  return measuring.measureText(text).width;
}

/**
 * Browser version: an uncontrolled textarea that uses composition events to hold back
 * text the input method has not committed yet.
 *
 * A field that is not editable is read-only rather than disabled: a disabled
 * textarea drops focus, so typing would do nothing until the next click.
 */
const TerminalInputView = forwardRef<TerminalInputHandle, TerminalInputProps>(function TerminalInputView(props, ref) {
  const { mode, placeholder, textColor, caretColor, fontFamily, fontSize, editable, style } = props;
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const previousMode = useRef(mode);
  const anchored = useRef<Partial<Record<(typeof ANCHOR_STYLES)[number], string>> | null>(null);
  /** How wide the field may grow from the cursor before the window's edge. */
  const anchorRoom = useRef(0);
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
    pressKey: (event) => {
      const element = input.current;
      if (!element) return false;
      if (element.ownerDocument.activeElement !== element) element.focus();
      return handleKey(event);
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

  /**
   * Moves the field over the terminal cursor for the composition (see
   * `imeAnchor`): one terminal line tall, in the terminal's text size, just
   * wide enough for what is being composed. Only paint changes (a
   * translation, a clip, the font): the layout, and so the terminal's size,
   * stay as they are.
   */
  const anchorComposition = () => {
    const element = input.current;
    if (!element || anchored.current || latest.current.mode !== 'live') return;
    const anchor = latest.current.imeAnchor?.();
    if (!anchor) return;
    const box = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    const saved: Partial<Record<(typeof ANCHOR_STYLES)[number], string>> = {};
    for (const name of ANCHOR_STYLES) saved[name] = element.style[name];
    anchored.current = saved;
    element.style.fontSize = `${Math.max(9, Math.round(anchor.height / 1.3))}px`;
    element.style.lineHeight = `${anchor.height}px`;
    // A translation from where it is laid out, so no ancestor's containing block matters.
    element.style.transform = `translate(${Math.round(anchor.left - box.left)}px, ${Math.round(anchor.top - box.top)}px)`;
    element.style.position = 'relative';
    element.style.zIndex = '20';
    element.style.backgroundColor = anchor.background;
    element.style.clipPath = `inset(0px 0px ${Math.max(0, Math.round(box.height - anchor.height))}px 0px)`;
    anchorRoom.current = view ? Math.max(60, view.innerWidth - anchor.left - 12) : box.width;
    fitComposition();
  };

  const fitComposition = () => {
    const element = input.current;
    if (!element || !anchored.current) return;
    const width = textWidth(element, element.value);
    if (width !== null) element.style.width = `${Math.round(Math.min(anchorRoom.current, Math.max(24, width + 12)))}px`;
  };

  const releaseComposition = () => {
    const element = input.current, saved = anchored.current;
    anchored.current = null;
    if (!element || !saved) return;
    for (const name of ANCHOR_STYLES) element.style[name] = saved[name] ?? '';
  };

  /** One key for the field, typed in it or handed over by `pressKey`. True: it was used, so its default is prevented. */
  const handleKey = (event: FieldKey): boolean => {
    // keyCode 229: the input method is handling this key.
    if (composing.current || event.isComposing || event.keyCode === 229) return false;
    const element = input.current;
    const { mode: currentMode, editable: canEdit, onKeyAction, onHardwareKey, onSubmit, submitOnEnter } = latest.current;
    if (currentMode === 'live' && onHardwareKey) {
      if (canEdit !== false) flushLive();
      return onHardwareKey({ key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey, altGraphKey: event.altGraphKey });
    }
    if (canEdit === false) return false;
    const value = element?.value ?? '';
    if (event.key === 'Enter') {
      if (currentMode === 'line' && (submitOnEnter === false || event.shiftKey)) return false;
      if (currentMode === 'live') {
        flushLive();
        onKeyAction?.('enter');
      } else {
        onSubmit?.(value);
      }
      return true;
    }
    if (event.key === 'Backspace' && currentMode === 'live' && !value) {
      onKeyAction?.('backspace');
      return true;
    }
    if (currentMode !== 'line' || !onKeyAction) return false;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    // An empty command line has nothing to dismiss: Escape goes to the program, as in a terminal.
    if (event.key === 'Escape' && plain && !value) {
      onKeyAction('escape');
      return true;
    }
    // Ctrl+C (never ⌘C) interrupts unless it copies text selected in the field.
    const selected = element ? element.selectionStart !== element.selectionEnd : false;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === 'c' || event.key === 'C') && !selected) {
      onKeyAction('interrupt');
      return true;
    }
    return false;
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
      readOnly={editable === false}
      aria-readonly={editable === false}
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
        anchorComposition();
        report();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        releaseComposition();
        flushLive();
        report();
      }}
      onBlur={releaseComposition}
      onInput={() => {
        fitComposition();
        flushLive();
        report();
      }}
      onKeyDown={(event) => {
        // A window-level handler (the question card) already took this key.
        if (event.defaultPrevented) return;
        if (handleKey({ key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          altGraphKey: event.getModifierState('AltGraph'), isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
          event.preventDefault();
        }
      }}
    />
  );
});

export default TerminalInputView;
