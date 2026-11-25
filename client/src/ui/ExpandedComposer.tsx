import { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputSnapshot } from '../../modules/terminal-input';
import { indentSelection } from '../input/composerEdits';
import { MAX_INPUT_TEXT } from '../input/library';
import { stripSent } from '../input/sendRemainder';
import type { SendReceipt } from '../session/terminalSession';
import { colors, fonts } from './theme';

type Props = {
  initialText: string;
  title: string;
  connected: boolean;
  inputRef?: React.RefObject<TerminalInputHandle | null>;
  attachmentMessage?: string | null;
  uploading?: boolean;
  onChange(state: Pick<TerminalInputSnapshot, 'text' | 'composing'>): void;
  onSave(text: string): Promise<void>;
  onSend(text: string): Promise<SendReceipt | undefined>;
};

/** The same IME-aware input as the command bar; only its Return behavior changes. */
export function ExpandedComposer({ initialText, title, connected, inputRef, attachmentMessage, uploading = false, onChange, onSave, onSend }: Props) {
  const insets = useSafeAreaInsets();
  const input = useRef<TerminalInputHandle>(null);
  const locked = useRef(false);
  /** A sent text still waiting to be cut from the editor (the IME was composing). */
  const pendingClear = useRef<string | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState(initialText.length);
  const [message, setMessage] = useState<string | null>(null);
  const action = async (kind: 'save' | 'send' | 'indent' | 'outdent') => {
    if (locked.current) return;
    locked.current = true;
    try {
      const state = await input.current?.getState();
      if (!state || !mounted.current) return;
      if (state.composing) { setMessage('输入法还在选字，先选好再操作'); return; }
      if ((kind === 'save' || kind === 'send') && state.text.length > MAX_INPUT_TEXT) {
        setMessage(`最多 ${MAX_INPUT_TEXT.toLocaleString()} 个字符，请缩短后保存或发送`);
        return;
      }
      setBusy(true);
      if (kind === 'save') {
        await onSave(state.text);
      } else if (kind === 'send') {
        const result = await onSend(state.text);
        if (!mounted.current) return;
        if (result?.status === 'sent') {
          // Keep whatever was typed while the text was on its way; while the
          // IME is composing, the cut waits for the next change.
          const field = input.current;
          const now = await field?.getState();
          if (field && now) pendingClear.current = (await stripSent(field, state.text, now)) === 'pending' ? state.text : null;
        }
        setMessage(result?.message ?? '这次输入还没有发送');
      } else {
        const edit = indentSelection(state, kind === 'outdent');
        if (edit && !await input.current?.applyEdit(state.text, edit.text, edit.selectionStart, edit.selectionEnd)) {
          setMessage('输入发生了变化，请再试一次');
        } else setMessage(null);
        await input.current?.focus();
      }
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '操作失败，草稿已保留'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  // Ref callback cleanup is synchronous when the editor's native view goes away.
  const setInput = useCallback((value: TerminalInputHandle | null) => { input.current = value; if (inputRef) inputRef.current = value; mounted.current = value !== null; }, [inputRef]);
  return <Modal visible presentationStyle="fullScreen" animationType="slide" supportedOrientations={['portrait', 'portrait-upside-down', 'landscape']}
    onRequestClose={() => void action('save')} onShow={() => void input.current?.focus()}>
    <KeyboardAvoidingView nativeID="panecast-expanded-composer" style={styles.screen} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingLeft: insets.left + 14, paddingRight: insets.right + 14 }]}>
        <Pressable onPress={() => void action('save')} disabled={busy} accessibilityRole="button" accessibilityLabel="保存草稿并返回终端" style={styles.button}><Text style={styles.link}>保存并返回</Text></Pressable>
        <Text style={styles.title} numberOfLines={1}>{title || '编辑输入'}</Text>
        <Pressable onPress={() => void action('send')} disabled={busy || !connected || uploading} accessibilityRole="button" accessibilityLabel="发送完整输入到当前终端" hitSlop={4} style={[styles.send, (busy || !connected || uploading) && styles.dim]}><Text style={styles.sendText}>{busy ? '处理中…' : '发送'}</Text></Pressable>
      </View>
      <View style={[styles.tools, { paddingLeft: insets.left + 14, paddingRight: insets.right + 14 }]}>
        <Pressable onPress={() => void action('indent')} disabled={busy} style={styles.button} accessibilityRole="button" accessibilityLabel="所选行增加两个空格缩进"><Text style={styles.link}>增加缩进</Text></Pressable>
        <Pressable onPress={() => void action('outdent')} disabled={busy} style={styles.button} accessibilityRole="button" accessibilityLabel="所选行减少缩进"><Text style={styles.link}>减少缩进</Text></Pressable>
        <Text style={styles.note}>{size.toLocaleString()} 字符</Text>
      </View>
      <Text style={[styles.note, styles.hint]}>{size > MAX_INPUT_TEXT ? `内容超过 ${MAX_INPUT_TEXT.toLocaleString()} 个字符，当前编辑尚未保存；请缩短后保存。` : attachmentMessage ?? message ?? (connected ? '回车换行，发送按钮提交全部内容。草稿自动保存。' : '当前离线，可以继续编辑并保存草稿。')}</Text>
      <View style={[styles.editor, { marginLeft: insets.left + 14, marginRight: insets.right + 14, marginBottom: Math.max(insets.bottom, 12) }]}>
        {/* Stays editable while busy: an input that stops being editable drops the keyboard. `locked` blocks a second action. */}
        <TerminalInputView ref={setInput} mode="line" submitOnEnter={false} initialText={initialText}
          fontFamily={fonts.mono} fontSize={16} placeholder="输入命令或长提示词，回车换行" placeholderColor={colors.muted}
          textColor={colors.ink} caretColor={colors.green} style={styles.input}
          onChangeState={(state) => {
            setSize(state.text.length); onChange(state);
            const sent = pendingClear.current;
            const field = input.current;
            if (sent && field && !state.composing) void stripSent(field, sent, state).then((result) => { if (pendingClear.current === sent) pendingClear.current = result === 'pending' ? sent : null; });
          }} />
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8 },
  title: { flex: 1, textAlign: 'center', color: colors.ink, fontSize: 15, fontWeight: '600' }, button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  link: { color: colors.blue, fontSize: 13 }, tools: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' }, note: { color: colors.muted, fontSize: 12 },
  hint: { paddingHorizontal: 18, paddingBottom: 10, lineHeight: 18 }, editor: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.divider, backgroundColor: colors.surfaceSunken, borderRadius: 10, paddingHorizontal: 12 },
  input: { flex: 1, minHeight: 80 }, send: { backgroundColor: colors.green, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center', borderRadius: 8 }, sendText: { color: colors.canvas, fontSize: 14, fontWeight: '600' }, dim: { opacity: 0.45 },
});
