import { Redirect, router } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import { appStore } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { TerminalScreen } from '../ui/TerminalScreen';
import { colors } from '../ui/theme';

export default function TerminalRoute() {
  const { phase, connection, session } = useAppState();
  if (phase === 'unpaired') return <Redirect href="/pair" />;
  if (!connection || !session) return <View style={styles.blank} />;

  const repair = () => void appStore.unpair().then(() => router.replace('/pair'));
  const unpair = () => {
    Alert.alert('取消配对', '这台手机会忘记这台电脑，之后需要重新扫码。', [
      { text: '取消', style: 'cancel' },
      { text: '取消配对', style: 'destructive', onPress: repair },
    ]);
  };

  return <TerminalScreen channel={connection} session={session} leaveLabel="取消配对" onLeave={unpair} onRepair={repair} />;
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: colors.canvas },
});
