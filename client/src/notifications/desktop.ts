import AsyncStorage from '@react-native-async-storage/async-storage';
import { desktopBridge, type DesktopBridge } from '../platform/desktop';
import type { Machine } from '../state/appStore';
import { notifications } from './instance';
import { notificationGroup } from './preferences';

const key = 'panecast.desktop-notifications.v1';
let state = { enabled: true, loaded: false, error: null as string | null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
function update(patch: Partial<typeof state>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
export const desktopNotifications = {
  getState: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  load: () => loading ??= AsyncStorage.getItem(key).then(value => { update({ enabled: value !== 'off', loaded: true }); })
    .catch(() => { update({ loaded: true, error: '无法读取通知偏好' }); }),
  async enable(enabled: boolean) {
    update({ enabled, error: null });
    try { await AsyncStorage.setItem(key, enabled ? 'on' : 'off'); }
    catch { update({ error: '未能保存通知偏好' }); }
  },
};

/** Observe new arrivals only; startup history and inbox replay never notify. */
export function watchDesktopNotifications(machine: Machine, bridge: DesktopBridge): () => void {
  if (!machine.computer || machine.mode === 'demo' || !bridge.notify) return () => {};
  let stopped = false;
  const computerId = machine.computer.id;
  const groups = new Map<string, number>();
  const rules = notifications.rules(computerId);
  const ready = Promise.all([desktopNotifications.load(), rules.load()]);
  const unsubscribe = machine.inbox.onNew(item => {
    void ready.then(async () => {
      if (stopped || !state.enabled || item.read || item.resolvedAt || !notifications.allowsItem(item, computerId)) return;
      const now = Date.now(), group = notificationGroup(item);
      for (const [key, at] of groups) if (now - at > 3600_000) groups.delete(key);
      if (now - (groups.get(group) ?? -Infinity) < rules.getState().preferences.dedupe_seconds * 1000) return;
      groups.set(group, now);
      try {
        await bridge.notify!({ title: item.title, body: [item.subtitle, item.body].filter(Boolean).join('\n'),
          computerId, notificationId: item.id, workspaceId: item.workspaceId, surfaceId: item.surfaceId, sourceId: item.sourceId, threadId: item.threadId });
      } catch { if (!stopped) update({ error: '系统通知未能发送，请检查通知设置' }); }
    });
  });
  return () => { stopped = true; unsubscribe(); };
}

export async function testDesktopNotification() {
  const bridge = desktopBridge();
  if (!bridge?.notify) throw new Error('请升级桌面版后重试');
  await bridge.notify({ title: 'Panecast 通知测试', body: '任务完成后，提醒会显示在这里。', force: true });
}
