import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { Alert } from '../platform/alert';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputKey } from '../../modules/terminal-input';
import { encodeImage, pickImage, type ImageSource } from '../input/attachImage';
import { uploadAttachments, type AttachmentFile } from '../input/fileAttachments';
import { pickFiles, useWebAttachments } from '../input/webAttachments';
import { terminalHardwareKey } from '../input/hardwareKeys';
import { desktopBridge } from '../platform/desktop';
import {
  AttachmentError,
  attachmentFilename,
  base64Budget,
  decodedByteLength,
  formatBytes,
  parseRelayLimits,
  parseUploadResult,
  pathInsertion,
  shellQuotePath,
  UPLOAD_TIMEOUT_MS,
  uploadParams,
  uploadTransportOf,
} from '../input/attachments';
import { translateCommitted } from '../input/translate';
import { draftKey, inputLibrary, MAX_INPUT_TEXT, useInputLibrary } from '../input/library';
import { Keys } from '../protocol/keys';
import { describeError, type SendReceipt, type TerminalSession } from '../session/terminalSession';
import { useMachine } from '../state/hooks';
import { setPrefs, usePrefs } from '../state/prefs';
import { KeyBar } from './KeyBar';
import { InputLibrarySheet } from './InputLibrarySheet';
import { useSheet } from './Sheet';
import { colors, fonts } from './theme';
import { ExpandedComposer } from './ExpandedComposer';

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
const ATTACH_ICON = { ios: 'photo.badge.plus', android: 'add_photo_alternate', web: 'attach_file' } as const;

