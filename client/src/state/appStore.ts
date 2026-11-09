import { DemoChannel } from '../demo/demoChannel';
import { forgetInputs } from '../input/library';
import { forgetConversations } from '../session/conversationCache';
import { keyboardProfiles } from '../input/keyboardProfiles';
import { parsePairingUrl } from '../protocol/pairing';
import { forgetInbox, inboxStorageKey } from '../session/inboxPersistence';
import { InboxStore } from '../session/inboxStore';
import { TerminalSession, type RpcChannel, type StatusSource } from '../session/terminalSession';
import { WorkspaceStore } from '../session/workspaceStore';
import {
  EMPTY_COMPUTER_LIST,
  removeComputer,
  renameComputer,
  selectedComputer,
  upsertComputer,
  type ComputerList,
  type StoredComputer,
  type TransportPreference,
} from './computers';
import { createComputerChannel, PairingError, registerComputer, type ComputerChannel } from './connect';
import { loadComputers, saveComputers, storageSupported } from './pairingStorage';
import { getPrefs } from './prefs';
import { sessionMemory, surfaceMemoryKey } from './sessionMemory';
import { listSurfaces } from '../session/surfaces';
import { RpcCallError } from '../protocol/connection';
import { AccountError, accountRequest, accountServer, type AccountComputer, type AccountSession } from '../account/api';
import { loadAccount, saveAccount, signIn } from '../account/store';

export { PairingError } from './connect';

/** Everything that exists while connected to one Mac (or the demo). */
export type Machine = {
  mode: 'relay' | 'demo';
  /** The stored computer in relay mode; null in the demo. */
  computer: StoredComputer | null;
  channel: RpcChannel & StatusSource;
  session: TerminalSession;
  workspaces: WorkspaceStore;
  inbox: InboxStore;
};

export type AppStoreState = {
  /** `loading` until SecureStore has been read. */
  phase: 'loading' | 'unpaired' | 'ready';
  computers: ComputerList;
  machine: Machine | null;
  account: AccountSession | null;
  accountError: string | null;
};

function log(message: string) {
  if (__DEV__) console.log(`[relay] ${message}`);
}

function isComputerChannel(channel: unknown): channel is ComputerChannel {
  return typeof channel === 'object' && channel !== null && 'stop' in channel && 'wake' in channel;
}

/**
 * App-wide pairing and connection state. One instance (`appStore`); React
 * reads it with `useSyncExternalStore`. Exported for tests.
 */
export class AppStore {
  private state: AppStoreState = { phase: 'loading', computers: EMPTY_COMPUTER_LIST, machine: null, account: null, accountError: null };
  private listeners = new Set<() => void>();
  private loaded = false;
  private machineObservers: (() => void)[] = [];
  private restoreNavigation: string | null = null;
  private accountRefresh: Promise<void> | null = null;
  private accountGeneration = 0;
  private computerWrites: Promise<void> = Promise.resolve();

