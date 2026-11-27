import AsyncStorage from '@react-native-async-storage/async-storage';
import { desktopBridge, type DesktopBridge } from '../platform/desktop';
import type { AppStoreState, InboxWatch, Machine } from '../state/appStore';
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

/** What a watch needs: the selected machine, or another paired computer's inbox-only connection. */
type WatchedInbox = Pick<Machine, 'computer' | 'inbox'> & { mode?: Machine['mode'] };

/**
 * Observe new arrivals only; startup history and inbox replay never notify.
 * `always`: post even while the window is in front. The native side skips
 * that case because the in-app banner shows the item, but the banner only
 * exists for the computer on screen.
 */
export function watchDesktopNotifications(machine: WatchedInbox, bridge: DesktopBridge, always = false): () => void {
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
          computerId, notificationId: item.id, workspaceId: item.workspaceId, surfaceId: item.surfaceId, sourceId: item.sourceId, threadId: item.threadId,
          ...(always ? { force: true } : {}) });
      } catch { if (!stopped) update({ error: '系统通知未能发送，请检查通知设置' }); }
    });
  });
  return () => { stopped = true; unsubscribe(); };
}

type InboxSources = {
  getState(): AppStoreState;
  subscribe(listener: () => void): () => void;
  watchedInboxes(): readonly InboxWatch[];
};

/**
 * Native notifications from every paired computer: the selected machine's
 * inbox and each other computer's inbox-only connection (`AppStore`). A watch
 * follows its inbox object, so switching computers hands a computer from one
 * to the other without replaying anything.
 */
export function watchAllDesktopNotifications(store: InboxSources, bridge: DesktopBridge): () => void {
  const active = new Map<object, { key: string; stop: () => void }>();
  const sync = () => {
    const { machine } = store.getState();
    const wanted: (WatchedInbox & { always: boolean })[] = [...(machine ? [{ ...machine, always: false }] : []), ...store.watchedInboxes().map((watch) => ({ ...watch, always: true }))];
    // Keyed by inbox and by whether it is on screen: a computer that becomes
    // (or stops being) the selected one changes how its alerts are posted.
    const key = (watch: { inbox: object; always: boolean }) => `${watch.always}`;
    const inboxes = new Map<object, string>(wanted.map((watch) => [watch.inbox, key(watch)]));
    for (const [inbox, entry] of active) if (inboxes.get(inbox) !== entry.key) { entry.stop(); active.delete(inbox); }
    for (const watch of wanted) if (!active.has(watch.inbox)) active.set(watch.inbox, { key: key(watch), stop: watchDesktopNotifications(watch, bridge, watch.always) });
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => { unsubscribe(); for (const entry of active.values()) entry.stop(); active.clear(); };
}

export async function testDesktopNotification() {
  const bridge = desktopBridge();
  if (!bridge?.notify) throw new Error('请升级桌面版后重试');
  await bridge.notify({ title: 'Panecast 通知测试', body: '任务完成后，提醒会显示在这里。', force: true });
}
