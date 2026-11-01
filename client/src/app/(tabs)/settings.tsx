import { ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AboutSection } from '../../ui/settings/AboutSection';
import { useAppState } from '../../state/hooks';
import { ComputerSection } from '../../ui/settings/ComputerSection';
import { NotificationSection } from '../../ui/settings/NotificationSection';
import { TerminalSection } from '../../ui/settings/TerminalSection';
import { TransportPicker } from '../../ui/settings/TransportPicker';
import { colors } from '../../ui/theme';

/** Each section is its own component so features can grow independently. */
export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { machine } = useAppState();
  const computer = machine?.mode === 'relay' ? machine.computer : null;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
    >
      <Text style={styles.title}>设置</Text>
      <ComputerSection />
      {computer ? <TransportPicker computerId={computer.id} /> : null}
      <TerminalSection />
      <NotificationSection />
      <AboutSection />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: 24, gap: 22 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
});
