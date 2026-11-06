import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { keyboardProfiles, projectKeyboardKey, selectedKeyboardProfile, SHORTCUTS, useKeyboardProfiles, type KeyboardProfile } from '../input/keyboardProfiles';
import { Sheet } from './Sheet';
import { colors } from './theme';

type Props = { visible: boolean; onClose(): void; onClosed?(): void; computerId: string; workspaceId: string | null };
export function KeyboardProfileEditor({ visible, onClose, onClosed, computerId, workspaceId }: Props) {
  const state = useKeyboardProfiles();
  return <Sheet visible={visible} title="快捷键配置" onClose={onClose} onClosed={onClosed}>
    <ProfileEditorBody key={`${computerId}:${workspaceId}`} computerId={computerId} workspaceId={workspaceId}
      initialProfile={selectedKeyboardProfile(state, computerId, workspaceId)} />
    {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
    {!state.loaded ? <Text style={styles.note}>正在读取配置…</Text> : null}
  </Sheet>;
}
function ProfileEditorBody({ computerId, workspaceId, initialProfile }: { computerId: string; workspaceId: string | null; initialProfile: KeyboardProfile }) {
  const state = useKeyboardProfiles(), store = keyboardProfiles();
  const [scope, setScope] = useState<'computer' | 'project'>(workspaceId ? 'project' : 'computer');
  const [editingId, setEditingId] = useState(initialProfile.id);
  const [query, setQuery] = useState('');
  const profile = state.profiles.find((p) => p.id === editingId) ?? state.profiles[0];
  const effective = selectedKeyboardProfile(state, computerId, scope === 'project' ? workspaceId : null);
  const inherited = scope === 'project' && workspaceId && !state.projects[projectKeyboardKey(computerId, workspaceId)];
  const apply = (id: string | null) => { store.select(computerId, scope === 'project' ? workspaceId : null, id); setEditingId(id ?? selectedKeyboardProfile(state, computerId, null).id); };
  const available = SHORTCUTS.filter((key) => !profile.keys.includes(key.id) && `${key.label} ${key.a11y}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <View style={styles.body}>
    <View style={styles.row}>
      <Chip label="这台电脑默认" selected={scope === 'computer'} onPress={() => { setScope('computer'); setEditingId(selectedKeyboardProfile(state, computerId).id); }} />
      {workspaceId ? <Chip label="当前项目" selected={scope === 'project'} onPress={() => { setScope('project'); setEditingId(selectedKeyboardProfile(state, computerId, workspaceId).id); }} /> : null}
    </View>
    <Text style={styles.note}>{scope === 'project' ? `当前项目使用：${effective.name}${inherited ? '（跟随电脑默认）' : ''}` : `这台电脑默认使用：${effective.name}`}</Text>
    <View style={styles.row}>
      {state.profiles.map((p) => <Chip key={p.id} label={p.name} selected={profile.id === p.id} disabled={!state.loaded} onPress={() => apply(p.id)} />)}
      {scope === 'project' ? <Chip label="跟随电脑默认" selected={Boolean(inherited)} disabled={!state.loaded} onPress={() => apply(null)} /> : null}
    </View>
    <View style={styles.row}>
      <Chip label="复制为新配置" disabled={!state.loaded} onPress={() => { const id = store.create(profile); if (id) apply(id); }} />
      {store.canRemove(profile.id)
        ? <Chip label="删除配置" disabled={!state.loaded} onPress={() => { store.remove(profile.id); setEditingId('default'); }} />
        : <Chip label="恢复这组默认键" disabled={!state.loaded} onPress={() => store.reset(profile.id)} />}
    </View>
    <ProfileName key={profile.id + profile.name} profile={profile} onSave={(name) => store.rename(profile.id, name)} />
    <Text style={styles.note}>修改配置会影响所有使用它的项目。需要单独调整时，先复制一份。按顺序左右滑动使用快捷键。</Text>
    {profile.keys.map((id, index) => {
      const key = SHORTCUTS.find((k) => k.id === id)!;
      return <View key={id} style={styles.keyRow}>
        <Text style={styles.number}>{index + 1}</Text><Text style={styles.keyName}>{key.a11y}</Text>
        <SmallButton label="↑" a11y={`将 ${key.a11y} 提前`} disabled={index === 0} onPress={() => store.move(profile.id, id, -1)} />
        <SmallButton label="↓" a11y={`将 ${key.a11y} 后移`} disabled={index === profile.keys.length - 1} onPress={() => store.move(profile.id, id, 1)} />
        <SmallButton label={id === 'ctrl-up' ? '保留' : '移除'} a11y={id === 'ctrl-up' ? 'Ctrl 上箭头为固定常用键' : `移除 ${key.a11y}`} disabled={id === 'ctrl-up'} onPress={() => store.removeKey(profile.id, id)} />
      </View>;
    })}
    <Text style={styles.title}>添加按键</Text>
    <TextInput style={styles.input} placeholder="搜索组合键，例如 Ctrl R" placeholderTextColor={colors.muted} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" accessibilityLabel="搜索可添加的快捷键" />
    <View style={styles.row}>{available.map((key) => <Chip key={key.id} label={key.a11y} disabled={!state.loaded} onPress={() => store.addKey(profile.id, key.id)} />)}</View>
  </View>;
}
function ProfileName({ profile, onSave }: { profile: KeyboardProfile; onSave(name: string): void }) {
  const [name, setName] = useState(profile.name);
  return <View style={styles.row}><TextInput defaultValue={profile.name} onChangeText={setName} maxLength={32} style={[styles.input, styles.grow]} accessibilityLabel="快捷键配置名称" onSubmitEditing={() => onSave(name)} /><SmallButton label="改名" a11y="保存配置名称" disabled={!name.trim() || name.trim() === profile.name} onPress={() => onSave(name)} /></View>;
}
function SmallButton({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled?: boolean; onPress(): void }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ disabled }} style={[styles.small, disabled && styles.dim]}><Text style={styles.label}>{label}</Text></Pressable>;
}
function Chip({ label, selected, disabled, onPress }: { label: string; selected?: boolean; disabled?: boolean; onPress(): void }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected, disabled }} style={[styles.chip, selected && styles.selected, disabled && styles.dim]}><Text style={styles.label}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  body: { padding: 14, gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }, grow: { flex: 1 },
  chip: { paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surfaceRaised }, selected: { borderColor: colors.green },
  label: { color: colors.ink, fontSize: 13 }, title: { color: colors.ink, fontSize: 15, fontWeight: '600' }, note: { color: colors.muted, fontSize: 12, lineHeight: 18 }, error: { color: colors.red, fontSize: 12, padding: 14 },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider, paddingVertical: 2 },
  number: { color: colors.muted, fontSize: 12, width: 18 }, keyName: { flex: 1, color: colors.ink, fontSize: 13 }, small: { minWidth: 38, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  dim: { opacity: 0.35 }, input: { color: colors.ink, backgroundColor: colors.surfaceSunken, padding: 10, borderRadius: 8, fontSize: 14, minWidth: 100 },
});
