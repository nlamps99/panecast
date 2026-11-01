import { Redirect } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useAppState } from '../state/hooks';
import { colors } from '../ui/theme';

export default function Index() {
  const { phase } = useAppState();
  if (phase === 'loading') return <View style={styles.blank} />;
  return <Redirect href={phase === 'paired' ? '/terminal' : '/pair'} />;
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: colors.canvas },
});
