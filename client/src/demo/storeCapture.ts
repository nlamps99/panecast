import { LogBox, Platform } from 'react-native';
import { router } from 'expo-router';

import { appStore } from '../state/appStore';
import { setPrefs } from '../state/prefs';

/** Opt-in simulator fixture. The caller excludes this path from production builds. */
export function prepareStoreCapture(): void {
  LogBox.ignoreAllLogs();
  setPrefs({ fontSize: Platform.OS === 'ios' && Platform.isPad ? 20 : 13, extraKeyRow: true });
  appStore.enterDemo();
  const machine = appStore.getState().machine;
  if (machine?.mode !== 'demo') return;
  machine.session.setTarget({ workspaceId: 'demo-ws-1', surfaceId: 'demo-sf-1' });
  machine.session.submitLine('clear');
  machine.session.submitLine('ls');
  machine.session.submitLine('pwd');
  machine.session.submitLine('echo 让终端跟上你的节奏');
  machine.session.submitLine('help');
  machine.session.submitLine('cat README.md');
  machine.session.submitLine('./scripts/check');
  const scene = process.env.EXPO_PUBLIC_STORE_SCENE;
  setTimeout(() => {
    if (scene === 'terminal') router.replace('/terminal');
    else if (scene === 'inbox') router.replace('/inbox');
    else if (scene === 'settings') router.replace('/settings');
    else router.replace('/');
  }, 500);
  setTimeout(() => {
    console.info(`[store-capture] ready:${scene ?? 'workspaces'}:${Platform.OS === 'ios' && Platform.isPad ? 'ipad' : 'iphone'}`);
  }, 14000);
}
