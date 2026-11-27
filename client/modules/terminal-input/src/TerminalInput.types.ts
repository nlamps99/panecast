import type { StyleProp, ViewStyle } from 'react-native';

/**
 * - `line`: a command line. The field keeps its text; `onChangeState` reports
 *   it, `onSubmit` fires on Return (never while composing).
 * - `live`: every committed piece of text goes out through `onCommitText` and
 *   the field empties. Text still being composed by the input method stays in
 *   the field until it is committed.
 */
export type TerminalInputMode = 'line' | 'live';

/**
 * Keys the field hands on instead of editing with: Return and Backspace on an
 * empty live field; on the web, Escape on an empty line field and Ctrl+C
 * (`interrupt`) with nothing selected in it.
 */
export type TerminalInputKey = 'enter' | 'backspace' | 'escape' | 'interrupt';

export type TerminalHardwareKey = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altGraphKey: boolean;
};

/** Where the input method should compose: the terminal cursor's cell, in window coordinates. */
export type TerminalImeAnchor = { left: number; top: number; height: number; background: string };

/** UTF-16 selection offsets, matching UITextView, Android Editable, and textarea. */
export type TerminalInputSnapshot = { text: string; composing: boolean; selectionStart: number; selectionEnd: number };

export type TerminalInputHandle = {
  focus(): Promise<void>;
  blur(): Promise<void>;
  clear(): Promise<void>;
  /**
   * Inserts text at the caret (replacing any selection) as if it had been
   * typed: `onChangeState` reports it in line mode, `onCommitText` sends it in
   * live mode. Text still being composed is committed first.
   */
  insertText(text: string): Promise<void>;
  /** Reads the native edit and composition state at the moment an action is pressed. */
  getState(): Promise<TerminalInputSnapshot>;
  /** Applies a selection edit only if text still matches and no input method is composing. */
  applyEdit(expectedText: string, text: string, selectionStart: number, selectionEnd: number): Promise<boolean>;
  /**
   * Web only: focuses the field and handles a key pressed while focus was
   * elsewhere as if it had been pressed in the field. Returns whether the key
   * was used. Synchronous, so the caller can still prevent the key's default.
   */
  pressKey?(event: TerminalHardwareKey): boolean;
};

export type TerminalInputProps = {
  mode: TerminalInputMode;
  /** Applied once when a new native view mounts; never controls ongoing composition. */
  initialText?: string;
  /** False in the expanded editor: Return inserts a newline, and the Send button submits. */
  submitOnEnter?: boolean;
  placeholder?: string;
  placeholderColor?: string;
  textColor?: string;
  caretColor?: string;
  fontFamily?: string;
  fontSize?: number;
  /** On the web a field that is not editable stays focusable (read-only), so typing resumes without a click. */
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
  onCommitText?: (text: string) => void;
  onKeyAction?: (key: TerminalInputKey) => void;
  /**
   * Web live input only. Return true when the remote terminal consumed the
   * key. Also asked while the field is not editable (offline), so a key the
   * terminal would take does not move focus out of it.
   */
  onHardwareKey?: (event: TerminalHardwareKey) => boolean;
  /**
   * Web live input only: while the input method composes, the field moves
   * here, so the composition and its candidate window appear at the terminal
   * cursor rather than at the bottom of the window. Null: it stays put.
   */
  imeAnchor?: () => TerminalImeAnchor | null;
  onChangeState?: (state: { text: string; composing: boolean }) => void;
  onSubmit?: (text: string) => void;
  /** Height in points the text needs, including the 8 pt top and bottom inset. Native only. */
  onContentSizeChange?: (height: number) => void;
};
