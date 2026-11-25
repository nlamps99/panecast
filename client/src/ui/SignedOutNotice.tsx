import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { appStore } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { colors } from './theme';

/**
 * Says why the account disappeared when the server ended its session. Shown
 * on the next screen the user sees (pairing, workspaces or the account page)
 * until they dismiss it or sign in again.
 */
export function SignedOutNotice({ signIn = true }: { signIn?: boolean }) {
  const { signedOut } = useAppState();
  if (!signedOut) return null;
  return (
    <View style={s.card} accessibilityRole="alert">
      <Text style={s.text}>{signedOut}</Text>
      <View style={s.row}>
        {signIn ? <Pressable onPress={() => router.push('/account')} accessibilityRole="button" style={s.button}><Text style={s.primary}>重新登录</Text></Pressable> : null}
        <Pressable onPress={() => appStore.dismissSignedOut()} accessibilityRole="button" style={s.button}><Text style={s.secondary}>知道了</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { gap: 4, padding: 12, borderRadius: 10, backgroundColor: colors.surface, borderLeftWidth: 3, borderLeftColor: colors.yellow },
  text: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  primary: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  secondary: { color: colors.inkDim, fontSize: 15 },
});
