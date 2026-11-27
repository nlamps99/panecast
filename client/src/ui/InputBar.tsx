import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActionSheetIOS, ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { Alert } from '../platform/alert';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputKey } from '../../modules/terminal-input';
import { encodeImage, pickImage, type ImageSource } from '../input/attachImage';
import { uploadAttachments, type AttachmentFile } from '../input/fileAttachments';
import { pickFiles, useWebAttachments } from '../input/webAttachments';
import { terminalHardwareKey } from '../input/hardwareKeys';
import { refocusTerminalInput, terminalCursorAnchor } from '../input/terminalFocus';
import { desktopBridge, desktopOnWindows } from '../platform/desktop';
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
import { remainderAfterSend, stripSent } from '../input/sendRemainder';
import { translateCommitted } from '../input/translate';
import { draftKey, inputLibrary, MAX_INPUT_TEXT, useInputLibrary } from '../input/library';
import { Keys } from '../protocol/keys';
import { describeError, type SendReceipt, type TerminalSession } from '../session/terminalSession';
import { useConnectionStatus, useMachine } from '../state/hooks';
import { setPrefs, usePrefs } from '../state/prefs';
import { KeyBar, useKeyboardProfileEditor } from './KeyBar';
import { useKeyboardVisible } from './useKeyboardVisible';
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

/** How long a delivery note stays over the terminal. */
const DELIVERED_NOTE_MS = 1500;
/** The small links in the shortcut row keep their look but take a 44 pt touch. */
const LINK_SLOP = { top: 5, bottom: 5, left: 8, right: 8 };

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
  /** A short screen (a phone on its side): leave out the shortcut row so the terminal keeps its rows. */
  compactHeight?: boolean;
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
 *
 * Desktop live mode: a paste with line breaks reaches the program as one
 * paste (`terminal.paste`), and Shift+Enter as a pasted line break, so
 * neither submits line by line. Esc and Ctrl+C reach the terminal from an
 * empty command line too. Focus comes back to the input after a send, a
 * reconnect, a mode switch or a closed sheet.
 */
