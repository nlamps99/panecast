import * as Clipboard from 'expo-clipboard';
import { desktopBridge } from './desktop';

/** WKWebView cannot reliably write the clipboard after an asynchronous operation. */
export const setStringAsync: typeof Clipboard.setStringAsync = async (text, options) => {
  const desktop = desktopBridge();
  if (desktop?.writeClipboard) return desktop.writeClipboard(text);
  return Clipboard.setStringAsync(text, options);
};
