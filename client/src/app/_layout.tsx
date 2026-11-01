import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { appStore } from '../state/appStore';
import { loadPrefs } from '../state/prefs';
import { colors } from '../ui/theme';

export default function RootLayout() {
  useEffect(() => {
    void loadPrefs();
    void appStore.load();
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS may have killed the socket while we were suspended.
      if (state === 'active') appStore.wake();
    });
    return () => subscription.remove();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }} />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
});
