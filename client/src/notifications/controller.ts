import * as Notifications from 'expo-notifications';
import type { AndroidImportance } from 'expo-notifications';

import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import type { InboxItem } from '../session/inboxStore';
import type { AppStoreState, Machine } from '../state/appStore';
import type { StoredComputer } from '../state/computers';
import { localNotificationData, localNotificationIdentifier, parseNotification, type NotificationInfo } from './payload';
import { behaviorFor, permissionFrom, presentationFor, shouldPostLocal, type PermissionState } from './policy';
import { notificationAllowed, notificationGroup, NotificationRulesStore } from './preferences';
import {
  apnsEnvironment,
  brokerTarget,
  describeRegistrationFailure,
  isApnsToken,
  registerApnsToken,
  relayTarget,
  type ApnsEnvironment,
  type RegistrationResult,
} from './registration';

/** One registration of the APNs token with one server. */
export type RegistrationOutcome =
  | { state: 'pending' }
  | { state: 'ok'; at: number; remembered?: boolean; forwarded?: boolean; pushEnabled?: boolean; preferencesApplied?: boolean }
  | { state: 'failed'; message: string };

/** Per paired computer. `relay` is null when the computer has no LAN pairing (no relay token). */
export type ComputerPush = { env: ApnsEnvironment; broker: RegistrationOutcome; relay: RegistrationOutcome | null };

export type TokenState =
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'ready' }
  | { state: 'failed'; message: string };

export type NotificationState = {
  /** `unsupported` on the web. */
  permission: PermissionState;
  /** The APNs device token (iOS only; the token itself is not exposed). */
  token: TokenState;
  push: Readonly<Record<string, ComputerPush>>;
};

/** What 设置 → 通知 shows about push for the current computer. */
export type PushSummary =
  | { kind: 'unsupported' }
  | { kind: 'demo' }
  | { kind: 'off' }
  | { kind: 'pending' }
  | { kind: 'token_failed'; message: string }
  | { kind: 'relay'; at: number; remembered: boolean }
  | { kind: 'broker_relay'; configured: boolean }
  | { kind: 'broker_only'; lanFailed: string | null }
  | { kind: 'failed'; message: string };

export function pushSummary(state: NotificationState, os: string, computerId: string | null): PushSummary {
  if (os !== 'ios') return { kind: 'unsupported' };
  if (!computerId) return { kind: 'demo' };
  if (state.permission.status !== 'granted') return { kind: 'off' };
  if (state.token.state === 'failed') return { kind: 'token_failed', message: state.token.message };
  const push = state.push[computerId];
  if (state.token.state !== 'ready' || !push) return { kind: 'pending' };
  if (push.broker.state === 'ok' && push.broker.forwarded) return { kind: 'broker_relay', configured: push.broker.pushEnabled === true };
  if (push.relay?.state === 'ok') return { kind: 'relay', at: push.relay.at, remembered: push.relay.remembered === true };
  if (push.relay?.state === 'pending' || push.broker.state === 'pending') return { kind: 'pending' };
  if (push.broker.state === 'ok') return { kind: 'broker_only', lanFailed: push.relay?.state === 'failed' ? push.relay.message : null };
  if (push.relay?.state === 'failed') return { kind: 'failed', message: push.relay.message };
  return { kind: 'failed', message: push.broker.state === 'failed' ? push.broker.message : '注册失败' };
}

type Store = {
  getState(): AppStoreState;
  subscribe(listener: () => void): () => void;
  select(computerId: string): Promise<void>;
};