type Props = {
  session: TerminalSession;
  disabled: boolean;
  /** A send failure from the session. */
  error: string | null;
  inputRef: React.RefObject<TerminalInputHandle | null>;
  presentation?: 'terminal' | 'chat';
  onSubmitLine?: (text: string) => Promise<SendReceipt>;
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
export function InputBar({ session, disabled, error, inputRef, presentation = 'terminal', onSubmitLine }: Props) {
  const { inputMode, desktopInputMode } = usePrefs();
  const desktop = desktopBridge() !== null;
  const chat = presentation === 'chat';
  const mode = chat ? 'line' : desktop ? desktopInputMode : inputMode;
  const [keysOpen, setKeysOpen] = useState(false);
  const { channel, computer } = useMachine();
  const target = session.getState().target;
  const library = inputLibrary(computer?.id ?? 'demo');
  const libraryState = useInputLibrary(library);
  const savedKey = target ? draftKey(target.workspaceId, target.surfaceId) : '';
  const sheet = useSheet();
  const [expanded, setExpanded] = useState<{ text: string } | null>(null);
  const expandedInput = useRef<TerminalInputHandle>(null);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const restoring = useRef(true);
  const mounted = useRef(true);
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

  useEffect(() => {
    mounted.current = true;
    void library.load().then(async () => {
      if (!mounted.current) return;
      const text = library.getState().drafts[savedKey] ?? '';
      if (mode === 'line' && text) {
        await inputRef.current?.insertText(text);
        if (!mounted.current) return;
        draft.current = { text, composing: false };
        setHasText(true);
      }
      restoring.current = false;
      setReady(true);
    });
    return () => { mounted.current = false; };
  }, [library, savedKey, mode, inputRef]);

  const clearAttachError = () => setAttach((current) => (current.kind === 'error' ? ATTACH_IDLE : current));

  const submit = async (text: string): Promise<SendReceipt | undefined> => {
    const current = session.getState().target;
    if (!mounted.current || !ready || sendingRef.current || disabled || !target || current?.workspaceId !== target.workspaceId || current.surfaceId !== target.surfaceId) return;
    if (attaching.current) { setHint('附件正在上传，完成后再发送'); return; }
    if (draft.current.composing) {
      setHint('输入法还在选字，先选好再发送');
      return;
    }
    if (text.length > MAX_INPUT_TEXT) { setHint(`输入最多 ${MAX_INPUT_TEXT.toLocaleString()} 个字符，请缩短后发送`); return; }
    setHint('正在发送…');
    clearAttachError();
    const line = text.replace(/[\r\n]+$/, '');
    if (chat && !line.trim()) { setHint(null); return; }
    library.setDraft(savedKey, text);
    sendingRef.current = true;
    setSending(true);
    const receipt = await (onSubmitLine ? onSubmitLine(line) : session.submitLine(line));
    if (receipt.status === 'sent') {
      if (target) library.remember(line, target.workspaceId);
      if (library.getState().drafts[savedKey] === text) library.setDraft(savedKey, '');
      if (mounted.current && !expanded) {
        draft.current = { text: '', composing: false };
        setHasText(false);
        await inputRef.current?.clear();
      }
    }
    sendingRef.current = false;
    if (mounted.current) { setSending(false); setHint(receipt.message); }
    return receipt;
  };

  const openExpanded = async () => {
    if (!ready || sendingRef.current || mode !== 'line') return;
    const state = await inputRef.current?.getState();
    if (!state || !mounted.current) return;
    if (state.composing) { setHint('输入法还在选字，先选好再展开'); return; }
    library.setDraft(savedKey, state.text);
    await inputRef.current?.blur();
    if (mounted.current) setExpanded({ text: state.text });
  };

  const saveExpanded = async (text: string) => {
    if (!mounted.current) return;
    library.setDraft(savedKey, text);
    const compact = await inputRef.current?.getState();
    if (!compact || !mounted.current) return;
    const restored = await inputRef.current?.applyEdit(compact.text, text, text.length, text.length);
    if (!restored) throw new Error('没能恢复输入框，草稿已保留，请重试');
    draft.current = { text, composing: false };
    setHasText(text.length > 0);
    setExpanded(null);
  };

  const submitCurrent = async () => {
    const state = await inputRef.current?.getState();
    if (!state || !mounted.current) return;
    draft.current = state;
    await submit(state.text);
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
    setPrefs(desktop ? { desktopInputMode: next } : { inputMode: next });
  };

  /** Puts the uploaded file's Mac path where the user is typing. */
  const insertPath = async (path: string) => {
    const current = session.getState().target;
    if (!mounted.current || current?.workspaceId !== target?.workspaceId || current?.surfaceId !== target?.surfaceId) {
      library.setDraft(savedKey, (library.getState().drafts[savedKey] ?? '') + pathInsertion(library.getState().drafts[savedKey] ?? '', path));
      return;
    }
    if (modeRef.current === 'live') {
      session.sendText(`${shellQuotePath(path)} `);
      return;
    }
    const input = expandedInput.current ?? inputRef.current;
    if (!input) return;
    const state = await input.getState();
    await input.insertText(pathInsertion(state.text.slice(0, state.selectionStart), path));
    void input.focus();
  };

  const attachFiles = async (files: AttachmentFile[]) => {
    if (!files.length || !mounted.current || !ready || disabled || sendingRef.current || !target) return;
    if (attaching.current) { setHint('正在上传附件，请稍候再添加'); return; }
    if (!channel.isOpen) { setAttach({ kind: 'error', message: '还没有连上电脑，连上后再上传文件' }); return; }
    attaching.current = true; setHint(null); setAttach({ kind: 'busy', label: '正在准备附件…' });
    try {
      const count = await uploadAttachments(channel, target, files, {
        current: () => mounted.current,
        progress: label => { if (mounted.current) setAttach({ kind: 'busy', label }); },
        uploaded: async file => {
          try { await insertPath(file.path); }
          catch { throw new AttachmentError(`文件已存到电脑上的 ${file.path}，但没能填进输入框`); }
        },
      });
      if (mounted.current) { setAttach(ATTACH_IDLE); setHint(count ? `已上传 ${count} 个附件，${modeRef.current === 'live' ? '路径已写入终端，按 Enter 提交' : '路径已填入输入框'}` : null); }
    } catch (failure) {
      if (mounted.current) setAttach({ kind: 'error', message: failure instanceof AttachmentError ? failure.message : `文件没有发出去：${describeError(failure)}` });
    } finally { attaching.current = false; }
  };

  const dragging = useWebAttachments({
    enabled: ready && !disabled && !sending && attach.kind !== 'busy' && channel.isOpen,
    files: files => { void attachFiles(files); },
    error: message => { if (attaching.current) setHint(message); else setAttach({ kind: 'error', message }); },
  });

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
      // Newer relays say how large a message they take; older ones fail the call.
      const limits = parseRelayLimits(await channel.call('relay.info', target ? { workspace_id: target.workspaceId, surface_id: target.surfaceId } : {}, 5_000).catch(() => null));
      const image = await encodeImage(uri, base64Budget(uploadTransportOf(channel), limits));
      if (!image) throw new AttachmentError('图片太大，压缩后还是发不了，换一张小一点的试试');
      setAttach({ kind: 'busy', label: `正在发送图片（${formatBytes(decodedByteLength(image.base64))}）…` });
      const params = uploadParams(attachmentFilename(new Date(), Platform.OS), image.base64);
      const uploaded = parseUploadResult(await channel.call('file.upload', { ...params,
        ...(target ? { workspace_id: target.workspaceId, surface_id: target.surfaceId } : {}),
      }, UPLOAD_TIMEOUT_MS));
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
      void pickFiles().then(attachFiles).catch(failure => setAttach({ kind: 'error', message: describeError(failure) }));
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
      {dragging ? <View style={{ padding: 14, borderWidth: 1, borderColor: colors.green, borderRadius: 10, backgroundColor: colors.surfaceRaised }}><Text style={{ color: colors.green, textAlign: 'center' }}>松开文件，上传到 {computer?.name ?? '当前电脑'}</Text></View> : null}
      {message ? <Text style={[styles.message, messageStyle]}>{message}</Text> : null}
      <View style={styles.libraryRow}>
        {desktop ? <Text style={styles.libraryText}>{mode === 'live' ? '直接输入 · Tab、方向键、Ctrl 快捷键' : 'Enter 发送 · Shift+Enter 换行'}</Text> : null}
        {chat && !desktop ? <Pressable onPress={() => setKeysOpen(!keysOpen)} accessibilityRole="button" accessibilityState={{ expanded: keysOpen }}><Text style={styles.libraryText}>终端按键 {keysOpen ? '▴' : '▾'}</Text></Pressable> : null}
        <Pressable onPress={sheet.open} disabled={!ready} accessibilityRole="button"><Text style={styles.libraryText}>常用输入 · 最近输入</Text></Pressable>
        {desktop && !chat ? <Pressable onPress={() => switchMode(mode === 'live' ? 'line' : 'live')} disabled={!ready || sending || attachBusy} accessibilityRole="button"><Text style={styles.libraryText}>{mode === 'live' ? '编辑命令' : '直接输入'}</Text></Pressable> : null}
        {mode === 'line' ? <Pressable onPress={() => void openExpanded().catch(() => setHint('暂时无法展开，请重试'))} disabled={!ready || sending || disabled || attachBusy} accessibilityRole="button" accessibilityLabel="全屏编辑长文本"><Text style={styles.libraryText}>展开编辑 ↗</Text></Pressable> : null}
        {libraryState.error ? <Text style={styles.messageError}>{libraryState.error}</Text> : null}
        {!session.isConnected ? <Text style={styles.libraryText}>离线 · 可以继续写草稿</Text> : null}
      </View>
      {!desktop && (!chat || keysOpen) ? <KeyBar session={session} disabled={disabled || !session.isConnected || sending} /> : null}
      <View style={styles.row}>
        {!chat && !desktop ? <View style={styles.segment} accessibilityRole="tablist">
          {(['line', 'live'] as const).map((item) => (
            <Pressable
              key={item}
              onPress={() => switchMode(item)}
              disabled={sending || !ready}
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
        </View> : null}
        <View style={styles.inputBox}>
          <TerminalInputView
            ref={inputRef}
            mode={mode}
            editable={!disabled && ready && !sending && (mode === 'line' || session.isConnected)}
            placeholder={chat ? '发消息到当前终端…' : mode === 'live' ? desktop ? '直接操作终端，支持中文输入…' : '打字直接发到终端' : '输入命令'}
            placeholderColor={colors.muted}
            textColor={colors.ink}
            caretColor={colors.green}
            fontFamily={fonts.mono}
            fontSize={INPUT_FONT_SIZE}
            style={{ height: Math.min(maxHeight, Math.max(INPUT_MIN_HEIGHT, inputHeight)) }}
            onContentSizeChange={setInputHeight}
            onChangeState={(state) => {
              if (!mounted.current) return;
              if (attach.kind === 'error' && state.text !== draft.current.text) clearAttachError();
              draft.current = state;
              if (!restoring.current && mode === 'line' && !state.composing) library.setDraft(savedKey, state.text);
              const nextHasText = state.text.length > 0;
              if (nextHasText !== hasText) setHasText(nextHasText);
              if (hint && !state.composing) setHint(null);
            }}
            onSubmit={(text) => void submit(text)}
            onCommitText={sendCommitted}
            onKeyAction={sendKeyAction}
            onHardwareKey={desktop && mode === 'live' ? event => {
              const key = terminalHardwareKey(event);
              if (!key) return false;
              if (!disabled && ready && !sending && session.isConnected) {
                if (key.name === 'enter' && attaching.current) setHint('附件正在上传，完成后再发送');
                else session.sendKey(key);
              }
              return true;
            } : undefined}
          />
        </View>
        <Pressable
          onPress={chooseImageSource}
          disabled={disabled || attachBusy || sending || !ready}
          style={({ pressed }) => [styles.attach, disabled && styles.attachDisabled, pressed && styles.sendPressed]}
          accessibilityRole="button"
          accessibilityLabel={Platform.OS === 'web' ? '上传文件或图片到电脑' : '发送图片到电脑'}
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
            onPress={() => void submitCurrent().catch(() => setHint('暂时无法发送，草稿已保留'))}
            disabled={disabled || !ready || sending || attachBusy || (chat && !hasText)}
            style={({ pressed }) => [styles.send, !hasText && styles.sendEmpty, pressed && styles.sendPressed]}
            accessibilityRole="button"
            accessibilityLabel={chat ? '发送消息到当前终端' : hasText ? '发送命令' : '发送回车'}
            hitSlop={6}
          >
            <Text style={[styles.sendText, !hasText && styles.sendTextEmpty]}>发送</Text>
          </Pressable>
        ) : null}
      </View>
      <InputLibrarySheet visible={sheet.visible} onClose={() => sheet.close()} onClosed={sheet.onClosed}
        library={library} workspaceId={target?.workspaceId ?? ''} draft={libraryState.drafts[savedKey] ?? ''} channel={channel}
        onInsert={(text) => sheet.close(() => {
          if (!mounted.current) return;
          if (mode === 'live') {
            library.setDraft(savedKey, text);
            setPrefs(desktop ? { desktopInputMode: 'line' } : { inputMode: 'line' });
          } else {
            void inputRef.current?.insertText(text);
            void inputRef.current?.focus();
          }
        })} />
      {expanded ? <ExpandedComposer initialText={expanded.text} title="编辑输入" connected={session.isConnected} inputRef={expandedInput}
        uploading={attachBusy} attachmentMessage={dragging ? `松开文件，上传到 ${computer?.name ?? '当前电脑'}` : message}
        onChange={(state) => {
          if (!mounted.current) return;
          draft.current = state;
          if (!state.composing) library.setDraft(savedKey, state.text);
        }} onSave={saveExpanded} onSend={submit} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  libraryRow: { paddingHorizontal: 12, paddingTop: 4, flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  libraryText: { color: colors.muted, fontSize: 12, paddingVertical: 4 },
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
