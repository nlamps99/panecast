import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';

/**
 * Covers the status bar on a screen whose content scrolls under it, so the
 * clock and battery never sit on top of text. Place it after the ScrollView,
 * inside a container that fills the screen.
 */
export function StatusBarScrim() {
  const { top } = useSafeAreaInsets();
  if (top === 0) return null;
  return <View style={[styles.scrim, { height: top }]} />;
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: colors.canvas, pointerEvents: 'none' },
});
