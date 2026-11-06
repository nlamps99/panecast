import type { StyleProp, ViewStyle } from 'react-native';

/**
 * - `line`: a command line. The field keeps its text; `onChangeState` reports
 *   it, `onSubmit` fires on Return (never while composing).
 * - `live`: every committed piece of text goes out through `onCommitText` and
 *   the field empties. Text still being composed by the input method stays in
 *   the field until it is committed.
 */
export type TerminalInputMode = 'line' | 'live';

export type TerminalInputKey = 'enter' | 'backspace';

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
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
  onCommitText?: (text: string) => void;
  onKeyAction?: (key: TerminalInputKey) => void;
  onChangeState?: (state: { text: string; composing: boolean }) => void;
  onSubmit?: (text: string) => void;
  /** Height in points the text needs, including the 8 pt top and bottom inset. Native only. */
  onContentSizeChange?: (height: number) => void;
};
