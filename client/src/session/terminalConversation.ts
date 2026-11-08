import { RpcCallError } from '../protocol/connection';
import { agentItem } from './agentData';
import { itemText, type AgentItem } from './sourceStore';
import { describeError, type RpcChannel, type SendReceipt, type SurfaceTarget, type TerminalSession } from './terminalSession';
import { plainTerminalRows } from '../terminal/textTools';

export type TerminalChatSubmission = { id: string; text: string; status: 'sending' | SendReceipt['status']; at: number; base: number; message?: string };
export type TerminalConversationState = {
  target: SurfaceTarget | null; conversationId: string | null; generation: string; provider: string; name: string;
  available: boolean | null; items: AgentItem[]; revision: string | null; cursor: string | null; headSequence: number;
  loading: boolean; loadingOlder: boolean; active: boolean; error: string | null; historyError: string | null; blocked: boolean;
  branch: string | null;
  submissions: TerminalChatSubmission[]; output: string;
};
const same = (a: SurfaceTarget | null, b: SurfaceTarget | null) => a?.workspaceId === b?.workspaceId && a?.surfaceId === b?.surfaceId;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const optionalText = (value: unknown): string | null => typeof value === 'string' ? value : null;
const clean = (value: string) => value.replace(/\r\n/g, '\n').trim();
const initial = (target: SurfaceTarget | null): TerminalConversationState => ({ target, conversationId: null, generation: '', provider: 'terminal', name: '终端输出', available: null,
  items: [], revision: null, cursor: null, headSequence: 0, loading: false, loadingOlder: false, active: false, error: null, historyError: null, blocked: false, branch: null, submissions: [], output: '' });

