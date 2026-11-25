import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { pushSummary, type PushSummary } from '../../notifications/controller';
import { notifications } from '../../notifications/instance';
import type { Permission } from '../../notifications/policy';
import { useNotificationState } from '../../notifications/useNotificationRouting';
import { useMachine, useStore } from '../../state/hooks';
import { localTimeZone, useNotificationRules } from '../../notifications/preferences';
import { Sheet, useSheet } from '../Sheet';
import { colors } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';
import { formatClock, HOUR_CHOICES, MINUTE_CHOICES, withHour, withMinute } from './quietHours';
import { desktopBridge } from '../../platform/desktop';
import { desktopNotifications, testDesktopNotification } from '../../notifications/desktop';

const IOS_FOOTNOTE =
  'App 打开或刚切到后台时，新通知会马上提醒。App 在后台久了还能不能收到，要看电脑是否开启了 Apple 推送；可以发一条测试通知看看。';
const ANDROID_FOOTNOTE =
  'Android 版不依赖 Google 推送服务：App 退到后台但还连着电脑时，新通知会出现在系统通知栏；App 被系统关掉后就收不到了。';

/** Permission, and whether this phone gets push from the current computer. */
export function NotificationSection() {
  const machine = useMachine();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const state = useNotificationState();

  if (desktopBridge()) return <DesktopNotificationSection />;

  if (!notifications.supported) {
    return (
      <Section title="通知">
        <View style={s.row}>
          <Text style={[s.rowDetail, s.grow]}>网页版收不到通知，请用手机 App。</Text>
        </View>
      </Section>
    );
  }

  const { status, canAskAgain } = state.permission;
  const ios = Platform.OS === 'ios';
  const summary = pushSummary(state, Platform.OS, machine.computer?.id ?? null);
  const permission = permissionLabel(status);
  const push = ios ? pushLabel(summary) : null;
  const canRetry = summary.kind === 'token_failed' || summary.kind === 'failed' || (summary.kind === 'broker_only' && summary.lanFailed !== null);

  return (
    <Section title="通知" footnote={ios ? IOS_FOOTNOTE : ANDROID_FOOTNOTE}>
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>通知权限</Text>
        <View style={[s.dot, { backgroundColor: permission.color }]} />
        <Text style={s.rowValue}>{permission.text}</Text>
      </View>
      {push ? (
        <View style={[s.row, s.divided]}>
          <View style={s.rowText}>
            <Text style={s.rowTitle}>推送</Text>
            {push.detail ? <Text style={s.rowDetail}>{push.detail}</Text> : null}
          </View>
          <View style={[s.dot, { backgroundColor: push.color }]} />
          <Text style={s.rowValue}>{push.text}</Text>
        </View>
      ) : null}
      {status === 'undetermined' || (status === 'denied' && canAskAgain) ? (
        <ActionRow label="开启通知" onPress={() => void notifications.enable()} />
      ) : null}
      {status === 'granted' || (status === 'denied' && !canAskAgain) ? (
        <ActionRow label="去系统设置" onPress={() => void notifications.openSettings()} />
      ) : null}
      {ios && canRetry ? <ActionRow label="重新注册推送" onPress={() => notifications.retry()} /> : null}
      {ios && !canRetry && status === 'granted' ? <ActionRow label="重新注册推送" onPress={() => notifications.retry()} /> : null}
      {status === 'granted' ? <ActionRow label={testing ? '正在测试…' : ios ? '发送测试推送' : '测试本机提醒'} onPress={() => {
        if (testing) return;
        setTesting(true);
        void notifications.testPush().then(setTestResult).catch((error: unknown) => setTestResult(error instanceof Error ? error.message : '测试失败')).finally(() => setTesting(false));
      }} /> : null}
      {testResult ? <View style={s.row}><Text style={s.rowDetail}>{testResult}</Text></View> : null}
      <NotificationRules key={machine.computer?.id ?? 'demo'} />
    </Section>
  );
}

function DesktopNotificationSection() {
  const state = useSyncExternalStore(desktopNotifications.subscribe, desktopNotifications.getState, desktopNotifications.getState);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { void desktopNotifications.load(); }, []);
  return <Section title="通知" footnote="连接期间，任务完成和待回应事项会显示提醒。切到其他应用时使用系统通知；请在系统通知设置中允许 Panecast。关闭窗口或退出应用后不再接收。">
    <View style={s.row}><Text style={[s.rowTitle, s.grow]}>系统通知</Text><Switch value={state.enabled} disabled={!state.loaded} onValueChange={value => { void desktopNotifications.enable(value); }} accessibilityLabel="系统通知" /></View>
    <ActionRow label="去系统通知设置" onPress={() => { void desktopBridge()?.openNotificationSettings?.().catch(() => setResult('无法打开系统通知设置')); }} />
    <ActionRow label="测试本机提醒" onPress={() => { void testDesktopNotification().then(() => setResult('已发送，请检查系统通知')).catch(error => setResult(error instanceof Error ? error.message : '测试失败')); }} />
    {result || state.error ? <View style={s.row}><Text style={s.rowDetail}>{state.error ?? result}</Text></View> : null}
    <NotificationRules />
  </Section>;
}

