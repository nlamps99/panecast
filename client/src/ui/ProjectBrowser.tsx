import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { parseProjectFile, saveProjectFile, type ProjectFile } from '../input/saveProjectFile';
import { describeError, type RpcChannel, type SurfaceTarget } from '../session/terminalSession';
import { Sheet } from './Sheet';
import { colors, fonts } from './theme';

type Directory = { root: string; path: string; entries: { name: string; directory: boolean; size: number }[]; truncated?: boolean };
type Diff = { root: string; working: string; staged: string; truncated: boolean };
export function ProjectBrowser({ target, channel, onClose }: { target: SurfaceTarget; channel: RpcChannel; onClose(): void }) {
  const [tab, setTab] = useState<'files' | 'diff'>('files');
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const params = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
  const read = async (method: string, path = '') => {
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await channel.call(method, { ...params, path }, 20_000);
      if (token !== generation.current) return;
      if (method === 'project.list') { setDirectory(result as Directory); setFile(null); }
      else if (method === 'project.diff') setDiff(result as Diff);
      else setFile(parseProjectFile(result));
    } catch (failure) {
      if (token === generation.current) setError(`读取失败：${describeError(failure)}。此功能需要新版 relay。`);
    } finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => {
    const token = ++generation.current;
    void channel.call<Directory>('project.list', { workspace_id: target.workspaceId, surface_id: target.surfaceId, path: '' }, 20_000)
      .then((result) => { if (token === generation.current) setDirectory(result); })
      .catch((failure: unknown) => { if (token === generation.current) setError(`读取失败：${describeError(failure)}。此功能需要新版 relay。`); })
      .finally(() => { if (token === generation.current) setBusy(false); });
    return () => { generation.current = -1; };
  }, [channel, target.workspaceId, target.surfaceId]);
  const copy = async (text: string) => {
    try { if (!await Clipboard.setStringAsync(text)) setError('复制失败'); }
    catch { setError('复制失败'); }
  };
  return <Sheet visible title="项目文件与改动" onClose={onClose}>
    <View style={s.body}>
      <View style={s.row}>
        <Button label="文件" onPress={() => { setTab('files'); if (!directory) void read('project.list'); }} />
        <Button label="Git 改动" onPress={() => { setTab('diff'); void read('project.diff'); }} />
        <Button label="刷新" onPress={() => void read(tab === 'diff' ? 'project.diff' : 'project.list', directory?.path)} disabled={busy} />
      </View>
      <Text selectable style={s.note}>{tab === 'files' ? directory?.root : diff?.root}</Text>
      {busy ? <ActivityIndicator color={colors.green} /> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {tab === 'diff' && diff ? <>
        <Button label="复制差异" onPress={() => void copy(`未暂存\n${diff.working}\n已暂存\n${diff.staged}`)} />
        {diff.truncated ? <Text style={s.note}>差异过大，电脑只返回了部分内容。</Text> : null}
        <DiffText title="未暂存" text={diff.working} /><DiffText title="已暂存" text={diff.staged} />
      </> : null}
      {tab === 'files' && file ? <>
        <Button label="返回文件列表" onPress={() => setFile(null)} />
        <Text style={s.title}>{file.name} · {Math.ceil(file.size / 1024)} KB</Text>
        {['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime_type) ? <Image source={{ uri: `data:${file.mime_type};base64,${file.data_base64}` }} contentFit="contain" style={s.image} /> : null}
        {file.text !== undefined ? <><Button label="复制文件内容" onPress={() => void copy(file.text!)} /><Text selectable style={s.code}>{file.text.slice(0, 80_000)}</Text>{file.text.length > 80_000 ? <Text style={s.note}>预览显示前 80,000 个字符，保存可获取完整文件。</Text> : null}</> : <Text style={s.note}>可保存到手机，再使用对应应用打开。</Text>}
        <Button label="保存／分享文件" onPress={() => void saveProjectFile(file).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : '保存失败'))} />
      </> : tab === 'files' && directory ? <>
        <Text selectable style={s.title}>{directory.path || '/'}</Text>
        {directory.path ? <Button label="返回上级" onPress={() => void read('project.list', directory.path.split('/').slice(0, -1).join('/'))} /> : null}
        {directory.entries.map((entry) => <Pressable key={entry.name} disabled={busy} style={s.entry} onPress={() => void read(entry.directory ? 'project.list' : 'project.read', [directory.path, entry.name].filter(Boolean).join('/'))} accessibilityRole="button"><Text style={s.label}>{entry.directory ? '▸ ' : ''}{entry.name}</Text><Text style={s.note}>{entry.directory ? '文件夹' : `${Math.ceil(entry.size / 1024)} KB`}</Text></Pressable>)}
        {!directory.entries.length ? <Text style={s.note}>这个目录没有文件</Text> : null}
        {directory.truncated ? <Text style={s.note}>目录过大，仅显示前 500 项。</Text> : null}
      </> : null}
    </View>
  </Sheet>;
}
function DiffText({ title, text }: { title: string; text: string }) {
  return <View style={s.diff}><Text style={s.title}>{title}</Text><Text selectable style={s.code}>{text ? text.slice(0, 80_000).split('\n').map((line, i) => <Text key={i} style={line.startsWith('+') ? s.added : line.startsWith('-') ? s.removed : undefined}>{line}{'\n'}</Text>) : '没有改动'}</Text>{text.length > 80_000 ? <Text style={s.note}>预览已截断，可以复制完整返回内容。</Text> : null}</View>;
}
function Button({ label, onPress, disabled }: { label: string; onPress(): void; disabled?: boolean }) { return <Pressable style={s.button} onPress={onPress} disabled={disabled} accessibilityRole="button"><Text style={s.label}>{label}</Text></Pressable>; }
const s = StyleSheet.create({ body: { padding: 14, gap: 12 }, row: { flexDirection: 'row', gap: 8 }, button: { padding: 10, borderRadius: 8, backgroundColor: colors.surfaceRaised, alignSelf: 'flex-start' }, title: { color: colors.ink, fontSize: 14, fontWeight: '600' }, label: { color: colors.ink, fontSize: 13 }, note: { color: colors.muted, fontSize: 12 }, error: { color: colors.red, fontSize: 13 }, code: { color: colors.inkDim, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 }, entry: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider }, image: { width: '100%', height: 260 }, diff: { gap: 8 }, added: { color: colors.green }, removed: { color: colors.red } });
