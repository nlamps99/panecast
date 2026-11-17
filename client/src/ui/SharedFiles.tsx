import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as Clipboard from '../platform/clipboard';
import { desktopBridge } from '../platform/desktop';
import { formatSize, type SharedFile, type SharedFilesStore } from '../session/sharedFiles';
import { useStore } from '../state/hooks';
import { Sheet } from './Sheet';
import { colors, fonts } from './theme';

const KINDS: [RegExp, string, string][] = [
  [/\.pdf$/i, 'PDF', colors.red],
  [/\.(docx?|rtf|pages)$/i, 'Word', colors.blue],
  [/\.(xlsx?|csv|tsv|numbers)$/i, '表格', colors.green],
  [/\.(pptx?|key)$/i, 'PPT', colors.orange],
  [/\.(png|jpe?g|gif|webp|heic|svg)$/i, '图片', colors.magenta],
  [/\.(md|txt|tex|bib|json|ya?ml|py|js|ts|sh|log)$/i, '文本', colors.cyan],
];
function kind(name: string): [string, string] {
  const found = KINDS.find(([pattern]) => pattern.test(name));
  return found ? [found[1], found[2]] : ['文件', colors.inkDim];
}

function when(mtimeMs: number, now = Date.now()): string {
  const minutes = Math.floor((now - mtimeMs) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const date = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** In a browser, a window opened during the click survives the wait for the link. */
function openFile(store: SharedFilesStore, file: SharedFile): void {
  const placeholder = Platform.OS === 'web' && !desktopBridge() ? window.open('', '_blank') : null;
  void store.open(file, placeholder);
}

/** Recently changed files of the shared folder, above the input. Tapping one opens it with this computer's own apps. */
export function SharedFilesBar({ store, onShowAll }: { store: SharedFilesStore; onShowAll(): void }) {
  const { files, changed, busy, message, loaded, unsupported } = useStore(store);
  if (!loaded || unsupported) return null;
  return <View style={s.bar}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onShowAll} style={s.label} accessibilityRole="button" accessibilityLabel={`查看全部 ${files.length} 个文件`}>
        <Text style={s.labelText}>文件{files.length ? ` ${files.length}` : ''}</Text>
      </Pressable>
      {files.length === 0 ? <Text style={s.hint}>Claude 写出的文件会出现在这里，点一下就用这台电脑上的应用打开</Text> : null}
      {files.slice(0, 6).map((file) => {
        const [label, color] = kind(file.name);
        return <Pressable key={file.path} onPress={() => openFile(store, file)} disabled={busy !== null} style={({ pressed }) => [s.chip, changed[file.path] && s.chipChanged, pressed && s.pressed]}
          accessibilityRole="button" accessibilityLabel={`打开 ${file.name}`} accessibilityValue={changed[file.path] ? { text: '刚改过' } : undefined}>
          {busy === file.path ? <ActivityIndicator size="small" color={colors.green} style={s.spinner} /> : <Text style={[s.kind, { color }]}>{label}</Text>}
          <Text style={s.name} numberOfLines={1}>{file.name}</Text>
          {changed[file.path] ? <View style={s.dot} /> : null}
        </Pressable>;
      })}
    </ScrollView>
    {message ? <Pressable onPress={() => store.dismiss()} accessibilityRole="button" accessibilityLabel="关闭提示">
      <Text style={[s.message, message.error && s.error]} numberOfLines={2}>{message.text}</Text>
    </Pressable> : null}
  </View>;
}

/** Every file of the shared folder, newest first. */
export function SharedFilesSheet({ store, visible, onClose }: { store: SharedFilesStore; visible: boolean; onClose(): void }) {
  const { files, changed, busy, message, unsupported } = useStore(store);
  const copy = async (file: SharedFile) => {
    const link = await store.link(file);
    if (!link) return;
    try {
      if (await Clipboard.setStringAsync(link.url)) store.say(`已复制 ${file.name} 的下载链接，1 小时内有效`);
      else store.say('复制失败', true);
    } catch { store.say('复制失败', true); }
  };
  return <Sheet visible={visible} title="分享目录里的文件" onClose={onClose}>
    <View style={s.sheet}>
      {unsupported ? <Text style={s.note}>对方电脑上的 Panecast 还不支持发送文件，请对方升级后再试。</Text> : null}
      {message ? <Text style={[s.note, message.error && s.error]}>{message.text}</Text> : null}
      {!unsupported && files.length === 0 ? <Text style={s.note}>分享目录里还没有文件。</Text> : null}
      {files.map((file) => {
        const [label, color] = kind(file.name);
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
        return <View key={file.path} style={s.entry}>
          <Pressable style={s.entryMain} onPress={() => openFile(store, file)} disabled={busy !== null} accessibilityRole="button" accessibilityLabel={`打开 ${file.name}`}>
            {busy === file.path ? <ActivityIndicator size="small" color={colors.green} style={s.spinner} /> : <Text style={[s.kind, s.kindWide, { color }]}>{label}</Text>}
            <View style={s.entryText}>
              <Text style={s.entryName} numberOfLines={1}>{file.name}{changed[file.path] ? '  · 刚改过' : ''}</Text>
              <Text style={s.entryDetail} numberOfLines={1}>{[folder, formatSize(file.size), when(file.mtimeMs)].filter(Boolean).join(' · ')}</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => void copy(file)} disabled={busy !== null} style={s.copy} accessibilityRole="button" accessibilityLabel={`复制 ${file.name} 的下载链接`}>
            <Text style={s.copyText}>复制链接</Text>
          </Pressable>
        </View>;
      })}
      <Text style={s.note}>点文件会从对方电脑取回一份，用这台设备上的应用（WPS、预览、浏览器）打开。下载链接 1 小时内有效。</Text>
    </View>
  </Sheet>;
}

const s = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, paddingVertical: 6 },
  row: { alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  label: { paddingHorizontal: 6, paddingVertical: 4 },
  labelText: { color: colors.blue, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 220, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
  chipChanged: { borderColor: colors.green },
  pressed: { opacity: 0.6 },
  kind: { fontSize: 11, fontWeight: '700' },
  kindWide: { width: 34, textAlign: 'center' },
  spinner: { width: 34, transform: [{ scale: 0.7 }] },
  name: { color: colors.ink, fontSize: 13, flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  message: { color: colors.inkDim, fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
  error: { color: colors.red },
  sheet: { gap: 2, paddingBottom: 12 },
  note: { color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
  entry: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  entryMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  entryText: { flex: 1, minWidth: 0 },
  entryName: { color: colors.ink, fontSize: 14 },
  entryDetail: { color: colors.muted, fontSize: 12, fontFamily: fonts.mono, marginTop: 2 },
  copy: { paddingHorizontal: 10, paddingVertical: 8 },
  copyText: { color: colors.blue, fontSize: 12 },
});
