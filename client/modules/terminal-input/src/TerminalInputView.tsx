import { requireNativeView } from 'expo';
import { forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from 'react';

import type { TerminalInputHandle, TerminalInputKey, TerminalInputProps } from './TerminalInput.types';

type NativeEvent<T> = { nativeEvent: T };

type NativeProps = Omit<TerminalInputProps, 'onCommitText' | 'onKeyAction' | 'onChangeState' | 'onSubmit'> & {
  ref?: Ref<TerminalInputHandle>;
  onCommitText?: (event: NativeEvent<{ text: string }>) => void;
  onKeyAction?: (event: NativeEvent<{ key: TerminalInputKey }>) => void;
  onChangeState?: (event: NativeEvent<{ text: string; composing: boolean }>) => void;
  onSubmit?: (event: NativeEvent<{ text: string }>) => void;
};

const NativeView: ComponentType<NativeProps> = requireNativeView('TerminalInput');

const TerminalInputView = forwardRef<TerminalInputHandle, TerminalInputProps>(function TerminalInputView(
  { onCommitText, onKeyAction, onChangeState, onSubmit, ...rest },
  ref,
) {
  const nativeRef = useRef<TerminalInputHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: async () => nativeRef.current?.focus(),
    blur: async () => nativeRef.current?.blur(),
    clear: async () => nativeRef.current?.clear(),
  }));
  return (
    <NativeView
      {...rest}
      ref={nativeRef}
      onCommitText={onCommitText && ((e) => onCommitText(e.nativeEvent.text))}
      onKeyAction={onKeyAction && ((e) => onKeyAction(e.nativeEvent.key))}
      onChangeState={onChangeState && ((e) => onChangeState(e.nativeEvent))}
      onSubmit={onSubmit && ((e) => onSubmit(e.nativeEvent.text))}
    />
  );
});

export default TerminalInputView;
