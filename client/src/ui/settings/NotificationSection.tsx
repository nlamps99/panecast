import { Platform, Text, View } from 'react-native';

import { pushSummary, type PushSummary } from '../../notifications/controller';
import { notifications } from '../../notifications/instance';
import type { Permission } from '../../notifications/policy';
import { useNotificationState } from '../../notifications/useNotificationRouting';
import { useMachine } from '../../state/hooks';
import { colors } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';

const IOS_FOOTNOTE =
  'App 在后台或被关掉时，通知要由电脑上的 relay 通过 Apple 推送发来。这要求和电脑在同一 Wi-Fi 下配对过；只通过服务器配对时，服务器还不能把推送转发给电脑，只有 App 开着并连着电脑时才收得到。';
const ANDROID_FOOTNOTE =
  'Android 版不依赖 Google 推送服务：App 退到后台但还连着电脑时，新通知会出现在系统通知栏；App 被系统关掉后就收不到了。';

/** Permission, and whether this phone gets push from the current computer. */
export function NotificationSection() {
  const machine = useMachine();
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
    </Section>
  );
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
  }
}

function formatDate(at: number): string {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
