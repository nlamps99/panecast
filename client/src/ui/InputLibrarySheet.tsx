import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { makeId, useInputLibrary, type InputEntry, type InputLibrary } from '../input/library';
import type { RpcChannel } from '../session/terminalSession';
import { Sheet } from './Sheet';
import { colors, fonts } from './theme';

type Props = { visible: boolean; onClose(): void; onClosed(): void; library: InputLibrary; workspaceId: string; draft: string; channel: RpcChannel; onInsert(text: string): void };
export function InputLibrarySheet({ visible, onClose, onClosed, library, workspaceId, draft, channel, onInsert }: Props) {
  const { entries, error } = useInputLibrary(library);
  const [filter, setFilter] = useState<'favorite' | 'recent' | 'project'>('favorite');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<InputEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const shown = entries.filter((e) => (filter === 'favorite' ? e.favorite : filter === 'project' ? e.workspaceId === workspaceId : true)
    && `${e.title}\n${e.text}`.toLowerCase().includes(query.trim().toLowerCase()));
  const importSnippets = async () => {
    try {
      const result = await channel.call<{ snippets?: { name?: string; title?: string; label?: string; text?: string }[] }>('relay.snippets');
      let count = 0;
      for (const e of result.snippets ?? []) {
        if (!e.text?.trim() || entries.some((old) => old.text === e.text)) continue;
        if (library.put({ id: makeId(), title: e.name ?? e.title ?? e.label ?? '', text: e.text, workspaceId: null, favorite: true, at: Date.now() })) count++;
      }
      setMessage(count ? `已导入 ${count} 条常用输入` : '电脑上没有新的常用输入');
    } catch { setMessage('电脑未提供常用输入，请升级 relay 后重试'); }
  };
  return (
    <Sheet visible={visible} title={editor ? '编辑常用输入' : '常用输入'} onClose={onClose} onClosed={onClosed}>
      <View style={s.body}>
        {error ? <Text style={s.muted}>{error}</Text> : null}
        {editor ? <Editor key={editor.id} entry={editor} onCancel={() => setEditor(null)} onSave={(entry) => { if (library.put(entry)) setEditor(null); }} /> : <>
          <View style={s.row}>{(['favorite', 'recent', 'project'] as const).map((f) => <Pressable key={f} style={[s.button, filter === f && s.active]} onPress={() => setFilter(f)} accessibilityRole="tab" accessibilityState={{ selected: filter === f }}><Text style={s.label}>{f === 'favorite' ? '收藏' : f === 'recent' ? '最近输入' : '当前项目'}</Text></Pressable>)}</View>
          <TextInput style={s.input} placeholder="搜索命令或提示词" placeholderTextColor={colors.muted} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} accessibilityLabel="搜索常用输入" />
          <View style={s.row}>
            <Pressable style={s.button} onPress={() => setEditor({ id: makeId(), title: '', text: draft, workspaceId, favorite: true, at: Date.now() })}><Text style={s.label}>＋ 新建</Text></Pressable>
            <Pressable style={s.button} onPress={() => void importSnippets()}><Text style={s.label}>从电脑导入</Text></Pressable>
            {filter === 'recent' ? <Pressable style={s.button} onPress={() => library.clearRecent()}><Text style={s.muted}>清除历史</Text></Pressable> : null}
          </View>
          {message ? <Text style={s.muted}>{message}</Text> : null}
          {!shown.length ? <Text style={s.empty}>还没有记录。可以新建常用输入，或从最近发送的内容中收藏。</Text> : null}
          {shown.map((e) => <View key={e.id} style={s.entry}>
            <Pressable onPress={() => onInsert(e.text)} style={s.grow} accessibilityRole="button" accessibilityLabel={`填入 ${e.title || e.text}`}>
              {e.title ? <Text style={s.label}>{e.title}</Text> : null}
              <Text style={s.code} numberOfLines={3}>{e.text}</Text>
            </Pressable>
            <View style={s.row}>
              <Pressable onPress={() => library.favorite(e.id)} style={s.small} accessibilityLabel={e.favorite ? '取消收藏' : '收藏'}><Text style={s.label}>{e.favorite ? '★' : '☆'}</Text></Pressable>
              <Pressable onPress={() => setEditor(e)} style={s.small}><Text style={s.muted}>编辑</Text></Pressable>
              <Pressable onPress={() => library.remove(e.id)} style={s.small}><Text style={s.muted}>删除</Text></Pressable>
            </View>
          </View>)}
          <Text style={s.muted}>点按填入输入框，编辑后再发送。记录仅保存在这台手机上。</Text>
        </>}
      </View>
    </Sheet>
  );
}
function Editor({ entry, onCancel, onSave }: { entry: InputEntry; onCancel(): void; onSave(entry: InputEntry): void }) {
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  return <View style={s.body}>
    <TextInput defaultValue={entry.title} onChangeText={setTitle} style={s.input} placeholder="名称（可选）" placeholderTextColor={colors.muted} accessibilityLabel="常用输入名称" />
    <TextInput defaultValue={entry.text} onChangeText={setText} style={[s.input, s.multiline]} multiline autoCapitalize="none" autoCorrect={false} placeholder="命令或提示词" placeholderTextColor={colors.muted} accessibilityLabel="常用输入内容" />
    <View style={s.row}><Pressable style={s.button} onPress={onCancel}><Text style={s.label}>取消</Text></Pressable><Pressable style={[s.button, s.active]} disabled={!text.trim()} onPress={() => onSave({ ...entry, title, text, favorite: true })}><Text style={s.label}>保存</Text></Pressable></View>
  </View>;
}
const s = StyleSheet.create({
  body: { padding: 14, gap: 12 }, row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, grow: { flex: 1 },
  button: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: colors.surfaceRaised }, active: { borderWidth: 1, borderColor: colors.green },
  label: { color: colors.ink, fontSize: 14 }, muted: { color: colors.muted, fontSize: 12 }, code: { color: colors.inkDim, fontFamily: fonts.mono, fontSize: 13, marginTop: 4 },
  input: { color: colors.ink, backgroundColor: colors.surfaceSunken, padding: 12, borderRadius: 8, fontSize: 14 }, multiline: { minHeight: 140, textAlignVertical: 'top' },
  entry: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider, paddingVertical: 10 }, small: { padding: 6 }, empty: { color: colors.muted, paddingVertical: 20, lineHeight: 21 },
});