type AppStateLike = {
  readonly currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type ConfirmButton = { text: string; style?: 'cancel' | 'default'; onPress?: () => void };

export type ControllerDeps = {
  os: string;
  isDev: boolean;
  store: Store;
  appState: AppStateLike;
  storage: KeyValueStorage;
  fetchImpl?: typeof fetch;
  confirm(title: string, message: string, buttons: ConfirmButton[]): void;
  openSettings(): Promise<void>;
  openSurface(machine: Machine, workspaceId: string, surfaceId: string): void;
  openAgent?(sourceId: string, threadId: string): void;
  /** Navigate to a tab: `/` (workspaces) or `/inbox`. */
  navigate(path: '/' | '/inbox'): void;
  log?: (message: string) => void;
};

/** Not secret: whether we already offered, and which relays took which token (by fingerprint). */
type Persisted = {
  version: 1;
  offered: boolean;
  relay: Record<string, { fingerprint: string; at: number }>;
};

const STORAGE_KEY = 'panecast.notifications.v1';
const ANDROID_CHANNEL = 'inbox';
/** `AndroidImportance.HIGH`: heads-up banners. Read as a value here, the enum trips `import/namespace`. */
const ANDROID_IMPORTANCE_HIGH = 6 as AndroidImportance;
/** A tap waits this long for its computer to connect, then is dropped. */
const TAP_TTL_MS = 30_000;
/** And this long for the workspace list to name a terminal in the workspace. */
const SURFACE_WAIT_MS = 10_000;
/** At most this many local notifications per inbox update. */
const LOCAL_BURST = 3;

type PendingTap = { info: NotificationInfo; at: number };

/**
 * Notification permission, the APNs token and its registration with each
 * paired computer, local notifications for new inbox items while in the
 * background, the foreground presentation policy, and tap routing. One
 * instance, started by `useNotificationRouting` in the root layout.
 */
export class NotificationController {
  private state: NotificationState;
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private machineDisposers: (() => void)[] = [];
  private machine: Machine | null = null;
  private computers: readonly StoredComputer[] = [];
  private loaded: Promise<void> | null = null;
  private persisted: Persisted = { version: 1, offered: false, relay: {} };
  private persistedLoaded = false;
  /** Kept out of `state`: React and logs never see it. */
  private token: string | null = null;
  private tokenRequest: Promise<void> | null = null;
  /** Per computer: token + credentials last registered, so a change re-registers. */
  private attempted = new Map<string, string>();
  private inFlight = new Map<string, Promise<void>>();
  private seen = new Set<string>();
  private handledResponses = new Set<string>();
  private pendingTap: PendingTap | null = null;
  private cancelWait: (() => void) | null = null;
  private channelReady: Promise<void> | null = null;
  private wasActive: boolean;
  private route = '/';
  private offerPending = false;
  private started = false;
  private rulesByComputer = new Map<string, NotificationRulesStore>();
  private alertGroups = new Map<string, number>();
  private reminders = new Set<string>();
  private cancelledReminders = new Set<string>();

  rules(computerId: string): NotificationRulesStore {
    let store = this.rulesByComputer.get(computerId);
    if (!store) {
      store = new NotificationRulesStore(`panecast.notification-rules.v1.${computerId}`, this.deps.storage);
      this.rulesByComputer.set(computerId, store);
      store.subscribe(() => { if (this.started) { this.attempted.delete(computerId); this.syncComputers(); } });
      void store.load();
    }
    return store;
  }

  allowsItem(item: InboxItem, computerId: string | null): boolean {
    return !computerId || notificationAllowed(this.rules(computerId).getState().preferences, item);
  }

  constructor(private readonly deps: ControllerDeps) {
    this.wasActive = deps.appState.currentState === 'active';
    const supported = deps.os === 'ios' || deps.os === 'android';
    this.state = {
      permission: { status: supported ? 'unknown' : 'unsupported', canAskAgain: supported },
      token: { state: 'none' },
      push: {},
    };
  }

  get supported(): boolean {
    return this.deps.os === 'ios' || this.deps.os === 'android';
  }

  /** APNs only; Android has no push here (no Google Play services, so no FCM). */
  private get pushCapable(): boolean {
    return this.deps.os === 'ios';
  }

  private get appActive(): boolean {
    return this.deps.appState.currentState === 'active';
  }

  getState = (): NotificationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started || !this.supported) return;
    this.started = true;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => behaviorFor(this.presentation(parseNotification(notification))),
    });
    const responses = Notifications.addNotificationResponseReceivedListener((response) => this.onResponse(response));
    const appState = this.deps.appState.addEventListener('change', (next) => this.onAppState(next));
    this.disposers.push(
      () => responses.remove(),
      () => appState.remove(),
      this.deps.store.subscribe(() => this.onStore()),
    );
    if (this.pushCapable) {
      const tokens = Notifications.addPushTokenListener((token) => this.onToken(token.data));
      this.disposers.push(() => tokens.remove());
    }
    this.loaded ??= this.loadPersisted();
    this.onStore();
    // Launched by tapping a notification: the listener above missed it.
    const last = Notifications.getLastNotificationResponse();
    if (last) this.onResponse(last);
    void this.boot();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    Notifications.setNotificationHandler(null);
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.watchMachine(null);
    this.cancelWait?.();
  }

  private async boot(): Promise<void> {
    await this.loaded;
    await this.refreshPermission();
    this.maybeOffer();
  }

  // MARK: Actions (设置 → 通知, and the one-time offer)

  /** Asks for permission (or opens system settings if the user said no for good), then registers for push. */
  async enable(): Promise<void> {
    if (!this.supported) return;
    this.offerPending = false;
    if (!this.persisted.offered) this.persist({ offered: true });
    const { permission } = this.state;
    if (permission.status === 'denied' && !permission.canAskAgain) {
      await this.openSettings();
      return;
    }
    if (permission.status === 'granted') {
      this.obtainToken();
      return;
    }
    // Android 13+ shows no prompt until a channel exists.
    await this.ensureChannel();
    try {
      const response = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
      this.applyPermission(permissionFrom(response));
    } catch (error) {
      this.log(`permission request failed: ${message(error)}`);
    }
  }

  async openSettings(): Promise<void> {
    try {
      await this.deps.openSettings();
    } catch (error) {
      this.log(`could not open settings: ${message(error)}`);
    }
  }

  async remindLater(item: InboxItem, computerId: string, minutes = 15): Promise<string> {
    if (!this.supported || this.state.permission.status !== 'granted') throw new Error('请先在设置中开启通知权限');
    await this.ensureChannel();
    if (item.reminderId) await Notifications.cancelScheduledNotificationAsync(item.reminderId);
    return Notifications.scheduleNotificationAsync({
      identifier: `reminder.${computerId}.${item.id}`,
      content: { title: `待处理：${item.title}`, body: item.body || '点按返回对应终端', sound: 'default', data: { ...localNotificationData(item, computerId), reminder: 'true' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: minutes * 60, channelId: ANDROID_CHANNEL },
    });
  }

  async cancelReminder(id: string | null | undefined): Promise<void> {
    if (id && this.supported) await Notifications.cancelScheduledNotificationAsync(id);
  }

  async testPush(): Promise<string> {
    if (this.state.permission.status !== 'granted') throw new Error('请先开启通知权限');
    if (this.deps.os === 'android') {
      await this.ensureChannel();
      await Notifications.scheduleNotificationAsync({
        content: { title: 'Panecast 通知测试', body: '本机提醒可以正常显示。', data: { reminder: 'true' } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5, channelId: ANDROID_CHANNEL },
      });
      return '已安排 5 秒后的本机提醒，可以切到后台检查';
    }
    const computer = this.machine?.computer;
    if (!computer) throw new Error('请先连接真实电脑');
    const target = brokerTarget(computer);
    if (!target) throw new Error('服务器地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const url = new URL(target.url);
      url.pathname += '/test';
      const response = await (this.deps.fetchImpl ?? fetch)(url.toString(), { method: 'POST', headers: { Authorization: `Bearer ${target.bearer}`, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
      const result = await response.json().catch(() => ({ error: response.status === 404 ? 'not_found' : 'request_failed' }));
      if (!response.ok || result.accepted !== true) throw new Error(pushTestError(result.error));
      return 'Apple 已接收测试通知，请检查手机是否收到。接收成功后即可确认这条推送链路。';
    } catch (error) {
      if (controller.signal.aborted) throw new Error('测试超时，请检查服务器和电脑连接，并确认 relay 已升级');
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** Registers again with the current computer (and retries the token if that failed). */
  retry(): void {
    if (this.state.token.state === 'failed') {
      this.obtainToken();
      return;
    }
    const id = this.machine?.computer?.id;
    if (id) this.attempted.delete(id);
    this.syncComputers();
  }

  /** The pathname, so the offer does not interrupt typing and the foreground policy knows the screen. */
  setRoute(route: string): void {
    if (route === this.route) return;
    this.route = route;
    this.maybeOffer();
  }

  // MARK: Permission and token

  private async refreshPermission(): Promise<void> {
    try {
      this.applyPermission(permissionFrom(await Notifications.getPermissionsAsync()));
    } catch (error) {
      this.log(`could not read notification permission: ${message(error)}`);
    }
  }

  private applyPermission(permission: PermissionState): void {
    const previous = this.state.permission;
    if (previous.status !== permission.status || previous.canAskAgain !== permission.canAskAgain) {
      this.patchState({ permission });
    }
    if (permission.status === 'granted') this.obtainToken();
  }

  /** iOS: asks APNs for the device token (registerForRemoteNotifications under the hood). Retried on each foreground until it works. */
  private obtainToken(): void {
    if (!this.pushCapable || this.token || this.tokenRequest) return;
    this.patchState({ token: { state: 'pending' } });
    this.tokenRequest = Notifications.getDevicePushTokenAsync()
      .then(
        (token) => this.onToken(token.data),
        (error: unknown) => {
          this.log(`APNs registration failed: ${message(error)}`);
          this.patchState({ token: { state: 'failed', message: '无法向 Apple 注册推送' } });
        },
      )
      .finally(() => {
        this.tokenRequest = null;
      });
  }

  /** A new token (first one, or APNs rolled it): register it with every paired computer. */
  private onToken(data: unknown): void {
    if (!isApnsToken(data)) {
      this.patchState({ token: { state: 'failed', message: '推送令牌格式不对' } });
      return;
    }
    const changed = data !== this.token;
    this.token = data;
    if (this.state.token.state !== 'ready') this.patchState({ token: { state: 'ready' } });
    if (changed) this.syncComputers();
  }

  // MARK: Registration with each computer

  private get env(): ApnsEnvironment {
    return apnsEnvironment(this.deps.isDev);
  }

  /** Changes when the token or any credential the registration uses changes. Memory only. */
  private signature(computer: StoredComputer): string {
    const { broker, lan } = computer;
    return [this.token ?? '', this.env, broker.serverUrl, broker.relayId, broker.token, lan?.url ?? '', lan?.token ?? '', JSON.stringify(this.rules(computer.id).getState().preferences)].join('\n');
  }

  /** Registers the token with every paired computer that has not had this token and these credentials yet. */
  private syncComputers(): void {
    if (!this.token || this.deps.store.getState().phase === 'loading') return;
    for (const computer of this.computers) {
      if (!this.rules(computer.id).getState().loaded) continue;
      if (this.attempted.get(computer.id) !== this.signature(computer)) this.register(computer);
    }
  }

  private register(computer: StoredComputer): void {
    const token = this.token;
    if (!token || this.inFlight.has(computer.id)) return;
    this.attempted.set(computer.id, this.signature(computer));
    const run = this.registerNow(computer, token).finally(() => {
      this.inFlight.delete(computer.id);
      // The token or the pairing may have changed meanwhile.
      this.syncComputers();
    });
    this.inFlight.set(computer.id, run);
  }

  private async registerNow(computer: StoredComputer, token: string): Promise<void> {
    await this.loaded;
    const env = this.env;
    const broker = brokerTarget(computer);
    const relay = relayTarget(computer);
    this.patchPush(computer.id, { env, broker: { state: 'pending' }, relay: relay ? { state: 'pending' } : null });
    const options = { fetchImpl: this.deps.fetchImpl, preferences: this.rules(computer.id).getState().preferences };
    const brokerRun = broker ? registerApnsToken(broker, token, env, options) : null;
    // Off the Mac's Wi-Fi this cannot connect; do not hang on it.
    const relayRun = relay ? registerApnsToken(relay, token, env, { ...options, timeoutMs: 8_000 }) : null;
    const brokerResult = brokerRun ? await brokerRun : null;
    const relayResult = relayRun ? await relayRun : null;
    // Unpaired meanwhile, or APNs rolled the token: a newer attempt reports instead.
    if (token !== this.token || !this.computers.some((c) => c.id === computer.id)) return;

    const brokerOutcome: RegistrationOutcome = brokerResult
      ? outcome(brokerResult, 'broker')
      : { state: 'failed', message: '服务器地址无效' };
    const relayOutcome = relayResult ? this.relayOutcome(computer.id, relayResult, fingerprintOf(`${token}|${JSON.stringify(options.preferences)}`, env)) : null;
    this.log(`push registration for ${computer.name}: broker ${brokerOutcome.state}, relay ${relayOutcome?.state ?? 'none'}`);
    this.patchPush(computer.id, { env, broker: brokerOutcome, relay: relayOutcome });
  }

  /**
   * The relay keeps the token across launches, so a relay that took this
   * token before still has it when the phone is away from the Mac's Wi-Fi.
   */
  private relayOutcome(computerId: string, result: RegistrationResult, fingerprint: string): RegistrationOutcome {
    const record = this.persisted.relay[computerId];
    if (result.ok) {
      const at = Date.now();
      this.persist({ relay: { ...this.persisted.relay, [computerId]: { fingerprint, at } } });
      return { state: 'ok', at, ...(result.preferencesApplied ? { preferencesApplied: true } : {}) };
    }
    const unreachable = result.reason === 'network' || result.reason === 'timeout';
    if (unreachable && record?.fingerprint === fingerprint) return { state: 'ok', at: record.at, remembered: true };
    if (record && result.reason === 'unauthorized') {
      const { [computerId]: _dropped, ...rest } = this.persisted.relay;
      this.persist({ relay: rest });
    }
    return outcome(result, 'relay');
  }

  // MARK: App store

  private onStore(): void {
    const { machine, computers, phase } = this.deps.store.getState();
    if (machine !== this.machine) this.watchMachine(machine);
    if (computers.computers !== this.computers) {
      this.computers = computers.computers;
      if (phase !== 'loading') this.prune();
      this.syncComputers();
    }
  }

  /** Forgets registrations of computers that are no longer paired. */
  private prune(): void {
    if (!this.persistedLoaded) return;
    const ids = new Set(this.computers.map((c) => c.id));
    void Notifications.getAllScheduledNotificationsAsync().then(async (requests) => {
      for (const request of requests) {
        const data = request.content.data;
        if (request.identifier.startsWith('reminder.') && typeof data?.computer_id === 'string' && !ids.has(data.computer_id)) {
          await Notifications.cancelScheduledNotificationAsync(request.identifier);
        }
      }
    }).catch(() => {});
    for (const id of [...this.attempted.keys()]) if (!ids.has(id)) this.attempted.delete(id);
    const push = Object.fromEntries(Object.entries(this.state.push).filter(([id]) => ids.has(id)));
    if (Object.keys(push).length !== Object.keys(this.state.push).length) this.patchState({ push });
    const relay = Object.fromEntries(Object.entries(this.persisted.relay).filter(([id]) => ids.has(id)));
    if (Object.keys(relay).length !== Object.keys(this.persisted.relay).length) this.persist({ relay });
  }

  private watchMachine(machine: Machine | null): void {
    for (const dispose of this.machineDisposers) dispose();
    this.machineDisposers = [];
    this.machine = machine;
    if (!machine) return;
    // Only items that arrive from now on are new.
    this.seen = new Set(machine.inbox.getState().items.map((item) => item.id));
    this.reminders = new Set(machine.inbox.getState().items.flatMap((item) => item.reminderId && !item.resolvedAt ? [item.reminderId] : []));
    this.machineDisposers.push(
      machine.inbox.subscribe(() => this.syncReminders(machine)),
      machine.inbox.onNew((item) => this.onInbox(machine, [item])),
      machine.channel.onStatus((status) => {
        if (status.state === 'open') this.retryFailed(machine);
      }),
    );
  }

  /** The socket is back: registrations that failed for this computer get another try. */
  private retryFailed(machine: Machine): void {
    const id = machine.computer?.id;
    const push = id ? this.state.push[id] : undefined;
    if (!id || !push || this.inFlight.has(id)) return;
    if (push.broker.state !== 'failed' && push.relay?.state !== 'failed') return;
    this.attempted.delete(id);
    this.syncComputers();
  }

  // MARK: Inbox → local notifications

  private syncReminders(machine: Machine): void {
    if (machine !== this.machine) return;
    const { items } = machine.inbox.getState();
    const currentReminders = new Set(items.flatMap((item) => item.reminderId && !item.resolvedAt ? [item.reminderId] : []));
    for (const id of currentReminders) this.cancelledReminders.delete(id);
    for (const item of items) if (item.resolvedAt && item.reminderId && !this.cancelledReminders.has(item.reminderId)) {
      this.cancelledReminders.add(item.reminderId);
      void this.cancelReminder(item.reminderId).catch(() => { this.cancelledReminders.delete(item.reminderId!); });
    }
    for (const id of this.reminders) if (!currentReminders.has(id)) void this.cancelReminder(id).catch(() => {});
    this.reminders = currentReminders;
  }

  private onInbox(machine: Machine, candidates: readonly InboxItem[]): void {
    if (machine !== this.machine) return;
    const { items } = machine.inbox.getState();
    const fresh = candidates.filter((item) => !item.read && !item.resolvedAt);
    this.seen = new Set(items.map((item) => item.id));
    // The demo's sample notifications should neither prompt nor post.
    const computer = machine.computer;
    if (fresh.length === 0 || machine.mode === 'demo' || !computer) return;

    if (!this.persisted.offered) {
      this.offerPending = true;
      this.maybeOffer();
    }
    const post = shouldPostLocal({
      os: this.deps.os,
      appActive: this.appActive,
      permission: this.state.permission.status,
      relayPushes: this.state.push[computer.id]?.relay?.state === 'ok' || brokerPushes(this.state.push[computer.id]),
    });
    if (!post) return;
    const rules = this.rules(computer.id).getState().preferences;
    for (const [key, at] of this.alertGroups) if (Date.now() - at > 3600_000) this.alertGroups.delete(key);
    for (const item of fresh.slice(0, LOCAL_BURST)) {
      if (!notificationAllowed(rules, item)) continue;
      const key = `${computer.id}:${notificationGroup(item)}`;
      if (rules.dedupe_seconds && Date.now() - (this.alertGroups.get(key) ?? -Infinity) < rules.dedupe_seconds * 1000) continue;
      this.alertGroups.set(key, Date.now()); void this.postLocal(item, computer.id);
    }
  }

  private async postLocal(item: InboxItem, computerId: string): Promise<void> {
    await this.ensureChannel();
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: localNotificationIdentifier(item, computerId),
        content: {
          title: item.title,
          subtitle: item.subtitle,
          body: item.body || null,
          data: localNotificationData(item, computerId),
          sound: 'default',
          threadIdentifier: item.workspaceId ? `${computerId}.${item.workspaceId}` : computerId,
        },
        trigger: this.deps.os === 'android' ? { channelId: ANDROID_CHANNEL } : null,
      });
    } catch (error) {
      this.log(`local notification failed: ${message(error)}`);
    }
  }

  /** Android: the channel local notifications post to; created on first use. */
  private ensureChannel(): Promise<void> {
    if (this.deps.os !== 'android') return Promise.resolve();
    this.channelReady ??= Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
      name: '收件箱通知',
      description: 'cmux 发来的通知，比如任务完成、agent 在等你回复',
      importance: ANDROID_IMPORTANCE_HIGH,
    }).then(
      () => undefined,
      (error: unknown) => {
        this.channelReady = null;
        this.log(`could not create the notification channel: ${message(error)}`);
      },
    );
    return this.channelReady;
  }

  // MARK: App state and the one-time offer

  private onAppState(next: string): void {
    const active = next === 'active';
    if (active === this.wasActive) return;
    this.wasActive = active;
    if (!active) return;
    if (this.machine) void this.machine.inbox.sync();
    // The user may have changed it in system settings.
    void this.refreshPermission().then(() => this.maybeOffer());
  }

  /**
   * After the first notification lands in the inbox, offer once to turn
   * notifications on (rather than asking at first launch). Waits until the app
   * is in front and not on the terminal, where an alert would interrupt typing.
   */
  private maybeOffer(): void {
    if (!this.offerPending || !this.persistedLoaded) return;
    const { status } = this.state.permission;
    if (status === 'unknown') return;
    if (this.persisted.offered || status !== 'undetermined') {
      this.offerPending = false;
      return;
    }
    if (!this.appActive || this.route === '/terminal' || this.route === '/pair') return;
    this.offerPending = false;
    this.persist({ offered: true });
    this.deps.confirm('开启通知？', '电脑上的任务完成、或者 agent 在等你回复时，即使没在看 App 也能收到提醒。', [
      { text: '以后再说', style: 'cancel' },
      { text: '开启', onPress: () => void this.enable() },
    ]);
  }

  // MARK: Taps

  private onResponse(response: Notifications.NotificationResponse): void {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = `${response.notification.request.identifier}@${response.notification.date}`;
    if (this.handledResponses.has(key)) return;
    this.handledResponses.add(key);
    Notifications.clearLastNotificationResponse();
    this.pendingTap = { info: parseNotification(response.notification), at: Date.now() };
    this.flushTap();
  }

  /**
   * Opens what a tapped notification points at once its computer is the
   * connected one. Switches computers first if the notification names another
   * one. Called on a tap, and by the root layout after each render that
   * changes the machine (navigating needs the tabs to be mounted).
   */
  flushTap(): void {
    const tap = this.pendingTap;
    if (!tap) return;
    if (Date.now() - tap.at > TAP_TTL_MS) {
      this.pendingTap = null;
      return;
    }
    const { phase, machine, computers } = this.deps.store.getState();
    if (phase === 'unpaired') this.pendingTap = null;
    if (phase !== 'ready' || !machine) return;
    const computer = computerFor(tap.info, computers.computers);
    // Names a computer this phone is no longer paired with.
    if (computer === undefined) {
      this.pendingTap = null;
      return;
    }
    if (computer && computer.id !== machine.computer?.id) {
      void this.deps.store.select(computer.id);
      return;
    }
    this.pendingTap = null;
    this.openTap(machine, tap.info);
  }

  private openTap(machine: Machine, info: NotificationInfo): void {
    if (info.notificationId) {
      const item = machine.inbox.getState().items.find((i) => i.id === info.notificationId);
      if (item && !item.read) machine.inbox.markRead(item.id);
    }
    if (info.sourceId && info.threadId && this.deps.openAgent) { this.deps.openAgent(info.sourceId, info.threadId); return; }
    const { workspaceId } = info;
    if (!workspaceId) {
      this.deps.navigate('/inbox');
      return;
    }
    const surfaceId = info.surfaceId ?? focusedSurface(machine, workspaceId);
    if (surfaceId) this.deps.openSurface(machine, workspaceId, surfaceId);
    else this.waitForSurface(machine, workspaceId);
  }

  /**
   * The notification names no terminal and the workspace list has none for
   * its workspace yet: on a cold start the list is still loading, or the
   * workspace is newer than the list. Wait for a fresh list, else show the
   * workspaces.
   */
  private waitForSurface(machine: Machine, workspaceId: string): void {
    this.cancelWait?.();
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(null), SURFACE_WAIT_MS);
    const finish = (surfaceId: string | null) => {
      clearTimeout(timer);
      unsubscribe();
      this.cancelWait = null;
      if (this.machine !== machine) return;
      if (surfaceId) this.deps.openSurface(machine, workspaceId, surfaceId);
      else this.deps.navigate('/');
    };
    const check = () => {
      const surfaceId = focusedSurface(machine, workspaceId);
      const { loaded, loading } = machine.workspaces.getState();
      if (surfaceId) finish(surfaceId);
      else if (loaded && !loading) finish(null);
    };
    unsubscribe = machine.workspaces.subscribe(check);
    this.cancelWait = () => {
      clearTimeout(timer);
      unsubscribe();
      this.cancelWait = null;
    };
    const { loaded, loading } = machine.workspaces.getState();
    // Nothing would change on its own; refetch. (Before the socket opens this is a no-op, and the open refetches.)
    if (loaded && !loading) void machine.workspaces.refresh();
  }

  // MARK: Foreground presentation

  private presentation(info: NotificationInfo) {
    const { machine } = this.deps.store.getState();
    if (!info.reminder && machine?.computer) {
      const item = machine.inbox.getState().items.find((item) => item.id === info.notificationId);
      const rules = this.rules(machine.computer.id).getState().preferences;
      if (!notificationAllowed(rules, item ?? { workspaceId: info.workspaceId, threadId: info.threadId, needsInput: info.needsInput === true })) return 'hide';
    }
    return presentationFor(info, {
      appActive: this.appActive,
      route: this.route,
      computerId: machine?.computer?.id ?? null,
      relayId: machine?.computer?.broker.relayId ?? null,
      workspaceIds: machine ? machine.workspaces.getState().workspaces.map((w) => w.id) : [],
      target: machine?.session.getState().target ?? null,
      connected: machine?.channel.status.state === 'open',
    });
  }

  // MARK: State and storage

  private patchState(patch: Partial<NotificationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchPush(computerId: string, push: ComputerPush): void {
    this.patchState({ push: { ...this.state.push, [computerId]: push } });
  }

  private async loadPersisted(): Promise<void> {
    try {
      const stored = parsePersisted(await this.deps.storage.getItem(STORAGE_KEY));
      // Anything written before the read finished wins over what was stored.
      if (stored) {
        this.persisted = {
          version: 1,
          offered: stored.offered || this.persisted.offered,
          relay: { ...stored.relay, ...this.persisted.relay },
        };
      }
    } catch (error) {
      this.log(`could not read notification settings: ${message(error)}`);
    }
    this.persistedLoaded = true;
    if (this.deps.store.getState().phase !== 'loading') this.prune();
    this.maybeOffer();
  }

  private persist(patch: Partial<Omit<Persisted, 'version'>>): void {
    this.persisted = { ...this.persisted, ...patch };
    void (async () => {
      await this.loaded;
      try {
        await this.deps.storage.setItem(STORAGE_KEY, JSON.stringify(this.persisted));
      } catch (error) {
        this.log(`could not save notification settings: ${message(error)}`);
      }
    })();
  }

  private log(text: string): void {
    this.deps.log?.(`[notifications] ${text}`);
  }
}

