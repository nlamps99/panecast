import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { appStore } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { loadPrefs } from '../state/prefs';
import { colors } from '../ui/theme';

void SplashScreen.preventAutoHideAsync();

/**
 * Paired (or in the demo): the tabs. Otherwise: the pairing screen. The
 * guards swap them when the pairing changes, dropping the other's history.
 */
export default function RootLayout() {
  const { phase } = useAppState();

  useEffect(() => {
    void loadPrefs();
    void appStore.load();
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS may have killed the socket while we were suspended.
      if (state === 'active') appStore.wake();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (phase !== 'loading') void SplashScreen.hideAsync();
  }, [phase]);

  // While SecureStore is read the splash stays up; `pair` is the route underneath.
  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
        <Stack.Protected guard={phase === 'ready'}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={phase !== 'ready'}>
          <Stack.Screen name="pair" />
        </Stack.Protected>
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
});
