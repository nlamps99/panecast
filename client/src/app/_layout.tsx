import { Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useNotificationRouting } from '../notifications/useNotificationRouting';
import { appStore } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { loadPrefs } from '../state/prefs';
import { loadTerminalFonts } from '../platform/fonts';
import { InboxToast } from '../ui/InboxToast';
import { useDesktopShell } from '../ui/desktopShell';
import { useDesktopMenu } from '../ui/useDesktopShortcuts';
import { colors } from '../ui/theme';

void SplashScreen.preventAutoHideAsync();

/**
 * Paired (or in the demo): the tabs. Otherwise the guard sends the stack to
 * the pairing screen, which is never guarded so it can also open as a modal
 * over the tabs to add or re-pair a computer. As the only screen (first run,
 * last computer removed) the native stack shows it full screen despite
 * `presentation: 'modal'`, and it replaces itself with the tabs once a
 * computer or the demo is ready.
 */
export default function RootLayout() {
  const { phase, machine } = useAppState();
  useNotificationRouting();
  // The Mac menu bar works on every screen, the pairing screen included.
  const shell = useDesktopShell();
  useDesktopMenu(phase === 'ready' ? machine : null, usePathname(), shell && phase === 'ready');

  useEffect(() => {
    void loadPrefs();
    void loadTerminalFonts();
    void appStore.load().then(async () => {
      if (__DEV__ && process.env.EXPO_PUBLIC_STORE_CAPTURE === '1') {
        const { prepareStoreCapture } = await import('../demo/storeCapture');
        prepareStoreCapture();
      }
    });
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS may have killed the socket while we were suspended.
      if (state === 'active') appStore.wake();
      else if (state === 'background') appStore.sleep();
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
        <Stack.Screen name="pair" options={{ presentation: 'modal' }} />
        <Stack.Screen name="account" />
      </Stack>
      {phase === 'ready' ? <InboxToast /> : null}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
});