function outcome(result: RegistrationResult, via: 'broker' | 'relay'): RegistrationOutcome {
  return result.ok ? { state: 'ok', at: Date.now(), ...(result.forwarded ? { forwarded: true, pushEnabled: result.pushEnabled } : {}), ...(result.preferencesApplied ? { preferencesApplied: true } : {}) } : { state: 'failed', message: describeRegistrationFailure(result, via) };
}

function brokerPushes(push: ComputerPush | undefined): boolean {
  return push?.broker.state === 'ok' && push.broker.forwarded === true && push.broker.pushEnabled === true;
}
function pushTestError(code: unknown): string {
  const messages: Record<string, string> = {
    apns_not_configured: '电脑还没有配置 Apple 推送，请完成推送配置后重试',
    push_not_registered: '请先点击「重新注册推送」，再测试',
    invalid_push_token_or_topic: 'Apple 拒绝了推送令牌，请检查电脑上的 App 标识和推送环境后重新注册',
    relay_offline: '电脑离线，请先恢复连接',
    push_relay_timeout_or_upgrade_required: '电脑没有回复，请确认 relay 已升级并在线',
    apns_request_failed_check_relay_config: '电脑无法发送到 Apple，请检查推送配置和网络',
    not_found: '服务器尚不支持测试推送，请升级 broker 和 relay',
  };
  return typeof code === 'string' ? messages[code] ?? `推送失败：${code}` : '推送测试失败，请检查电脑端配置';
}

