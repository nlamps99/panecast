import * as Font from 'expo-font';

/**
 * The config plugin only embeds fonts in native builds, so the web export
 * (and the desktop app built from it) registers GeistMono itself. Text uses
 * the system monospace until the face arrives; both advance 0.6 em.
 */
export async function loadTerminalFonts(): Promise<void> {
  try {
    await Font.loadAsync({
      'GeistMono-Regular': require('../../assets/fonts/GeistMono-Regular.ttf'),
      'GeistMono-Bold': require('../../assets/fonts/GeistMono-Bold.ttf'),
    });
  } catch {
    // The monospace fallback keeps the terminal aligned.
  }
}
