import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Redirect, router, useCanGoBack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appStore, PairingError } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { storageSupported } from '../state/pairingStorage';
import { Icon } from '../ui/Icon';
import { ConnectionGuide } from '../ui/ConnectionGuide';
import { describePairingInput } from '../ui/pairingInput';
import { SignedOutNotice } from '../ui/SignedOutNotice';
import { colors, fonts } from '../ui/theme';
import { desktopBridge } from '../platform/desktop';

/** Re-scanning a code that just failed is ignored for this long. */
const RETRY_SAME_CODE_MS = 4_000;

/**
 * Two roles. As the only screen in the stack (first run, or the last
 * computer was removed) it replaces itself with the tabs once a computer or
 * the demo is ready. Opened over the tabs (`openPairing`, presented as a
 * modal) it has a close button and closes itself after pairing; the tabs
 * underneath are already on the new computer. `?computer=<id>` re-pairs that
 * computer.
 */
export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const presented = useCanGoBack();
  const { phase, computers } = useAppState();
  const { computer: repairId } = useLocalSearchParams<{ computer?: string }>();
  const repairing = computers.computers.find((c) => c.id === repairId) ?? null;
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = desktopBridge() !== null;
  // A guest's key cannot be re-scanned; they paste the new one the owner sends.
  const [manual, setManual] = useState(desktop || Boolean(repairing?.share));
  const [manualText, setManualText] = useState('');
  const handling = useRef(false);
  const rejected = useRef<{ data: string; at: number } | null>(null);
  // A modal swiped away mid-pairing must not pop whatever is underneath.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // As the root screen; the tabs guard has already been lifted in the same render.
  if (!presented && phase === 'ready') return <Redirect href="/" />;

  const attempt = async (data: string) => {
    if (handling.current) return;
    handling.current = true;
    setBusy(true);
    setError(null);
    try {
      await appStore.pair(data);
      if (presented && mounted.current) router.back();
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

  // An iOS modal sheet starts below the status bar; full screen (and Android's modal) needs the inset.
  const paddingTop = (presented && Platform.OS === 'ios' ? 0 : insets.top) + 12;
  const title = repairing ? '重新配对' : presented ? '添加电脑' : '连接电脑';

  if (!storageSupported) {
    return (
      <View style={[styles.screen, { paddingTop, paddingBottom: insets.bottom + 12 }]}>
        <Header title="Panecast" presented={presented} />
        <View style={styles.center}>
          <Text style={styles.body}>请使用 Panecast 手机或桌面 App 连接电脑。</Text>
          {presented ? null : (
            <Pressable onPress={() => appStore.enterDemo()} accessibilityRole="button">
              <Text style={styles.link}>先看看演示</Text>
            </Pressable>
          )}
        </View>
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
        <Pressable
          style={styles.button}
          // Once denied, iOS never asks again; only the Settings app can turn the camera back on.
          onPress={() => { if (permission.canAskAgain) void requestPermission(); else void Linking.openSettings(); }}
          accessibilityRole="button"
        >
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

  // The camera gets about a third of the screen, so a 4.7-inch phone still
  // shows the paste link, the demo and any error without scrolling.
  const cameraSize = Math.round(Math.min(windowWidth - insets.left - insets.right - 40, 700, Math.max(180, windowHeight * 0.36)));
  const recognised = manual ? describePairingInput(manualText) : null;
  let instructions;
  if (repairing?.share) instructions = <>「{repairing.name}」的分享密钥已失效。请向分享给你的人要一把新的密钥，粘贴到下面。</>;
  else if (repairing) instructions = <>「{repairing.name}」的配对已失效。在这台电脑上运行 <Text style={styles.code}>panecast pair</Text>，{desktop ? '粘贴它显示的配对链接。' : '重新扫描它显示的二维码。'}</>;
  else instructions = <>登录和电脑相同的账号，电脑会自动出现。也可以在电脑上运行 <Text style={styles.code}>panecast pair</Text>，{desktop ? '粘贴它显示的配对链接。' : '扫描它显示的二维码。'}</>;

  // Scrolls so the paste field and 配对 stay reachable above the keyboard (both platforms draw edge to edge).
  return (
    <KeyboardAvoidingView style={styles.fill} behavior="padding">
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.screen, { paddingTop, paddingBottom: insets.bottom + 12 }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Header title={title} presented={presented} />
      <SignedOutNotice signIn={false} />
      <Pressable style={styles.button} onPress={() => router.push('/account')} accessibilityRole="button"><Text style={styles.buttonText}>账号登录与电脑管理</Text></Pressable>
      <Text style={styles.body}>{instructions}</Text>
      {repairing?.share ? null : <ConnectionGuide />}
      {desktop || manual ? null : <View style={[styles.cameraBox, { width: cameraSize, height: cameraSize }]}>{camera}</View>}
      {manual ? (
        <View style={styles.manual}>
          <TextInput
            value={manualText}
            onChangeText={setManualText}
            placeholder="粘贴配对链接或分享密钥"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            // The link and the key are credentials; the line below says what was pasted instead.
            secureTextEntry
            returnKeyType="go"
            onSubmitEditing={() => manualText && !busy && void attempt(manualText)}
            style={styles.manualInput}
          />
          {recognised ? (
            <Text style={[styles.recognised, !recognised.ok && styles.unrecognised]} accessibilityLiveRegion="polite">{recognised.text}</Text>
          ) : null}
          <Pressable
            style={[styles.button, (!manualText || busy) && styles.buttonDim]}
            disabled={!manualText || busy}
            onPress={() => void attempt(manualText)}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>连接</Text>
          </Pressable>
        </View>
      ) : null}
      {busy ? (
        <View style={styles.status}>
          <ActivityIndicator color={colors.ink} />
          <Text style={styles.body}>正在连接…</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {desktop ? null : manual ? (
        <Pressable onPress={() => { setManual(false); setError(null); }} accessibilityRole="button" style={styles.linkButton}>
          <Text style={styles.link}>改用扫码</Text>
        </Pressable>
      ) : (
        <Pressable onPress={() => { setManual(true); setError(null); }} accessibilityRole="button" style={styles.linkButton}>
          <Text style={styles.link}>没法扫码，或者有分享密钥？点这里粘贴</Text>
        </Pressable>
      )}
      {presented ? null : (
        <Pressable onPress={() => appStore.enterDemo()} style={styles.demo} accessibilityRole="button">
          <Text style={styles.link}>还没有电脑可连？先看看演示</Text>
        </Pressable>
      )}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** The title, plus a close button when opened over the tabs (swipe-down and Android back also close it). */
function Header({ title, presented }: { title: string; presented: boolean }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {presented ? (
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="关闭">
          <Icon name="close" size={14} color={colors.inkDim} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.canvas },
  screen: { flexGrow: 1, width: '100%', maxWidth: 700, alignSelf: 'center', backgroundColor: colors.canvas, paddingHorizontal: 20, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, color: colors.ink, fontSize: 24, fontWeight: '600' },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  body: { color: colors.inkDim, fontSize: 15, lineHeight: 22 },
  code: { fontFamily: fonts.mono, color: colors.green },
  cameraBox: {
    alignSelf: 'center',
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
  linkButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  demo: { marginTop: 'auto', alignSelf: 'center', minHeight: 44, justifyContent: 'center' },
  recognised: { color: colors.green, fontSize: 13, lineHeight: 18 },
  unrecognised: { color: colors.yellow },
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