/** null: the notification names no computer (use the current one). undefined: it names one that is not paired. */
function computerFor(info: NotificationInfo, computers: readonly StoredComputer[]): StoredComputer | null | undefined {
  if (info.computerId) return computers.find((c) => c.id === info.computerId);
  if (info.relayId) return computers.find((c) => c.broker.relayId === info.relayId);
  return null;
}

function focusedSurface(machine: Machine, workspaceId: string): string | null {
  const surfaces = machine.workspaces.getState().surfaces[workspaceId] ?? [];
  return (surfaces.find((s) => s.focused) ?? surfaces[0])?.id ?? null;
}

/** A one-way fingerprint, so the stored record does not hold the APNs token. */
function fingerprintOf(token: string, env: ApnsEnvironment): string {
  return toHex(sha256(utf8Encode(`${env}:${token}`))).slice(0, 16);
}

function parsePersisted(raw: string | null): Persisted | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Persisted>;
    if (value.version !== 1) return null;
    const relay: Persisted['relay'] = {};
    if (typeof value.relay === 'object' && value.relay !== null) {
      for (const [id, record] of Object.entries(value.relay)) {
        if (typeof record?.fingerprint === 'string' && typeof record.at === 'number') relay[id] = record;
      }
    }
    return { version: 1, offered: value.offered === true, relay };
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
