import { requireNativeView } from 'expo';
import { forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from 'react';

import type { TerminalInputHandle, TerminalInputKey, TerminalInputProps } from './TerminalInput.types';

type NativeEvent<T> = { nativeEvent: T };

type NativeProps = Omit<
  TerminalInputProps,
  'onCommitText' | 'onKeyAction' | 'onHardwareKey' | 'onChangeState' | 'onSubmit' | 'onContentSizeChange'
> & {
  ref?: Ref<TerminalInputHandle>;
  onCommitText?: (event: NativeEvent<{ text: string }>) => void;
  onKeyAction?: (event: NativeEvent<{ key: TerminalInputKey }>) => void;
  onChangeState?: (event: NativeEvent<{ text: string; composing: boolean }>) => void;
  onSubmit?: (event: NativeEvent<{ text: string }>) => void;
  onContentSizeChange?: (event: NativeEvent<{ height: number }>) => void;
};

const NativeView: ComponentType<NativeProps> = requireNativeView('TerminalInput');

const TerminalInputView = forwardRef<TerminalInputHandle, TerminalInputProps>(function TerminalInputView(
  { onCommitText, onKeyAction, onHardwareKey: _onHardwareKey, onChangeState, onSubmit, onContentSizeChange, ...rest },
  ref,
) {
  const nativeRef = useRef<TerminalInputHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: async () => nativeRef.current?.focus(),
    blur: async () => nativeRef.current?.blur(),
    clear: async () => nativeRef.current?.clear(),
    insertText: async (text: string) => nativeRef.current?.insertText(text),
    getState: async () => nativeRef.current?.getState() ?? { text: '', composing: false, selectionStart: 0, selectionEnd: 0 },
    applyEdit: async (expectedText, text, start, end) => nativeRef.current?.applyEdit(expectedText, text, start, end) ?? false,
  }));
  return (
    <NativeView
      {...rest}
      ref={nativeRef}
      onCommitText={onCommitText && ((e) => onCommitText(e.nativeEvent.text))}
      onKeyAction={onKeyAction && ((e) => onKeyAction(e.nativeEvent.key))}
      onChangeState={onChangeState && ((e) => onChangeState(e.nativeEvent))}
      onSubmit={onSubmit && ((e) => onSubmit(e.nativeEvent.text))}
      onContentSizeChange={onContentSizeChange && ((e) => onContentSizeChange(e.nativeEvent.height))}
    />
  );
});

export default TerminalInputView;
