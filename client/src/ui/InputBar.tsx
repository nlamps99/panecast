import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputKey } from '../../modules/terminal-input';
import { encodeImage, pickImage, type ImageSource } from '../input/attachImage';
import {
  AttachmentError,
  attachmentFilename,
  base64Budget,
  decodedByteLength,
  formatBytes,
  parseUploadResult,
  pathInsertion,
  shellQuotePath,
  UPLOAD_TIMEOUT_MS,
  uploadParams,
  uploadTransportOf,
} from '../input/attachments';
import { translateCommitted } from '../input/translate';
import { Keys } from '../protocol/keys';
import { describeError, type TerminalSession } from '../session/terminalSession';
import { useMachine } from '../state/hooks';
import { setPrefs, usePrefs } from '../state/prefs';
import { KeyBar } from './KeyBar';
import { colors, fonts } from './theme';

const INPUT_FONT_SIZE = 15;
/** One line of GeistMono at 15 pt plus the native view's 8 pt top and bottom inset. */
const INPUT_MIN_HEIGHT = 36;
const INPUT_MAX_LINES = 4;
const INPUT_LINE_HEIGHT = Math.round(INPUT_FONT_SIZE * 1.3);
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * INPUT_MAX_LINES + 16;

/** The image attachment in progress, or why the last one failed. */
type AttachState = { kind: 'idle' } | { kind: 'busy'; label: string } | { kind: 'error'; message: string };

const ATTACH_IDLE: AttachState = { kind: 'idle' };

/** SF Symbol on iOS, Material Symbol on Android and the web. */
const ATTACH_ICON = { ios: 'photo.badge.plus', android: 'add_photo_alternate', web: 'add_photo_alternate' } as const;

type Props = {
  session: TerminalSession;
  disabled: boolean;
  /** A send failure from the session. */
  error: string | null;
  inputRef: React.RefObject<TerminalInputHandle | null>;
};

/**
 * The bottom of the terminal screen: a row of keys a phone keyboard lacks,
 * then the input. The input sits directly above the keyboard, the way chat
 * apps do; the keys are one row up and also work with the keyboard hidden,
 * which covers most TUI prompts (arrows, Enter, Esc).
 *
 * Command mode (`line`): edit a line, send it with Return or ↑.
 * Live mode: every committed character goes to the terminal as it is typed.
 * In both, text the input method is still composing is never sent.
 *
 * The photo button sends an image to the Mac (`file.upload`); the path the
 * relay saved it at goes into the command draft, or to the terminal in live
 * mode.
 */
