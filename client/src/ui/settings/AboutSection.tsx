import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Alert, Text, View } from 'react-native';

import { PROTOCOL_VERSION } from '../../protocol/frames';
import { ActionRow, Section, settingsStyles as s } from './Section';

function openHelp(page: 'support' | 'privacy'): void {
  void Linking.openURL(`https://github.com/nlamps99/panecast/blob/app-store-support/store/${page}.md`).catch(() => {
    Alert.alert('无法打开页面', '请检查网络连接后重试。');
  });
}

export function AboutSection() {
  return (
    <Section title="关于">
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>Panecast</Text>
        <Text style={s.rowValue}>
          {Constants.expoConfig?.version ?? '0.1.0'} · 协议 v{PROTOCOL_VERSION}
        </Text>
      </View>
      <ActionRow label="使用与帮助" onPress={() => openHelp('support')} />
      <ActionRow label="隐私政策" onPress={() => openHelp('privacy')} />
    </Section>
  );
}
