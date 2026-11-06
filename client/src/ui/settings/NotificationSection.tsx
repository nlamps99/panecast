import { Platform, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { pushSummary, type PushSummary } from '../../notifications/controller';
import { notifications } from '../../notifications/instance';
import type { Permission } from '../../notifications/policy';
import { useNotificationState } from '../../notifications/useNotificationRouting';
import { useMachine, useStore } from '../../state/hooks';
import { localTimeZone, useNotificationRules } from '../../notifications/preferences';
import { Sheet, useSheet } from '../Sheet';
import { colors } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';

const IOS_FOOTNOTE =
  '后台通知由电脑通过 Apple 推送发送。新版服务器支持直接转发推送登记，无需回到同一 Wi-Fi。电脑需要配置 Apple 推送；可用测试通知验证。';
const ANDROID_FOOTNOTE =
  'Android 版不依赖 Google 推送服务：App 退到后台但还连着电脑时，新通知会出现在系统通知栏；App 被系统关掉后就收不到了。';

/** Permission, and whether this phone gets push from the current computer. */
export function NotificationSection() {
  const machine = useMachine();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const state = useNotificationState();

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
        <TimeField key={`start:${rules.quiet_hours.start_minutes}`} label="开始" minutes={rules.quiet_hours.start_minutes} onSave={(start_minutes) => store.update({ quiet_hours: { ...rules.quiet_hours, start_minutes } })} />
        <TimeField key={`end:${rules.quiet_hours.end_minutes}`} label="结束" minutes={rules.quiet_hours.end_minutes} onSave={(end_minutes) => store.update({ quiet_hours: { ...rules.quiet_hours, end_minutes } })} />
      </View>
      <ActionRow label="使用手机当前时区" onPress={() => store.update({ quiet_hours: { ...rules.quiet_hours, time_zone: localTimeZone() } })} />
    </> : null}
    <View style={[s.row, s.divided]}><View style={s.rowText}><Text style={s.rowTitle}>合并重复提醒</Text><Text style={s.rowDetail}>同一项目、同样内容，1 分钟内只提醒一次</Text></View><Switch value={rules.dedupe_seconds > 0} disabled={!loaded} onValueChange={(enabled) => store.update({ dedupe_seconds: enabled ? 60 : 0 })} accessibilityLabel="合并重复提醒" /></View>
    <View style={s.row}><Text style={s.rowDetail}>{Platform.OS === 'ios' && machine.computer
      ? acknowledged ? '通知规则已同步到电脑，本机和后台推送均按规则提醒。' : '本机规则已启用；电脑尚未确认后台推送规则，请连接后重新注册。旧 relay 需要升级。'
      : '规则应用于本机提醒；手动设置的稍后提醒和测试通知不受免打扰规则影响。'}</Text></View>
    {error ? <View style={s.row}><Text style={s.rowDetail}>{error}</Text></View> : null}
    <Sheet title="项目静音" visible={sheet.visible} onClose={() => sheet.close()} onClosed={sheet.onClosed}>
      {[...choices.map((w) => ({ id: w.id, title: w.title })), ...saved.map((id) => ({ id, title: '暂时不可用的项目' }))].map((w) => <View key={w.id} style={s.row}><Text style={[s.rowTitle, s.grow]}>{w.title}</Text><Switch disabled={!loaded} value={rules.muted_workspaces.includes(w.id)} onValueChange={(muted) => store.update({ muted_workspaces: muted ? [...rules.muted_workspaces, w.id] : rules.muted_workspaces.filter((id) => id !== w.id) })} accessibilityLabel={`静音 ${w.title}`} /></View>)}
      {!choices.length && !saved.length ? <View style={s.row}><Text style={s.rowDetail}>连接电脑并打开工作区后，可以选择需要静音的项目。</Text></View> : null}
    </Sheet>
  </>;
}
function TimeField({ label, minutes, onSave }: { label: string; minutes: number; onSave(value: number): void }) {
  const [text, setText] = useState(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  const [invalid, setInvalid] = useState(false);
  const save = () => { const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim()); if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) { setInvalid(true); return; } setInvalid(false); onSave(Number(match[1]) * 60 + Number(match[2])); };
  return <View style={s.rowText}><Text style={s.rowDetail}>{label}（HH:mm）</Text><TextInput defaultValue={text} onChangeText={setText} onBlur={save} onSubmitEditing={save} autoCorrect={false} autoCapitalize="none" maxLength={5} accessibilityLabel={`免打扰${label}时间`} style={{ color: colors.ink, backgroundColor: colors.surfaceRaised, padding: 10, borderRadius: 6 }} /><Pressable onPress={save}><Text style={{ color: invalid ? colors.red : colors.blue, fontSize: 12 }}>{invalid ? '请输入有效时间，如 22:00' : '保存时间'}</Text></Pressable></View>;
}

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
      return summary.configured
        ? { text: '电脑已登记', color: colors.green, detail: '经服务器登记成功，可以发送测试通知验证' }
        : { text: '待配置', color: colors.yellow, detail: '登记已到达电脑，还需要配置 Apple 推送的凭据和环境' };
  }
}

function formatDate(at: number): string {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
