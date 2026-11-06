import { Text, View } from 'react-native';

import { selectedKeyboardProfile, useKeyboardProfiles } from '../../input/keyboardProfiles';
import { useMachine, useStore } from '../../state/hooks';
import { KeyboardProfileEditor } from '../KeyboardProfileEditor';
import { useSheet } from '../Sheet';
import { ActionRow, Section, settingsStyles as s } from './Section';

export function KeyboardProfileSection() {
  const machine = useMachine();
  const { target } = useStore(machine.session);
  const profiles = useKeyboardProfiles();
  const sheet = useSheet();
  const computerId = machine.computer?.id ?? 'demo';
  const profile = selectedKeyboardProfile(profiles, computerId, target?.workspaceId);
  return <Section title="快捷键" footnote="可按电脑或项目选择配置。Ctrl + ↑ 始终保留，其他按键可增减和排序。">
    <View style={s.row}><Text style={[s.rowTitle, s.grow]}>当前配置</Text><Text style={s.rowValue}>{profile.name} · {profile.keys.length} 个键</Text></View>
    <ActionRow label="管理快捷键配置" onPress={sheet.open} />
    <KeyboardProfileEditor visible={sheet.visible} onClose={() => sheet.close()} onClosed={sheet.onClosed} computerId={computerId} workspaceId={target?.workspaceId ?? null} />
  </Section>;
}