/** Merge snapshots and older pages by stable record IDs, preserving late tool results. */
export function mergeTerminalItems(previous: readonly AgentItem[], incoming: readonly AgentItem[]): AgentItem[] {
  const map = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) {
    const old = map.get(item.id);
    if (!old) { map.set(item.id, item); continue; }
    const newest = (item.updatedSequence ?? item.sequence ?? 0) >= (old.updatedSequence ?? old.sequence ?? 0) ? item : old;
    const older = newest === item ? old : item;
    map.set(item.id, { ...older, ...newest, type: newest.type === 'toolExecution' && older.type !== 'toolExecution' ? older.type : newest.type,
      command: newest.command || older.command, tool: newest.tool || older.tool,
      changes: newest.changes?.length ? newest.changes : older.changes,
      aggregatedOutput: newest.aggregatedOutput || older.aggregatedOutput,
      sequence: Math.min(old.sequence ?? 0, item.sequence ?? 0) });
  }
  return [...map.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export class TerminalConversationStore {
  private state: TerminalConversationState;
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private active = false;
  private disposed = false;
  private generation = 0;
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private head: Promise<void> | null = null;
  private older: Promise<void> | null = null;
  private fallbackBaseline: readonly string[] | null = null;
  private historyStarted = false;
  private historyVersion = 0;

  constructor(private channel: RpcChannel, private terminal: TerminalSession) {
    this.state = initial(terminal.getState().target);
    this.disposers.push(terminal.subscribe(() => this.terminalChanged()), channel.onStatus(status => {
      if (status.state === 'open' && this.active) void this.refresh();
      else if (status.state !== 'open') {
        this.generation++; this.head = this.older = null;
        this.update({ loading: false, loadingOlder: false, active: false });
      }
    }));
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<TerminalConversationState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  start() { if (this.active) return; this.active = true; this.terminal.resumeLive(); this.terminalChanged(); void this.refresh(); }
  stop() { this.active = false; this.generation++; this.head = this.older = null; if (this.timer) clearTimeout(this.timer); this.timer = null; this.update({ loading: false, loadingOlder: false }); }
  dispose() { this.stop(); this.disposed = true; this.disposers.forEach(dispose => dispose()); this.listeners.clear(); }
  private terminalChanged() {
    const current = this.terminal.getState();
    if (!same(current.target, this.state.target)) {
      this.generation++; this.head = this.older = null; this.fallbackBaseline = null; this.historyStarted = false; this.update(initial(current.target));
      if (this.active) void this.refresh();
      return;
    }
    if (this.active && this.state.available === false && !this.state.blocked) {
      const rows = plainTerminalRows(current.screen.rows);
      let start = 0;
      if (this.fallbackBaseline) {
        // An ordinary shell appends output; keep the portion after the prior
        // screen prefix together instead of labelling it as an AI response.
        while (start < Math.min(rows.length, this.fallbackBaseline.length) && rows[start] === this.fallbackBaseline[start]) start++;
      }
      const output = rows.slice(start).join('\n').trim();
      if (output !== this.state.output) this.update({ output });
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.active && !this.disposed) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 1200);
  }
  refresh(): Promise<void> {
    if (this.head) return this.head;
    const target = this.state.target;
    if (!this.active || !target || !this.channel.isOpen || this.disposed) return Promise.resolve();
    const generation = this.generation;
    if (this.state.available === null) this.update({ loading: true });
    const task = this.read(target, generation, null).finally(() => {
      if (this.head === task) this.head = null;
      if (generation === this.generation) this.schedule();
    });
    this.head = task; return task;
  }
  loadOlder(): Promise<void> {
    if (this.older) return this.older;
    const target = this.state.target, cursor = this.state.cursor;
    if (!this.active || !target || !cursor || !this.channel.isOpen || this.disposed) return Promise.resolve();
    const generation = this.generation; this.historyStarted = true; this.update({ loadingOlder: true, historyError: null });
    const task = this.read(target, generation, cursor).finally(() => { if (this.older === task) this.older = null; });
    this.older = task; return task;
  }
  private async read(target: SurfaceTarget, generation: number, cursor: string | null) {
    const historyVersion = this.historyVersion;
    try {
      const raw = record(await this.channel.call('terminal.conversation', { workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: 80,
        ...(cursor ? { cursor } : { ...(this.state.revision ? { revision: this.state.revision } : {}), ...(this.state.branch ? { branch: this.state.branch } : {}) }) }, 15000));
      if (generation !== this.generation || this.disposed || !same(target, this.state.target)) return;
      if (cursor && historyVersion !== this.historyVersion) return;
      const id = optionalText(raw.conversation_id), epoch = optionalText(raw.generation) ?? '';
      if (cursor && (id !== this.state.conversationId || epoch !== this.state.generation)) { this.update({ loadingOlder: false }); return; }
      const changed = raw.reset === true || id !== this.state.conversationId || Boolean(epoch && this.state.generation && epoch !== this.state.generation);
      if (changed) { this.historyVersion++; this.historyStarted = false; this.older = null; }
      const parsed = Array.isArray(raw.items) ? raw.items.map(agentItem).filter((item): item is AgentItem => item !== null) : [];
      const items = raw.unchanged ? this.state.items : mergeTerminalItems(changed ? [] : this.state.items, parsed);
      const matched = new Set<string>();
      const submissions = (changed && this.state.conversationId && id !== this.state.conversationId ? [] : this.state.submissions).filter(submission => {
        const echo = submission.status !== 'not_sent' && items.find(item => !matched.has(item.id) && item.type === 'userMessage' && (item.sequence ?? 0) >= submission.base && clean(itemText(item)) === clean(submission.text));
        if (echo) matched.add(echo.id);
        return !echo;
      });
      this.update({ conversationId: id, generation: epoch, provider: optionalText(raw.provider) ?? 'terminal', name: optionalText(raw.name) ?? '终端输出',
        available: raw.available === true, items, submissions, loading: false, loadingOlder: cursor || changed ? false : this.state.loadingOlder, error: null, blocked: false,
        ...(!cursor ? { revision: optionalText(raw.revision), branch: optionalText(raw.branch), active: raw.active === true, headSequence: typeof raw.head_sequence === 'number' ? raw.head_sequence : this.state.headSequence } : {}),
        ...(!raw.unchanged && (cursor || changed || !this.historyStarted) ? { cursor: optionalText(raw.next_cursor) } : {}) });
      this.terminalChanged();
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const code = error instanceof RpcCallError ? error.code : '';
      const unsupported = ['method_not_found', '-32601'].includes(code);
      const blocked = ['source_revoked', 'invalid_target', 'read_only'].includes(code);
      if (cursor) { this.update({ loadingOlder: false, historyError: describeError(error) }); return; }
      this.update({ loading: false, loadingOlder: false, active: false, error: unsupported ? null : describeError(error), blocked,
        ...(unsupported ? { available: false, provider: 'terminal', name: '终端输出' } : {}),
        ...(blocked || /^conversation_/.test(code) ? { items: [], available: false } : {}) });
      if (unsupported) this.terminalChanged();
    }
  }
  async send(text: string): Promise<SendReceipt> {
    const target = this.state.target, current = this.terminal.getState().target;
    if (!text.trim()) return { status: 'not_sent', message: '请输入消息' };
    if (!target || !same(target, current) || this.state.blocked) return { status: 'not_sent', message: '终端已切换，草稿已保留' };
    const selection = this.terminal.selectionVersion;
    const id = `terminal-input:${Date.now()}:${++this.serial}`;
    const submission: TerminalChatSubmission = { id, text, at: Date.now(), base: this.state.headSequence, status: 'sending' };
    if (this.state.available === false) this.fallbackBaseline = plainTerminalRows(this.terminal.getState().screen.rows);
    this.update({ submissions: [...this.state.submissions, submission].slice(-40), ...(this.state.available === false ? { output: '' } : {}) });
    const receipt = await this.terminal.submitLine(text);
    if (!this.disposed && selection === this.terminal.selectionVersion && same(target, this.state.target)) {
      this.update({ submissions: this.state.submissions.map(item => item.id === id ? { ...item, status: receipt.status, message: receipt.message } : item) });
      if (this.active) void this.refresh();
    }
    return receipt;
  }
}