export function InputBar({ session, disabled, error, inputRef, presentation = 'terminal', onSubmitLine, compactHeight = false }: Props) {
  const { inputMode, desktopInputMode } = usePrefs();
  const desktop = desktopBridge() !== null;
  const chat = presentation === 'chat';
  const savedMode = desktop ? desktopInputMode : inputMode;
  // A snippet picked in live mode opens in the command line to be edited; this
  // terminal goes back to live mode once that line is sent or dismissed. The
  // saved mode never changes for it.
  const [snippetLine, setSnippetLine] = useState(false);
  const mode = chat || snippetLine ? 'line' : savedMode;
  const [keysOpen, setKeysOpen] = useState(false);
  const phoneKeys = !desktop && (!chat || keysOpen);
  const profileEditor = useKeyboardProfileEditor(session);
  // While a phone types, the keys and the input are all that stay below the terminal.
  const keyboardVisible = useKeyboardVisible();
  const { channel, computer } = useMachine();
  // The session's channel: subscribe, so the offline note and live typing follow reconnects.
  const connected = useConnectionStatus(channel).state === 'open';
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
  // Sending and delivery notes float above the input instead of taking a terminal row.
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasText, setHasText] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [attach, setAttach] = useState<AttachState>(ATTACH_IDLE);
  const draft = useRef({ text: '', composing: false });
  /** A sent line still waiting to be cut from the input (see `settleSent`). */
  const pendingClear = useRef<string | null>(null);
  const attaching = useRef(false);
  // An upload outlives the render that started it; read the mode when it lands.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  // Only the input part of the session: a send that answers quickly changes nothing here.
  const inputStatus = useSyncExternalStore(session.subscribe, () => session.getState().input, () => session.getState().input);

  /** Desktop: typing goes back to the input after a button, a sheet or a send. */
  const refocus = () => {
    if (desktop && mounted.current) refocusTerminalInput(inputRef.current);
  };
  // A new input (another terminal or mode) and a reconnect resume typing where it was.
  useEffect(() => {
    if (desktop && ready) refocusTerminalInput(inputRef.current);
  }, [desktop, ready, connected, inputRef]);

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

  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  const showNote = (text: string | null, duration?: number) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    setNote(text);
    if (text && duration) noteTimer.current = setTimeout(() => { noteTimer.current = null; if (mounted.current) setNote(null); }, duration);
  };

  /**
   * Takes what was sent out of the input, keeping anything typed while it was
   * on its way. While the IME is composing (or the text moved under the edit)
   * the cut waits for the next change, so the sent line is never left in
   * front of the new typing to be sent again.
   */
  const settleSent = async (sent: string, state: { text: string; composing: boolean }) => {
    const input = inputRef.current;
    if (!input || !mounted.current) return;
    const result = await stripSent(input, sent, state);
    pendingClear.current = result === 'pending' ? sent : null;
    if (result === 'done' && mounted.current) {
      const rest = state.text.slice(sent.length);
      draft.current = { text: rest, composing: false };
      setHasText(rest.length > 0);
    }
  };
  const clearSent = async (text: string) => {
    const now = await inputRef.current?.getState();
    if (now && mounted.current) await settleSent(text, now);
  };

  const clearAttachError = () => setAttach((current) => (current.kind === 'error' ? ATTACH_IDLE : current));

  const submit = async (text: string): Promise<SendReceipt | undefined> => {
    const current = session.getState().target;
    if (!mounted.current || !ready || disabled || !target || current?.workspaceId !== target.workspaceId || current.surfaceId !== target.surfaceId) return;
    if (sendingRef.current) { setHint('上一条还在发送，发完后再按一次发送'); return; }
    if (attaching.current) { setHint('附件正在上传，完成后再发送'); return; }
    if (draft.current.composing) {
      setHint('输入法还在选字，先选好再发送');
      return;
    }
    if (text.length > MAX_INPUT_TEXT) { setHint(`输入最多 ${MAX_INPUT_TEXT.toLocaleString()} 个字符，请缩短后发送`); return; }
    const line = text.replace(/[\r\n]+$/, '');
    if (chat && !line.trim()) return;
    setHint(null);
    clearAttachError();
    library.setDraft(savedKey, text);
    // The input stays editable and focused while a line is on its way, so the
    // keyboard stays up; `sendingRef` keeps a second Return from sending twice.
    sendingRef.current = true;
    setSending(true);
    // Chat bubbles carry their own receipts.
    if (!chat) showNote('正在发送…');
    let receipt: SendReceipt | undefined;
    try {
      receipt = await (onSubmitLine ? onSubmitLine(line) : session.submitLine(line));
      if (receipt.status === 'sent') {
        if (target) library.remember(line, target.workspaceId);
        // The saved draft may already hold typing that followed the line.
        const saved = library.getState().drafts[savedKey];
        if (saved !== undefined) { const rest = remainderAfterSend(saved, text); if (rest !== null) library.setDraft(savedKey, rest); }
        // Best effort: the line is already delivered, so a failed cut must not report a failed send.
        if (mounted.current && !expanded) await clearSent(text).catch(() => undefined);
      }
    } finally {
      sendingRef.current = false;
      if (mounted.current) { setSending(false); if (!receipt) showNote(null); }
    }
    if (mounted.current) {
      if (receipt.status === 'sent') showNote(chat ? null : receipt.message, DELIVERED_NOTE_MS);
      else { showNote(null); setHint(receipt.message); }
      // The snippet's line is sent: back to typing straight into the terminal.
      if (receipt.status === 'sent' && snippetLine && !expanded) leaveSnippetLine(true);
    }
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
    // After the editor's modal is gone.
    setTimeout(refocus, 0);
  };

  const submitCurrent = async () => {
    const state = await inputRef.current?.getState();
    if (!state || !mounted.current) return;
    draft.current = state;
    await submit(state.text);
  };

  const sendCommitted = (text: string) => {
    // Desktop live mode never puts a typed Return in the field, so a line
    // break there was pasted: it goes whole, instead of submitting each line.
    // (A phone keyboard may commit its Return as "\n", which stays Enter.)
    if (desktop && /[\r\n]/.test(text)) {
      void session.pasteText(text, translateCommitted(text));
      return;
    }
    for (const action of translateCommitted(text)) {
      if (action.kind === 'text') session.sendText(action.text);
      else session.sendKey(action.key);
    }
  };

  const sendKeyAction = (key: TerminalInputKey) => {
    // Esc on the snippet's emptied command line dismisses it instead.
    if (key === 'escape' && snippetLine) { leaveSnippetLine(true); return; }
    if (key === 'escape' || key === 'interrupt') {
      // From an empty command line or the chat box: Esc and Ctrl+C go to the program.
      if (disabled || !connected) { setHint('还没有连上电脑，按键没有发送'); return; }
      session.sendKey(key === 'escape' ? Keys.escape : Keys.ctrlC);
      return;
    }
    session.sendKey(key === 'enter' ? Keys.enter : Keys.backspace);
  };

  const resetEdit = () => {
    setHint(null);
    clearAttachError();
    setHasText(false);
    draft.current = { text: '', composing: false };
    setInputHeight(INPUT_MIN_HEIGHT);
  };

  /** Ends the snippet's command line; the field typed in keeps the keyboard (and focus) where it had them. */
  const leaveSnippetLine = (keepFocus: boolean) => {
    resetEdit();
    setSnippetLine(false);
    if (keepFocus) setTimeout(() => { if (!mounted.current) return; if (desktop) refocus(); else void inputRef.current?.focus(); }, 0);
  };

  const switchMode = (next: 'line' | 'live') => {
    if (next === mode) return;
    if (snippetLine) {
      // Leaving the snippet's command line is enough to be back in the saved mode.
      leaveSnippetLine(false);
      if (next === savedMode) return;
    } else resetEdit();
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
    } finally { attaching.current = false; refocus(); }
  };

  const dragging = useWebAttachments({
    enabled: ready && !disabled && !sending && attach.kind !== 'busy' && connected,
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
  } else if (!message && desktop && libraryState.error) {
    // The phone shows it in its shortcut row, which the desktop does not have.
    message = libraryState.error;
    messageStyle = styles.messageError;
  }
  const attachBusy = attach.kind === 'busy';
  const maxHeight = mode === 'line' ? INPUT_MAX_HEIGHT : INPUT_MIN_HEIGHT;
  // Typing waits behind a send the computer has not answered for a while; say so instead of going quiet.
  const shownNote = note ?? (inputStatus.busy ? '发送中…' : null);

  return (
    <View>
      {dragging ? <View style={{ padding: 14, borderWidth: 1, borderColor: colors.green, borderRadius: 10, backgroundColor: colors.surfaceRaised }}><Text style={{ color: colors.green, textAlign: 'center' }}>松开文件，上传到 {computer?.name ?? '当前电脑'}</Text></View> : null}
      {shownNote ? <View style={styles.noteWrap}><Text style={styles.note} accessibilityLiveRegion="polite">{shownNote}</Text></View> : null}
      {message ? <Text style={[styles.message, messageStyle]}>{message}</Text> : null}
      {/* Phones: a row of shortcuts above the input. Landscape hides it in terminal mode, whose keys sit outside it; chat mode keeps it for 终端按键. */}
      {!desktop && !(compactHeight && !chat) && !keyboardVisible ? <View style={[styles.libraryRow, styles.phoneLibraryRow]}>
        {chat ? <Pressable onPress={() => setKeysOpen(!keysOpen)} style={styles.libraryButton} hitSlop={LINK_SLOP} accessibilityRole="button" accessibilityState={{ expanded: keysOpen }}><Text style={styles.libraryText}>终端按键 {keysOpen ? '▴' : '▾'}</Text></Pressable> : null}
        <Pressable onPress={sheet.open} disabled={!ready} style={styles.libraryButton} hitSlop={LINK_SLOP} accessibilityRole="button"><Text style={styles.libraryText}>常用输入 · 最近输入</Text></Pressable>
        {mode === 'line' ? <Pressable onPress={() => void openExpanded().catch(() => setHint('暂时无法展开，请重试'))} disabled={!ready || sending || disabled || attachBusy} style={styles.libraryButton} hitSlop={LINK_SLOP} accessibilityRole="button" accessibilityLabel="全屏编辑长文本"><Text style={styles.libraryText}>展开编辑 ↗</Text></Pressable> : null}
        {libraryState.error ? <Text style={styles.messageError}>{libraryState.error}</Text> : null}
        {!connected ? <Text style={styles.libraryText}>离线 · 可以继续写草稿</Text> : null}
        {phoneKeys ? profileEditor.button : null}
      </View> : null}
      {phoneKeys ? <KeyBar session={session} disabled={disabled || !connected || sending} /> : null}
      {phoneKeys ? profileEditor.editor : null}
      <View style={styles.row}>
        {!chat && !desktop ? <View style={styles.segment} accessibilityRole="tablist">
          {(['line', 'live'] as const).map((item) => (
            <Pressable
              key={item}
              onPress={() => switchMode(item)}
              disabled={sending || !ready}
              style={[styles.segmentItem, mode === item && styles.segmentItemActive]}
              hitSlop={{ top: 4, bottom: 4 }}
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
            // A fresh field per mode, as when the saved mode changes (the whole bar is new then).
            key={mode}
            ref={inputRef}
            mode={mode}
            // Phones put newlines in chat messages and send with the button; desktops keep Enter to send, Shift-Enter for a newline.
            submitOnEnter={!chat || desktop}
            // Not tied to `sending`: a UITextView or EditText that stops being editable gives up focus and drops the keyboard.
            editable={!disabled && ready && (mode === 'line' || connected)}
            // The desktop has no shortcut row: the keys it takes are named here.
            placeholder={mode === 'line' && !connected ? '离线 · 可以先写草稿'
              : desktop ? (mode === 'live' ? (connected ? '直接操作终端 · 支持中文输入、Tab、方向键和 Ctrl 快捷键' : '离线 · 连上电脑后可以直接输入')
                : `${chat ? '发消息到当前终端' : '编辑命令'} · Enter 发送，Shift+Enter 换行`)
              : chat ? '发消息到当前终端…' : mode === 'live' ? '打字直接发到终端' : '输入命令'}
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
              if (pendingClear.current && !state.composing) void settleSent(pendingClear.current, state);
            }}
            onSubmit={(text) => void submit(text)}
            onCommitText={sendCommitted}
            onKeyAction={sendKeyAction}
            onHardwareKey={desktop && mode === 'live' ? event => {
              // No terminal, or one that is read-only: keys keep their usual meaning.
              if (disabled) return false;
              const key = terminalHardwareKey(event, { windows: desktopOnWindows(),
                selection: typeof window !== 'undefined' && window.getSelection()?.isCollapsed === false });
              if (!key) return false;
              // Taken even while it cannot go, so Tab and the arrows do not move focus away from the terminal.
              if (!connected) setHint('还没有连上电脑，按键没有发送');
              else if (ready && !sending) {
                // A line break in the prompt (Claude Code, Codex, a shell's continuation), as a paste; typed Enter where the computer cannot paste.
                if (key.name === 'enter' && key.modifiers?.length === 1 && key.modifiers[0] === 'shift') void session.pasteText('\n', [{ kind: 'key', key }]);
                else if (key.name === 'enter' && attaching.current) setHint('附件正在上传，完成后再发送');
                else session.sendKey(key);
              }
              return true;
            } : undefined}
            imeAnchor={desktop && mode === 'live' && !chat ? () => terminalCursorAnchor(colors.surfaceRaised) : undefined}
          />
        </View>
        {/* Desktop: the shortcuts sit in the input's own row instead of a row of their own. */}
        {desktop ? <View style={styles.desktopLinks}>
          <Pressable onPress={sheet.open} disabled={!ready} style={styles.desktopLink} accessibilityRole="button" accessibilityLabel="常用输入和最近输入"><Text style={styles.libraryText}>常用输入</Text></Pressable>
          {!chat ? <Pressable onPress={() => switchMode(mode === 'live' ? 'line' : 'live')} disabled={!ready || sending || attachBusy} style={styles.desktopLink} accessibilityRole="button"><Text style={styles.libraryText}>{mode === 'live' ? '编辑命令' : '直接输入'}</Text></Pressable> : null}
          {mode === 'line' ? <Pressable onPress={() => void openExpanded().catch(() => setHint('暂时无法展开，请重试'))} disabled={!ready || sending || disabled || attachBusy} style={styles.desktopLink} accessibilityRole="button" accessibilityLabel="全屏编辑长文本"><Text style={styles.libraryText}>展开 ↗</Text></Pressable> : null}
        </View> : null}
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
            onPress={() => void submitCurrent().catch(() => setHint('暂时无法发送，草稿已保留')).finally(refocus)}
            disabled={disabled || !ready || sending || attachBusy || (chat && !hasText)}
            // An empty command line sends Enter, so it says so instead of looking disabled.
            style={({ pressed }) => [styles.send, !hasText && (chat ? styles.sendEmpty : styles.sendEnter), pressed && styles.sendPressed]}
            accessibilityRole="button"
            accessibilityLabel={chat ? '发送消息到当前终端' : hasText ? '发送命令' : '发送回车'}
            hitSlop={6}
          >
            <Text style={[styles.sendText, !hasText && (chat ? styles.sendTextEmpty : styles.sendTextEnter)]}>{hasText || chat ? '发送' : '回车'}</Text>
          </Pressable>
        ) : null}
      </View>
      <InputLibrarySheet visible={sheet.visible} onClose={() => sheet.close(refocus)} onClosed={sheet.onClosed}
        library={library} workspaceId={target?.workspaceId ?? ''} draft={libraryState.drafts[savedKey] ?? ''} channel={channel}
        onInsert={(text) => sheet.close(() => {
          if (!mounted.current) return;
          if (mode === 'live') {
            // Into the command line to edit before sending, as the sheet says; live mode comes back after.
            library.setDraft(savedKey, text);
            resetEdit();
            setSnippetLine(true);
            setTimeout(refocus, 0);
          } else {
            void inputRef.current?.insertText(text);
            void inputRef.current?.focus();
          }
        })} />
      {expanded ? <ExpandedComposer initialText={expanded.text} title="编辑输入" connected={connected} inputRef={expandedInput}
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
  phoneLibraryRow: { justifyContent: 'flex-start', alignItems: 'center', columnGap: 16, paddingTop: 0 },
  libraryText: { color: colors.muted, fontSize: 12, paddingVertical: 4 },
  libraryButton: { minHeight: 34, justifyContent: 'center' },
  desktopLinks: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 2 },
  desktopLink: { height: 36, paddingHorizontal: 6, justifyContent: 'center', borderRadius: 6 },
  noteWrap: { position: 'absolute', right: 12, bottom: '100%', marginBottom: 6, pointerEvents: 'none' },
  note: { color: colors.inkDim, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surfaceRaised },
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
  sendEnter: { backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.green },
  sendTextEnter: { color: colors.green },
});
