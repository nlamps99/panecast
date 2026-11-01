import { DemoChannel } from '../demo/demoChannel';
import { parsePairingUrl } from '../protocol/pairing';
import { InboxStore } from '../session/inboxStore';
import { TerminalSession, type RpcChannel, type StatusSource } from '../session/terminalSession';
import { WorkspaceStore } from '../session/workspaceStore';
import { EMPTY_COMPUTER_LIST, selectedComputer, type ComputerList, type StoredComputer, type TransportPreference } from './computers';
import { createComputerChannel, PairingError, registerComputer, type ComputerChannel } from './connect';
import { loadComputers, saveComputers, storageSupported } from './pairingStorage';

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
};

function log(message: string) {
  if (__DEV__) console.log(`[relay] ${message}`);
}

function isComputerChannel(channel: unknown): channel is ComputerChannel {
  return typeof channel === 'object' && channel !== null && 'stop' in channel && 'wake' in channel;
}

/** App-wide pairing and connection state. One instance; React reads it with `useSyncExternalStore`. */
class AppStore {
  private state: AppStoreState = { phase: 'loading', computers: EMPTY_COMPUTER_LIST, machine: null };
  private listeners = new Set<() => void>();
  private loaded = false;

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
    let computers = EMPTY_COMPUTER_LIST;
    try {
      computers = await loadComputers();
    } catch (error) {
      log(`could not read computers: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.connect(computers);
  }

  /** Pairs with the computer described by a scanned `cmux://pair?...` URL and switches to it. */
  async pair(rawUrl: string): Promise<void> {
    if (!storageSupported) throw new PairingError('网页版还不能配对，请用手机 App。');
    const parsed = parsePairingUrl(rawUrl);
    if (!parsed.ok) {
      throw new PairingError(
        parsed.error.kind === 'missing_field'
          ? `二维码缺少 ${parsed.error.field} 字段，请在电脑上重新生成。`
          : '这不是 Panecast 的配对二维码。',
      );
    }
    const computer = await registerComputer(parsed.payload);
    // Re-pairing the same relay replaces its entry rather than adding a second one.
    const others = this.state.computers.computers.filter(
      (c) => !(c.broker.relayId === computer.broker.relayId && c.broker.serverUrl === computer.broker.serverUrl),
    );
    const computers: ComputerList = { ...this.state.computers, selectedId: computer.id, computers: [...others, computer] };
    await saveComputers(computers);
    this.connect(computers);
  }

  /** Forgets the current computer on this phone. Its broker entry stays until revoked there. */
  async unpair(): Promise<void> {
    const current = this.state.machine?.computer;
    if (!current) return;
    const remaining = this.state.computers.computers.filter((c) => c.id !== current.id);
    const computers: ComputerList = { ...this.state.computers, selectedId: remaining[0]?.id ?? null, computers: remaining };
    await saveComputers(computers);
    this.connect(computers);
  }

  /** Switches to another paired computer. */
  async select(computerId: string): Promise<void> {
    if (this.state.machine?.computer?.id === computerId) return;
    if (!this.state.computers.computers.some((c) => c.id === computerId)) return;
    const computers: ComputerList = { ...this.state.computers, selectedId: computerId };
    await saveComputers(computers);
    this.connect(computers);
  }

  /** Sets how to reach a computer (auto / broker / LAN); reconnects if it is the current one. */
  async setTransport(computerId: string, preference: TransportPreference): Promise<void> {
    const computers: ComputerList = {
      ...this.state.computers,
      transport: { ...this.state.computers.transport, [computerId]: preference },
    };
    await saveComputers(computers);
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
  }

  private connect(computers: ComputerList): void {
    const computer = selectedComputer(computers);
    if (!computer) {
      this.activate(computers, null);
      return;
    }
    const channel = createComputerChannel(computer, computers.transport?.[computer.id] ?? 'auto', log);
    this.activate(computers, channel ? { mode: 'relay', computer, channel, ...this.stores(channel) } : null);
  }

  private stores(channel: RpcChannel) {
    return {
      session: new TerminalSession(channel, { liveLines: 120, log }),
      workspaces: new WorkspaceStore(channel),
      inbox: new InboxStore(channel),
    };
  }

  private activate(computers: ComputerList, machine: Machine | null): void {
    const previous = this.state.machine;
    if (previous) {
      previous.session.setTarget(null);
      previous.session.dispose();
      previous.workspaces.dispose();
      previous.inbox.dispose();
      if (isComputerChannel(previous.channel)) previous.channel.stop();
    }
    this.setState({ phase: machine ? 'ready' : 'unpaired', computers, machine });
    if (machine && isComputerChannel(machine.channel)) machine.channel.start();
    else if (machine) void machine.workspaces.refresh();
  }

  private setState(state: AppStoreState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const appStore = new AppStore();