export function InputBar({ session, disabled, error, inputRef }: Props) {
  const { inputMode: mode } = usePrefs();
  const { channel } = useMachine();
  const [hint, setHint] = useState<string | null>(null);
  const [hasText, setHasText] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [attach, setAttach] = useState<AttachState>(ATTACH_IDLE);
  const draft = useRef({ text: '', composing: false });
  const attaching = useRef(false);
  // An upload outlives the render that started it; read the mode when it lands.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const clearAttachError = () => setAttach((current) => (current.kind === 'error' ? ATTACH_IDLE : current));

  const submit = (text: string) => {
    if (draft.current.composing) {
      setHint('输入法还在选字，先选好再发送');
      return;
    }
    setHint(null);
    clearAttachError();
    session.submitLine(text.replace(/[\r\n]+$/, ''));
    draft.current = { text: '', composing: false };
    setHasText(false);
    void inputRef.current?.clear();
  };

  const sendCommitted = (text: string) => {
    for (const action of translateCommitted(text)) {
      if (action.kind === 'text') session.sendText(action.text);
      else session.sendKey(action.key);
    }
  };

  const sendKeyAction = (key: TerminalInputKey) => {
    session.sendKey(key === 'enter' ? Keys.enter : Keys.backspace);
  };

  const switchMode = (next: 'line' | 'live') => {
    if (next === mode) return;
    setHint(null);
    clearAttachError();
    setHasText(false);
    draft.current = { text: '', composing: false };
    setInputHeight(INPUT_MIN_HEIGHT);
    setPrefs({ inputMode: next });
  };

  /** Puts the uploaded file's Mac path where the user is typing. */
  const insertPath = async (path: string) => {
    if (modeRef.current === 'live') {
      session.sendText(`${shellQuotePath(path)} `);
      return;
    }
    const input = inputRef.current;
    if (!input) return;
    await input.insertText(pathInsertion(draft.current.text, path));
    void input.focus();
  };

  const attachFrom = async (source: ImageSource) => {
    if (attaching.current) return;
    if (!channel.isOpen) {
      setAttach({ kind: 'error', message: '还没有连上电脑，连上后再发图片' });
      return;
    }
    attaching.current = true;
    setHint(null);
    setAttach(ATTACH_IDLE);
    try {
      const uri = await pickImage(source);
      if (!uri) {
        setAttach(ATTACH_IDLE);
        return;
      }
      setAttach({ kind: 'busy', label: '正在压缩图片…' });
      const image = await encodeImage(uri, base64Budget(uploadTransportOf(channel)));
      if (!image) throw new AttachmentError('图片太大，压缩后还是发不了，换一张小一点的试试');
      setAttach({ kind: 'busy', label: `正在发送图片（${formatBytes(decodedByteLength(image.base64))}）…` });
      const params = uploadParams(attachmentFilename(new Date(), Platform.OS), image.base64);
      const uploaded = parseUploadResult(await channel.call('file.upload', params, UPLOAD_TIMEOUT_MS));
      try {
        await insertPath(uploaded.path);
        setAttach(ATTACH_IDLE);
      } catch {
        setAttach({ kind: 'error', message: `图片已存到电脑上的 ${uploaded.path}，但没能填进输入框` });
      }
    } catch (failure) {
      const message = failure instanceof AttachmentError ? failure.message : `图片没有发出去：${describeError(failure)}`;
      setAttach({ kind: 'error', message });
    } finally {
      attaching.current = false;
    }
  };

  /** Photo library or camera. The web has no camera choice. */
  const chooseImageSource = () => {
    if (attaching.current) return;
    if (Platform.OS === 'web') {
      void attachFrom('library');
      return;
    }
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['从相册选择', '拍照', '取消'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' },
        (index) => {
          if (index === 0) void attachFrom('library');
          else if (index === 1) void attachFrom('camera');
        },
      );
      return;
    }
    Alert.alert(
      '发送图片到电脑',
      undefined,
      [
        { text: '取消', style: 'cancel' },
        { text: '拍照', onPress: () => void attachFrom('camera') },
        { text: '从相册选择', onPress: () => void attachFrom('library') },
      ],
      { cancelable: true },
    );
  };

  // A hint about the current edit comes first, then the attachment, then the last send failure.
  let message: string | null = hint;
  let messageStyle: TextStyle = styles.messageHint;
  if (!message && attach.kind === 'busy') {
    message = attach.label;
    messageStyle = styles.messageBusy;
  } else if (!message && attach.kind === 'error') {
    message = attach.message;
    messageStyle = styles.messageError;
  } else if (!message && error) {
    message = error;
    messageStyle = styles.messageError;
  }
  const attachBusy = attach.kind === 'busy';
  const maxHeight = mode === 'line' ? INPUT_MAX_HEIGHT : INPUT_MIN_HEIGHT;

  return (
    <View>
      {message ? <Text style={[styles.message, messageStyle]}>{message}</Text> : null}
      <KeyBar session={session} />
      <View style={styles.row}>
        <View style={styles.segment} accessibilityRole="tablist">
          {(['line', 'live'] as const).map((item) => (
            <Pressable
              key={item}
              onPress={() => switchMode(item)}
              style={[styles.segmentItem, mode === item && styles.segmentItemActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === item }}
              accessibilityLabel={item === 'line' ? '命令输入：整行发送' : '逐字输入：打一个字发一个字'}
            >
              <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>
                {item === 'line' ? '命令' : '逐字'}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputBox}>
          <TerminalInputView
            ref={inputRef}
            mode={mode}
            editable={!disabled}
            placeholder={mode === 'live' ? '打字直接发到终端' : '输入命令'}
            placeholderColor={colors.muted}
            textColor={colors.ink}
            caretColor={colors.green}
            fontFamily={fonts.mono}
            fontSize={INPUT_FONT_SIZE}
            style={{ height: Math.min(maxHeight, Math.max(INPUT_MIN_HEIGHT, inputHeight)) }}
            onContentSizeChange={setInputHeight}
            onChangeState={(state) => {
              if (attach.kind === 'error' && state.text !== draft.current.text) clearAttachError();
              draft.current = state;
              const nextHasText = state.text.length > 0;
              if (nextHasText !== hasText) setHasText(nextHasText);
              if (hint && !state.composing) setHint(null);
            }}
            onSubmit={submit}
            onCommitText={sendCommitted}
            onKeyAction={sendKeyAction}
          />
        </View>
        <Pressable
          onPress={chooseImageSource}
          disabled={disabled || attachBusy}
          style={({ pressed }) => [styles.attach, disabled && styles.attachDisabled, pressed && styles.sendPressed]}
          accessibilityRole="button"
          accessibilityLabel="发送图片到电脑"
          accessibilityState={{ disabled: disabled || attachBusy, busy: attachBusy }}
          hitSlop={4}
        >
          {attachBusy ? (
            <ActivityIndicator size="small" color={colors.ink} />
          ) : (
            <SymbolView name={ATTACH_ICON} size={18} tintColor={colors.ink} weight="semibold" />
          )}
        </Pressable>
        {mode === 'line' ? (
          <Pressable
            onPress={() => submit(draft.current.text)}
            disabled={disabled}
            style={({ pressed }) => [styles.send, !hasText && styles.sendEmpty, pressed && styles.sendPressed]}
            accessibilityRole="button"
            accessibilityLabel={hasText ? '发送命令' : '发送回车'}
            hitSlop={6}
          >
            <Text style={[styles.sendText, !hasText && styles.sendTextEmpty]}>发送</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  message: { color: colors.yellow, fontSize: 12, paddingHorizontal: 14, paddingTop: 4 },
  messageHint: { color: colors.yellow },
  messageBusy: { color: colors.inkDim },
  messageError: { color: colors.red },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 2,
    paddingBottom: 6,
  },
  segment: {
    flexDirection: 'row',
    height: 36,
    padding: 3,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  segmentItem: { paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6 },
  segmentItemActive: { backgroundColor: colors.surfaceRaised },
  segmentText: { color: colors.muted, fontSize: 13 },
  segmentTextActive: { color: colors.green, fontWeight: '600' },
  inputBox: {
    flex: 1,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  send: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.green,
  },
  attach: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  attachDisabled: { opacity: 0.5 },
  sendEmpty: { backgroundColor: colors.surface },
  sendPressed: { opacity: 0.7 },
  sendText: { color: colors.canvas, fontSize: 14, fontWeight: '600' },
  sendTextEmpty: { color: colors.muted },
});