function NotificationRules() {
  const machine = useMachine();
  const computerId = machine.computer?.id ?? 'demo';
  const store = notifications.rules(computerId);
  const { preferences: rules, loaded, error } = useNotificationRules(store);
  const { workspaces, known } = useStore(machine.workspaces);
  const state = useNotificationState();
  const push = state.push[computerId];
  const acknowledged = push?.broker.state === 'ok' && push.broker.preferencesApplied || push?.relay?.state === 'ok' && push.relay.preferencesApplied;
  const sheet = useSheet();
  const choices = [...new Map([...workspaces, ...Object.values(known.workspaces)].map((w) => [w.id, w])).values()];
  const saved = rules.muted_workspaces.filter((id) => !choices.some((w) => w.id === id));
  return <>
    <View style={[s.row, s.divided]}><Text style={s.rowDetail}>只提醒需要回答、审批、失败或阻塞的问题，以及任务完成。过程进度和普通状态更新不提醒。</Text></View>
    <View style={[s.row, s.divided]}><View style={s.rowText}><Text style={s.rowTitle}>只提醒需要处理的问题</Text><Text style={s.rowDetail}>开启后，任务完成只保留在收件箱</Text></View><Switch value={rules.needs_input_only} disabled={!loaded} onValueChange={(value) => store.update({ needs_input_only: value })} accessibilityLabel="只提醒需要处理的问题" /></View>
    <ActionRow label={`项目静音 · ${rules.muted_workspaces.length} 个`} onPress={sheet.open} />
    <View style={[s.row, s.divided]}><View style={s.rowText}><Text style={s.rowTitle}>免打扰时段</Text><Text style={s.rowDetail}>{rules.quiet_hours.time_zone} · 起止相同表示全天</Text></View><Switch value={rules.quiet_hours.enabled} disabled={!loaded} onValueChange={(enabled) => store.update({ quiet_hours: { ...rules.quiet_hours, enabled } })} accessibilityLabel="免打扰时段" /></View>
    {rules.quiet_hours.enabled ? <>
      <View style={s.row}>
        <TimeButton label="开始" minutes={rules.quiet_hours.start_minutes} disabled={!loaded} onSave={(start_minutes) => store.update({ quiet_hours: { ...rules.quiet_hours, start_minutes } })} />
        <TimeButton label="结束" minutes={rules.quiet_hours.end_minutes} disabled={!loaded} onSave={(end_minutes) => store.update({ quiet_hours: { ...rules.quiet_hours, end_minutes } })} />
      </View>
      <ActionRow label="使用手机当前时区" onPress={() => store.update({ quiet_hours: { ...rules.quiet_hours, time_zone: localTimeZone() } })} />
    </> : null}
    <View style={[s.row, s.divided]}><View style={s.rowText}><Text style={s.rowTitle}>合并重复提醒</Text><Text style={s.rowDetail}>同一项目、同样内容，1 分钟内只提醒一次</Text></View><Switch value={rules.dedupe_seconds > 0} disabled={!loaded} onValueChange={(enabled) => store.update({ dedupe_seconds: enabled ? 60 : 0 })} accessibilityLabel="合并重复提醒" /></View>
    <View style={s.row}><Text style={s.rowDetail}>{Platform.OS === 'ios' && machine.computer
      ? acknowledged ? '通知规则已同步到电脑，本机和后台推送都按规则提醒。' : '这台手机已按规则提醒。电脑还没确认这些规则，后台推送可能不受规则限制；连上电脑后会自动同步，一直不同步的话请在电脑上更新 Panecast。'
      : '规则应用于本机提醒；手动设置的稍后提醒和测试通知不受免打扰规则影响。'}</Text></View>
    {error ? <View style={s.row}><Text style={s.rowDetail}>{error}</Text></View> : null}
    <Sheet title="项目静音" visible={sheet.visible} onClose={() => sheet.close()} onClosed={sheet.onClosed}>
      {[...choices.map((w) => ({ id: w.id, title: w.title })), ...saved.map((id) => ({ id, title: '暂时不可用的项目' }))].map((w) => <View key={w.id} style={s.row}><Text style={[s.rowTitle, s.grow]}>{w.title}</Text><Switch disabled={!loaded} value={rules.muted_workspaces.includes(w.id)} onValueChange={(muted) => store.update({ muted_workspaces: muted ? [...rules.muted_workspaces, w.id] : rules.muted_workspaces.filter((id) => id !== w.id) })} accessibilityLabel={`静音 ${w.title}`} /></View>)}
      {!choices.length && !saved.length ? <View style={s.row}><Text style={s.rowDetail}>连接电脑并打开工作区后，可以选择需要静音的项目。</Text></View> : null}
    </Sheet>
  </>;
}
/** A time you pick from hour and minute grids instead of typing HH:mm. */
function TimeButton({ label, minutes, disabled, onSave }: { label: string; minutes: number; disabled: boolean; onSave(value: number): void }) {
  const sheet = useSheet();
  const hour = Math.floor(minutes / 60), minute = minutes % 60;
  return <>
    <Pressable onPress={sheet.open} disabled={disabled} style={({ pressed }) => [time.button, pressed && s.pressed, disabled && time.dim]}
      accessibilityRole="button" accessibilityLabel={`免打扰${label}时间`} accessibilityValue={{ text: formatClock(minutes) }} accessibilityHint="轻点修改">
      <Text style={s.rowDetail}>{label}</Text>
      <Text style={time.value}>{formatClock(minutes)}</Text>
    </Pressable>
    <Sheet title={`免打扰${label}时间 · ${formatClock(minutes)}`} visible={sheet.visible} onClose={() => sheet.close()} onClosed={sheet.onClosed}>
      <View style={time.body}>
        <Text style={s.rowDetail}>小时</Text>
        <View style={time.grid}>{HOUR_CHOICES.map((h) => <Choice key={h} label={String(h).padStart(2, '0')} a11y={`${h} 点`} selected={h === hour} onPress={() => onSave(withHour(minutes, h))} />)}</View>
        <Text style={s.rowDetail}>分钟</Text>
        <View style={time.grid}>{MINUTE_CHOICES.map((m) => <Choice key={m} label={String(m).padStart(2, '0')} a11y={`${m} 分`} selected={m === minute} onPress={() => onSave(withMinute(minutes, m))} />)}</View>
        <Pressable onPress={() => sheet.close()} style={time.done} accessibilityRole="button"><Text style={time.doneText}>完成</Text></Pressable>
      </View>
    </Sheet>
  </>;
}

