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

export type TerminalInputHandle = {
  focus(): Promise<void>;
  blur(): Promise<void>;
  clear(): Promise<void>;
};

export type TerminalInputProps = {
  mode: TerminalInputMode;
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
