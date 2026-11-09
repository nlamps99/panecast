import { Alert as NativeAlert, type AlertButton, type AlertOptions } from 'react-native';
import { desktopBridge } from './desktop';

/** React Native Web has no Alert implementation; desktop confirmations use the OS dialog. */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) {
    const desktop = desktopBridge();
    if (!desktop) { NativeAlert.alert(title, message, buttons, options); return; }
    const choices = buttons?.length ? buttons : [{ text: '好' }];
    const cancel = choices.findIndex((button) => button.style === 'cancel');
    void desktop.dialog({ title, message, buttons: choices.map((button) => button.text ?? '好'), cancelId: cancel >= 0 ? cancel : 0 })
      .then((index) => choices[index]?.onPress?.()).catch(() => options?.onDismiss?.());
  },
};
