import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { appStore } from '../state/appStore';
import { colors } from '../ui/theme';

export default function RootLayout() {
  useEffect(() => {
    void appStore.load();
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS may have killed the socket while we were suspended.
      if (state === 'active') appStore.wake();
    });
    return () => subscription.remove();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }} />
    </>
  );
}
