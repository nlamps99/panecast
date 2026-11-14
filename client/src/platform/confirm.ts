import { Alert, Platform } from 'react-native';
import { desktopBridge } from './desktop';

/** Resolve only an explicit confirmation; cancellation and dismissal are false. */
export function confirmClose(title: string, message: string): Promise<boolean> {
  const desktop = desktopBridge();
  if (desktop) return desktop.dialog({ title, message, buttons: ['取消', '关闭'], cancelId: 0 })
    .then(index => index === 1, () => false);
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise(resolve => Alert.alert(title, message, [
    { text: '取消', style: 'cancel', onPress: () => resolve(false) },
    { text: '关闭', style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}
