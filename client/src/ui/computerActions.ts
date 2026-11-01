import { Alert } from 'react-native';

import type { StoredComputer } from '../state/computers';

/** Runs an app-store action; a failure (SecureStore refusing a write) shows an alert instead of vanishing. */
export function runOrAlert(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    Alert.alert('无法更新电脑', error instanceof Error ? error.message : String(error));
  });
}

/** Asks before forgetting a computer. `onConfirm` does the removal. */
export function confirmRemove(computer: StoredComputer, onConfirm: () => void): void {
  Alert.alert(`移除「${computer.name}」？`, '这台手机会忘记这台电脑，之后要重新扫码才能连接。', [
    { text: '取消', style: 'cancel' },
    { text: '移除', style: 'destructive', onPress: onConfirm },
  ]);
}
