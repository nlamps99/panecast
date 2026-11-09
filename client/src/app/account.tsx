import { router, useCanGoBack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Alert } from '../platform/alert';
import { appStore } from '../state/appStore';
import { useAppState } from '../state/hooks';
import { storageSupported } from '../state/pairingStorage';
import { colors } from '../ui/theme';

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const canGoBack = useCanGoBack();
  const { account, accountError, computers } = useAppState();
  const [server, setServer] = useState(computers.computers[0]?.broker.serverUrl ?? process.env.EXPO_PUBLIC_ACCOUNT_SERVER ?? 'https://ningzx.cn/cmux-remote');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [register, setRegister] = useState(false);
  const [manage, setManage] = useState<'password' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    const interval = setInterval(() => { void appStore.refreshAccount().catch(() => {}); }, 15_000);
    return () => clearInterval(interval);
  }, [account]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  const login = () => void run(async () => {
    if (register && password !== confirmation) throw new Error('两次输入的密码不一致。');
    await appStore.login(server, username, password, register);
    setPassword(''); setConfirmation('');
  });
  const close = () => { if (canGoBack) router.back(); else router.replace('/pair'); };
  const bound = computers.computers.filter((c) => c.accountId === account?.user.id && c.accountId);
  const local = computers.computers.filter((c) => !c.accountId && c.broker.serverUrl === account?.serverUrl);

  return <KeyboardAvoidingView style={s.screen} behavior="padding">
    <ScrollView contentContainerStyle={[s.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <View style={s.header}><Text style={s.title}>账号与电脑</Text><Action label="返回" onPress={close} /></View>
      {!storageSupported ? <Text style={s.detail}>请在 Panecast 手机或桌面 App 中登录。</Text> : account ? <>
        <View style={s.card}><Text style={s.heading}>{account.user.username}</Text><Text selectable style={s.detail}>{account.serverUrl}</Text>
          <Text style={s.detail}>在其他设备登录这个账号，就能连接下面的电脑。</Text></View>
        <View style={s.header}><Text style={s.heading}>我的电脑</Text><Action label="刷新" disabled={busy} onPress={() => void run(() => appStore.refreshAccount())} /></View>
        {bound.length === 0 ? <Text style={s.detail}>还没有绑定电脑。添加配对链接，或绑定下方已配对的电脑。</Text> : bound.map((computer) => <View key={computer.id} style={s.card}>
          <View style={s.header}><Text style={s.heading}>{computer.name}</Text><Text style={{ color: computer.online ? colors.green : colors.muted }}>{computer.online ? '在线' : '离线'}</Text></View>
          <Action label="连接电脑" disabled={busy} onPress={() => void run(async () => { await appStore.select(computer.id); router.replace('/'); })} />
        </View>)}
        <Action label="添加电脑" disabled={busy} onPress={() => router.push('/pair')} primary />
        {local.map((computer) => <View key={computer.id} style={s.card}><Text style={s.heading}>{computer.name}</Text><Text style={s.detail}>这台电脑目前只在本机配对。</Text>
          <Action label="绑定到账号" disabled={busy} onPress={() => void run(() => appStore.bindExisting(computer.id))} /></View>)}
        <View style={s.row}><Action label="修改密码" onPress={() => { setManage('password'); setPassword(''); }} disabled={busy} />
          <Action label="退出登录" onPress={() => void run(() => appStore.logout())} disabled={busy} />
          <Action label="删除账号" onPress={() => { setManage('delete'); setPassword(''); }} disabled={busy} /></View>
        {manage ? <View style={s.card}>
          <Text style={s.heading}>{manage === 'password' ? '修改密码' : '删除账号'}</Text>
          <Text style={s.detail}>{manage === 'password' ? '修改后，其他设备需要重新登录。' : '账号和绑定关系将永久删除，电脑上的文件和程序会保留。'}</Text>
          <Field label="当前密码" value={password} onChangeText={setPassword} secure />
          {manage === 'password' ? <Field label="新密码（至少 12 个字符）" value={newPassword} onChangeText={setNewPassword} secure /> : null}
          <Action label={manage === 'password' ? '保存新密码' : '永久删除账号'} disabled={busy || !password} onPress={() => {
            if (manage === 'password') void run(async () => { await appStore.changePassword(password, newPassword); setManage(null); setPassword(''); setNewPassword(''); setNotice('密码已修改。'); });
            else Alert.alert('永久删除账号？', '删除后无法恢复，需要重新注册和绑定电脑。', [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void run(async () => { await appStore.deleteAccount(password); setManage(null); setPassword(''); }) }]);
          }} primary />
          <Action label="取消" onPress={() => { setManage(null); setPassword(''); setNewPassword(''); }} />
        </View> : null}
      </> : <>
        <Text style={s.detail}>手机和电脑使用同一个账号，随时接着处理远程终端中的工作。</Text>
        <Field label="服务器地址" value={server} onChangeText={setServer} placeholder="https://你的服务器" />
        <Text style={s.detail}>填写配对链接中的服务器地址，支持已有的自建中转服务器。</Text>
        <Field label="用户名" value={username} onChangeText={setUsername} placeholder="字母、数字、点、下划线或短横线" />
        <Field label={register ? '密码（至少 12 个字符）' : '密码'} value={password} onChangeText={setPassword} secure />
        {register ? <Field label="再次输入密码" value={confirmation} onChangeText={setConfirmation} secure /> : null}
        <Action label={register ? '创建账号' : '登录'} disabled={busy || !server.trim() || !username.trim() || !password} onPress={login} primary />
        <Action label={register ? '已有账号，去登录' : '没有账号，去注册'} disabled={busy} onPress={() => { setRegister(!register); setError(null); }} />
      </>}
      {busy ? <ActivityIndicator color={colors.blue} /> : null}
      {error || accountError ? <Text accessibilityRole="alert" style={s.error}>{error ?? accountError}</Text> : null}
      {notice ? <Text style={s.detail}>{notice}</Text> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
function Field({ label, value, onChangeText, secure = false, placeholder }: { label: string; value: string; onChangeText(value: string): void; secure?: boolean; placeholder?: string }) {
  return <View style={s.field}><Text style={s.detail}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} placeholder={placeholder} placeholderTextColor={colors.muted} style={s.input} maxLength={secure ? 256 : 512} /></View>;
}
function Action({ label, onPress, disabled = false, primary = false }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[s.button, primary && s.primary, disabled && { opacity: 0.5 }]}><Text style={[s.buttonText, primary && { color: colors.canvas }]}>{label}</Text></Pressable>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, content: { width: '100%', maxWidth: 700, alignSelf: 'center', paddingHorizontal: 24, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, title: { color: colors.ink, fontSize: 26, fontWeight: '700' },
  heading: { color: colors.ink, fontSize: 17, fontWeight: '600', flexShrink: 1 }, detail: { color: colors.inkDim, fontSize: 14, lineHeight: 22 },
  card: { backgroundColor: colors.surface, padding: 18, borderRadius: 12, gap: 12 }, field: { gap: 6 },
  input: { color: colors.ink, backgroundColor: colors.surface, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: colors.divider },
  button: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' }, primary: { backgroundColor: colors.blue }, buttonText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 }, error: { color: colors.red, fontSize: 14, lineHeight: 22 },
});
