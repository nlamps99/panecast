import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { Alert, AppState, Linking, Platform } from 'react-native';

import { appStore } from '../state/appStore';
import { backToWorkspaces, openSurface } from '../state/navigation';
import { NotificationController } from './controller';

/** The app's one notification controller, wired to the real app store and platform APIs. */
export const notifications = new NotificationController({
  os: Platform.OS,
  isDev: __DEV__,
  store: appStore,
  appState: AppState,
  storage: AsyncStorage,
  confirm: (title, message, buttons) => Alert.alert(title, message, buttons),
  openSettings: () => Linking.openSettings(),
  openSurface,
  openAgent: (sourceId, threadId) => router.navigate({ pathname: '/sources', params: { sourceId, threadId } }),
  navigate: (path) => (path === '/' ? backToWorkspaces() : router.navigate('/inbox')),
  log: (message) => {
    if (__DEV__) console.log(message);
  },
});
