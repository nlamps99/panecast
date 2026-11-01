import Constants from 'expo-constants';
import { Text, View } from 'react-native';

import { PROTOCOL_VERSION } from '../../protocol/frames';
import { Section, settingsStyles as s } from './Section';

export function AboutSection() {
  return (
    <Section title="关于">
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>Panecast</Text>
        <Text style={s.rowValue}>
          {Constants.expoConfig?.version ?? '0.1.0'} · 协议 v{PROTOCOL_VERSION}
        </Text>
      </View>
    </Section>
  );
}