  getState = (): AppStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await sessionMemory.load();
    let computers = EMPTY_COMPUTER_LIST;
    try {
      computers = await loadComputers();
    } catch (error) {
      log(`could not read computers: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const account = await loadAccount();
      this.setState({ ...this.state, account });
      computers = { ...computers, computers: computers.computers.filter((c) => !c.accountId || (c.accountId === account?.user.id && c.broker.token === account?.token)) };
    } catch {
      computers = { ...computers, computers: computers.computers.filter((c) => !c.accountId) };
      this.setState({ ...this.state, accountError: '无法读取登录信息，请重新登录。' });
    }
    this.connect(computers);
    if (this.state.account) void this.refreshAccount().catch(() => {});
  }

  /** Pairs with the computer described by a scanned `cmux://pair?...` URL and switches to it. */
  async pair(rawUrl: string): Promise<void> {
    if (!storageSupported) throw new PairingError('请使用 Panecast 手机或桌面 App 连接电脑。');
    const parsed = parsePairingUrl(rawUrl);
    if (!parsed.ok) {
      throw new PairingError(
        parsed.error.kind === 'missing_field'
          ? `二维码缺少 ${parsed.error.field} 字段，请在电脑上重新生成。`
          : '这不是 Panecast 的配对二维码。',
      );
    }
    const account = this.state.account;
    if (account && accountServer(parsed.payload.serverUrl) === account.serverUrl) {
      await accountRequest(account.serverUrl, 'computers', 'POST', { relay_id: parsed.payload.relayId, pairing_code: parsed.payload.pairingCode }, account.token);
      this.invalidateAccountRefresh();
      await this.refreshAccount();
      const computer = this.state.computers.computers.find((c) => c.accountId === account.user.id && c.broker.relayId === parsed.payload.relayId);
      if (computer) await this.select(computer.id);
      return;
    }
    const registered = await registerComputer(parsed.payload);
    // Re-pairing the same relay replaces its credentials but keeps its id and name.
    const { list: computers } = upsertComputer(this.state.computers, registered);
    await this.persistComputers(computers);
    this.connect(computers);
  }

  /**
   * Forgets a computer on this phone; its broker entry stays until revoked
   * there. Removing the current one switches to the next paired computer, or
   * to the pairing screen when none is left. The demo stays the demo.
   */
  async remove(computerId: string): Promise<void> {
    const removed = this.state.computers.computers.find((c) => c.id === computerId);
    if (removed?.accountId) {
      const account = this.requireAccount();
      this.invalidateAccountRefresh();
      await accountRequest(account.serverUrl, `computers?relay_id=${encodeURIComponent(removed.broker.relayId)}`, 'DELETE', undefined, account.token);
    }
    const computers = removeComputer(this.state.computers, computerId);
    if (computers === this.state.computers) return;
    await this.persistComputers(computers);
    if (this.state.machine?.computer?.id === computerId) this.connect(computers);
    else this.setState({ ...this.state, computers });
    void forgetInbox(inboxStorageKey(computerId));
    void forgetInputs(computerId).catch(() => {});
    void forgetConversations(computerId).catch(() => {});
    sessionMemory.forgetComputer(computerId);
    void keyboardProfiles().forgetComputer(computerId);
  }

  /** Forgets the current computer. */
  async unpair(): Promise<void> {
    const current = this.state.machine?.computer;
    if (current) await this.remove(current.id);
  }

  /** Renames a computer; a blank name falls back to its relay id. The connection is untouched. */
  async rename(computerId: string, name: string): Promise<void> {
    const old = this.state.computers.computers.find((c) => c.id === computerId);
    if (old?.accountId) {
      const account = this.requireAccount();
      this.invalidateAccountRefresh();
      await accountRequest(account.serverUrl, `computers?relay_id=${encodeURIComponent(old.broker.relayId)}`, 'PATCH', { name: name.trim() || old.broker.relayId }, account.token);
    }
    const computers = renameComputer(this.state.computers, computerId, name);
    await this.persistComputers(computers);
    const renamed = computers.computers.find((c) => c.id === computerId);
    const machine = this.state.machine;
    this.setState({
      ...this.state,
      computers,
      machine: machine && renamed && machine.computer?.id === computerId ? { ...machine, computer: renamed } : machine,
    });
  }

  /** Switches to another paired computer (also from the demo). */
  async select(computerId: string): Promise<void> {
    if (this.state.machine?.computer?.id === computerId) return;
    if (!this.state.computers.computers.some((c) => c.id === computerId)) return;
    const computers: ComputerList = { ...this.state.computers, selectedId: computerId };
    await this.persistComputers(computers);
    this.connect(computers);
  }

  /** Sets how to reach a computer (auto / broker / LAN); reconnects if it is the current one. */
  async setTransport(computerId: string, preference: TransportPreference): Promise<void> {
    const computers: ComputerList = {
      ...this.state.computers,
      transport: { ...this.state.computers.transport, [computerId]: preference },
    };
    await this.persistComputers(computers);
    if (this.state.machine?.computer?.id === computerId) this.connect(computers);
    else this.setState({ ...this.state, computers });
  }

  /** A pretend Mac, for trying the app without pairing (and for App Review). */
  enterDemo(): void {
    if (this.state.machine?.mode === 'demo') return;
    const channel = new DemoChannel();
    this.activate(this.state.computers, { mode: 'demo', computer: null, channel, ...this.stores(channel) });
  }

  /** Leaves the demo for the selected computer if one is paired, otherwise for the pairing screen. */
  exitDemo(): void {
    if (this.state.machine?.mode !== 'demo') return;
    this.connect(this.state.computers);
  }

  /** Called when the app returns to the foreground. */
  wake(): void {
    const channel = this.state.machine?.channel;
    if (isComputerChannel(channel)) channel.wake();
    if (this.state.account) void this.refreshAccount().catch(() => {});
  }

  async login(server: string, username: string, password: string, create: boolean): Promise<void> {
    if (this.state.account) throw new Error('请先退出当前账号。');
    const account = await signIn(server, username, password, create);
    try { await saveAccount(account); }
    catch (error) { await accountRequest(account.serverUrl, 'logout', 'POST', undefined, account.token).catch(() => {}); throw error; }
    this.accountGeneration++;
    this.setState({ ...this.state, account, accountError: null });
    await this.refreshAccount();
  }

  refreshAccount(): Promise<void> {
    if (this.accountRefresh) return this.accountRefresh;
    const account = this.state.account;
    if (!account) return Promise.resolve();
    const generation = this.accountGeneration;
    const refresh = this.syncAccount(account, generation).finally(() => { if (this.accountRefresh === refresh) this.accountRefresh = null; });
    this.accountRefresh = refresh;
    return refresh;
  }

  private async syncAccount(account: AccountSession, generation: number): Promise<void> {
    try {
      const result = await accountRequest<{ computers: AccountComputer[] }>(account.serverUrl, 'computers', 'GET', undefined, account.token);
      if (generation !== this.accountGeneration) return;
      if (!Array.isArray(result.computers)) throw new Error('服务器返回的电脑列表无效。');
      const previous = this.state.computers;
      const local = previous.computers.filter((c) => !c.accountId && !(c.broker.serverUrl === account.serverUrl && result.computers.some((remote) => remote.relay_id === c.broker.relayId)));
      const computers: StoredComputer[] = result.computers.map((c) => {
        if (typeof c.relay_id !== 'string' || typeof c.device_id !== 'string' || typeof c.name !== 'string') throw new Error('服务器返回的电脑信息无效。');
        const existing = previous.computers.find((p) => (!p.accountId || p.accountId === account.user.id) && p.broker.serverUrl === account.serverUrl && p.broker.relayId === c.relay_id);
        return { id: existing?.id ?? `account:${account.user.id}:${c.relay_id}`, accountId: account.user.id, name: c.name, online: c.online,
          broker: { serverUrl: account.serverUrl, relayId: c.relay_id, deviceId: c.device_id, token: account.token }, pairedAt: c.paired_at };
      });
      const list: ComputerList = { ...previous, computers: [...local, ...computers] };
      if (!list.computers.some((c) => c.id === list.selectedId)) list.selectedId = list.computers[0]?.id ?? null;
      await this.persistComputers(list);
      if (generation !== this.accountGeneration) return;
      const current = this.state.machine?.computer;
      const updated = list.computers.find((c) => c.id === current?.id);
      if (this.state.machine?.mode !== 'demo' && (!current || !updated || current.broker.token !== updated.broker.token)) this.connect(list);
      else this.setState({ ...this.state, computers: list, machine: this.state.machine && updated ? { ...this.state.machine, computer: updated } : this.state.machine });
      this.setState({ ...this.state, accountError: null });
    } catch (error) {
      if (generation !== this.accountGeneration) return;
      if (error instanceof AccountError && error.status === 401) await this.clearAccount();
      this.setState({ ...this.state, accountError: error instanceof Error ? error.message : '同步失败，请重试。' });
      throw error;
    }
  }

  async bindExisting(computerId: string): Promise<void> {
    const account = this.requireAccount();
    const computer = this.state.computers.computers.find((c) => c.id === computerId);
    if (!computer || computer.accountId || accountServer(computer.broker.serverUrl) !== account.serverUrl) throw new Error('只能绑定当前服务器上已配对的电脑。');
    await accountRequest(account.serverUrl, 'computers', 'POST', { relay_id: computer.broker.relayId, device_token: computer.broker.token, name: computer.name }, account.token);
    this.invalidateAccountRefresh();
    await this.refreshAccount();
  }

  async logout(): Promise<void> {
    const account = this.requireAccount();
    this.invalidateAccountRefresh();
    try { await accountRequest(account.serverUrl, 'logout', 'POST', undefined, account.token); }
    catch (error) { if (!(error instanceof AccountError && error.status === 401)) throw error; }
    await this.clearAccount();
  }

  async changePassword(oldPassword: string, password: string): Promise<void> {
    const account = this.requireAccount();
    await accountRequest(account.serverUrl, 'password', 'POST', { old_password: oldPassword, password }, account.token);
  }

  async deleteAccount(password: string): Promise<void> {
    const account = this.requireAccount();
    await accountRequest(account.serverUrl, 'me', 'DELETE', { password }, account.token);
    await this.clearAccount();
  }

  private requireAccount(): AccountSession {
    if (!this.state.account) throw new Error('请先登录账号。');
    return this.state.account;
  }

  private async clearAccount(): Promise<void> {
    this.invalidateAccountRefresh();
    await saveAccount(null);
    const removed = this.state.computers.computers.filter((c) => c.accountId);
    const remaining = this.state.computers.computers.filter((c) => !c.accountId);
    const computers = { ...this.state.computers, computers: remaining, selectedId: remaining.some((c) => c.id === this.state.computers.selectedId) ? this.state.computers.selectedId : remaining[0]?.id ?? null };
    await this.persistComputers(computers);
    this.setState({ ...this.state, account: null, accountError: null });
    this.connect(computers);
    for (const computer of removed) {
      void forgetInbox(inboxStorageKey(computer.id));
      void forgetInputs(computer.id).catch(() => {});
      void forgetConversations(computer.id).catch(() => {});
      sessionMemory.forgetComputer(computer.id);
      void keyboardProfiles().forgetComputer(computer.id);
    }
  }

  private invalidateAccountRefresh(): void {
    this.accountGeneration++;
    this.accountRefresh = null;
  }

  private persistComputers(computers: ComputerList): Promise<void> {
    const write = this.computerWrites.then(() => saveComputers(computers));
    this.computerWrites = write.catch(() => {});
    return write;
  }

  private connect(computers: ComputerList): void {
    const computer = selectedComputer(computers);
    if (!computer) {
      this.activate(computers, null);
      return;
    }
    const channel = createComputerChannel(computer, computers.transport?.[computer.id] ?? 'auto', log);
    this.activate(computers, channel ? { mode: 'relay', computer, channel, ...this.stores(channel, computer) } : null);
  }

  /** The demo's inbox is not saved; a computer's inbox is, per computer. */
  private stores(channel: RpcChannel, computer: StoredComputer | null = null) {
    const memory = computer ? sessionMemory.computer(computer.id) : null;
    const session = new TerminalSession(channel, { liveLines: getPrefs().historyLines, log,
      ...(computer ? { readingForTarget: (target) => sessionMemory.computer(computer.id).reading[surfaceMemoryKey(target)] ?? null,
        saveReading: (target, position) => sessionMemory.rememberReading(computer.id, target, position) } : {}),
    });
    if (memory?.lastTarget) session.setTarget(memory.lastTarget);
    return {
      session,
      workspaces: new WorkspaceStore(channel, memory?.windowId ?? null),
      inbox: new InboxStore(channel, computer ? { storageKey: inboxStorageKey(computer.id) } : {}),
    };
  }

  private activate(computers: ComputerList, machine: Machine | null): void {
    for (const dispose of this.machineObservers) dispose();
    this.machineObservers = [];
    const previous = this.state.machine;
    if (previous) {
      previous.session.setTarget(null);
      previous.session.dispose();
      previous.workspaces.dispose();
      previous.inbox.dispose();
      if (isComputerChannel(previous.channel)) previous.channel.stop();
    }
    this.setState({ ...this.state, phase: machine ? 'ready' : 'unpaired', computers, machine });
    this.restoreNavigation = machine?.computer && (machine.session.getState().target || sessionMemory.computer(machine.computer.id).source) ? machine.computer.id : null;
    if (machine?.computer) this.observeMachine(machine);
    if (machine && isComputerChannel(machine.channel)) machine.channel.start();
    else if (machine) void machine.workspaces.refresh();
  }

  /** Consumed once by the tab layout; explicit notification/deep-link navigation wins. */
  takeRestoredRoute(computerId: string | null): '/terminal' | '/sources' | null {
    if (!computerId || this.restoreNavigation !== computerId) return null;
    this.restoreNavigation = null;
    const memory = sessionMemory.computer(computerId);
    return memory.lastView === 'source' && memory.source ? '/sources' : memory.lastTarget ? '/terminal' : null;
  }

  private observeMachine(machine: Machine): void {
    const computerId = machine.computer!.id;
    let lastTarget = machine.session.getState().target;
    let validated = false;
    const capture = () => {
      const target = machine.session.getState().target, state = machine.workspaces.getState();
      if (!target) { lastTarget = null; return; }
      const changed = !lastTarget || surfaceMemoryKey(lastTarget) !== surfaceMemoryKey(target);
      lastTarget = target;
      const workspace = state.workspaces.find((w) => w.id === target.workspaceId) ?? state.known.workspaces[target.workspaceId];
      const surface = (state.surfaces[target.workspaceId] ?? state.known.surfaces[target.workspaceId] ?? []).find((s) => s.id === target.surfaceId);
      const previous = sessionMemory.computer(computerId).recent.find((r) => surfaceMemoryKey(r) === surfaceMemoryKey(target));
      sessionMemory.visit(computerId, { ...target, title: surface?.title ?? previous?.title ?? '终端', workspaceTitle: workspace?.title ?? previous?.workspaceTitle ?? '工作区', windowId: state.workspaces.some((w) => w.id === target.workspaceId) ? state.selectedWindowId : previous?.windowId ?? null }, changed);
    };
    this.machineObservers.push(machine.session.subscribe(capture), machine.workspaces.subscribe(() => {
      const state = machine.workspaces.getState();
      if (state.loaded && !state.error && state.selectedWindowId) sessionMemory.rememberWindow(computerId, state.selectedWindowId);
      capture();
    }), machine.channel.onStatus((status) => {
      if (status.state !== 'open' || validated) return;
      validated = true;
      const target = machine.session.getState().target;
      if (!target) return;
      void listSurfaces(machine.channel, target.workspaceId).then((surfaces) => {
        if (surfaces.some((s) => s.id === target.surfaceId)) return;
        if (this.state.machine === machine && machine.session.getState().target === target) {
          sessionMemory.forgetTarget(computerId, target); machine.session.setTarget(null);
        }
      }).catch((error: unknown) => {
        if (error instanceof RpcCallError && ['not_found', 'workspace_not_found', 'surface_not_found'].includes(error.code) && this.state.machine === machine && machine.session.getState().target === target) {
          sessionMemory.forgetTarget(computerId, target); machine.session.setTarget(null);
        }
      });
    }));
  }

  private setState(state: AppStoreState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const appStore = new AppStore();