function Choice({ label, a11y, selected, onPress }: { label: string; a11y: string; selected: boolean; onPress(): void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [time.choice, selected && time.selected, pressed && s.pressed]}
    accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected }}>
    <Text style={[time.choiceText, selected && time.selectedText]}>{label}</Text>
  </Pressable>;
}

const time = StyleSheet.create({
  button: { flex: 1, minHeight: 52, justifyContent: 'center', gap: 2, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  value: { color: colors.ink, fontSize: 20, fontVariant: ['tabular-nums'] },
  dim: { opacity: 0.5 },
  body: { padding: 16, gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choice: { width: '15%', flexGrow: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.surfaceRaised },
  selected: { backgroundColor: colors.green },
  choiceText: { color: colors.ink, fontSize: 15, fontVariant: ['tabular-nums'] },
  selectedText: { color: colors.canvas, fontWeight: '600' },
  done: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  doneText: { color: colors.blue, fontSize: 16, fontWeight: '600' },
});

type Label = { text: string; color: string; detail?: string };

function permissionLabel(status: Permission): Label {
  switch (status) {
    case 'granted':
      return { text: '已开启', color: colors.green };
    case 'denied':
      return { text: '已关闭', color: colors.red };
    case 'undetermined':
      return { text: '未开启', color: colors.muted };
    case 'unknown':
    case 'unsupported':
      return { text: '读取中…', color: colors.muted };
  }
}

function pushLabel(summary: PushSummary): Label {
  switch (summary.kind) {
    case 'unsupported':
      return { text: '不支持', color: colors.muted };
    case 'demo':
      return { text: '演示中不注册', color: colors.muted };
    case 'off':
      return { text: '未开启', color: colors.muted, detail: '先开启通知' };
    case 'pending':
      return { text: '注册中…', color: colors.yellow };
    case 'token_failed':
    case 'failed':
      return { text: '注册失败', color: colors.red, detail: summary.message };
    case 'relay':
      return {
        text: '已注册',
        color: colors.green,
        detail: summary.remembered
          ? `${formatDate(summary.at)}在同一 Wi-Fi 下登记过，电脑会照常推送`
          : '电脑会在 App 不在前台时推送通知',
      };
    case 'broker_only':
      return {
        text: '仅服务器',
        color: colors.yellow,
        detail: summary.lanFailed
          ? `服务器已登记，电脑还没登记上（${summary.lanFailed}）。和电脑在同一 Wi-Fi 下时再试`
          : '服务器已登记，但服务器还不能转发推送',
      };
    case 'broker_relay':
      // Without Apple push credentials on the computer, alerts still arrive while the app runs.
      return summary.configured
        ? { text: '电脑已登记', color: colors.green, detail: '可以发一条测试通知看看' }
        : { text: '仅在 App 运行时', color: colors.muted, detail: '电脑没有开启 Apple 推送，App 打开或刚切到后台时照常提醒' };
  }
}

function formatDate(at: number): string {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
