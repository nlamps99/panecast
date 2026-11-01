import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appStore, PairingError } from '../state/appStore';
import { storageSupported } from '../state/pairingStorage';
import { colors, fonts } from '../ui/theme';

/** Re-scanning a code that just failed is ignored for this long. */
const RETRY_SAME_CODE_MS = 4_000;

export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState('');
  const handling = useRef(false);
  const rejected = useRef<{ data: string; at: number } | null>(null);

  const attempt = async (data: string) => {
    if (handling.current) return;
    handling.current = true;
    setBusy(true);
    setError(null);
    try {
      await appStore.pair(data);
      router.replace('/terminal');
    } catch (failure) {
      rejected.current = { data, at: Date.now() };
      setError(failure instanceof PairingError ? failure.message : `配对失败：${String(failure)}`);
    } finally {
      handling.current = false;
      setBusy(false);
    }
  };

  const onScanned = ({ data }: BarcodeScanningResult) => {
    const last = rejected.current;
    if (last && last.data === data && Date.now() - last.at < RETRY_SAME_CODE_MS) return;
    void attempt(data);
  };

  if (!storageSupported) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.title}>Panecast</Text>
        <Text style={styles.body}>网页版还不能连接电脑，请先用 iPhone 或 Android App。</Text>
      </View>
    );
  }

  let camera;
  if (!permission) {
    camera = <ActivityIndicator color={colors.muted} />;
  } else if (!permission.granted) {
    camera = (
      <View style={styles.center}>
        <Text style={styles.body}>需要相机权限来扫描电脑上的配对二维码。</Text>
        <Pressable style={styles.button} onPress={requestPermission} accessibilityRole="button">
          <Text style={styles.buttonText}>{permission.canAskAgain ? '允许使用相机' : '去设置里打开相机权限'}</Text>
        </Pressable>
      </View>
    );
  } else {
    camera = (
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : onScanned}
      />
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <Text style={styles.title}>连接电脑</Text>
      <Text style={styles.body}>
        在 Mac 上运行 <Text style={styles.code}>cmux-relay pair</Text>，然后扫描它显示的二维码。
      </Text>
      <View style={styles.cameraBox}>{camera}</View>
      {busy ? (
        <View style={styles.status}>
          <ActivityIndicator color={colors.ink} />
          <Text style={styles.body}>正在配对…</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {manual ? (
        <View style={styles.manual}>
          <TextInput
            value={manualText}
            onChangeText={setManualText}
            placeholder="粘贴 cmux://pair?... 链接"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.manualInput}
          />
          <Pressable
            style={[styles.button, (!manualText || busy) && styles.buttonDim]}
            disabled={!manualText || busy}
            onPress={() => void attempt(manualText)}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>配对</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={() => setManual(true)} accessibilityRole="button">
          <Text style={styles.link}>没法扫码？粘贴配对链接</Text>
        </Pressable>
      )}
      <Pressable onPress={() => router.push('/demo')} style={styles.demo} accessibilityRole="button">
        <Text style={styles.link}>还没有电脑可连？先看看演示</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 20, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { color: colors.ink, fontSize: 24, fontWeight: '600' },
  body: { color: colors.inkDim, fontSize: 15, lineHeight: 22 },
  code: { fontFamily: fonts.mono, color: colors.green },
  cameraBox: {
    aspectRatio: 1,
    width: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  error: { color: colors.red, fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: colors.blue, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center' },
  buttonDim: { opacity: 0.5 },
  buttonText: { color: colors.canvas, fontSize: 15, fontWeight: '600' },
  link: { color: colors.blue, fontSize: 14 },
  demo: { marginTop: 'auto', alignSelf: 'center', paddingVertical: 8 },
  manual: { gap: 8 },
  manualInput: {
    color: colors.ink,
    fontFamily: fonts.mono,
    fontSize: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
});
