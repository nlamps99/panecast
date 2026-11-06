import { RpcCallError } from '../protocol/connection';
import type { EventFrame } from '../protocol/frames';
import { describeError, type RpcChannel } from './terminalSession';
import { agentItem, agentThread, agentTurn, agentTurns } from './agentData';
import { currentAgentTurn, newAgentMessageId } from './agentInput';
import type { ConversationCache, PreparedHistory } from './conversationCache';

export type SourceInfo = {
  id: string; name: string; type: 'cmux' | 'tmux' | 'codex'; access: 'read' | 'control'; enabled: boolean;
  status: 'online' | 'offline' | 'unknown' | 'revoked'; mode: 'terminal' | 'attach' | 'managed' | 'history'; error?: string;
  capabilities: { read: boolean; control: boolean; realtime: boolean; create: boolean; resume?: boolean };
};
export type AgentProject = { id: string; name: string; cwd: string };
export type AgentThread = { id: string; name: string; cwd: string; status?: { type: string }; updatedAt?: number; live?: boolean };
export type AgentItem = { id: string; type: string; clientId?: string; text?: string; content?: { type: string; text?: string }[];
  command?: string; aggregatedOutput?: string; status?: string; changes?: { path: string; diff?: string }[]; server?: string; tool?: string; truncated?: boolean };
export type AgentTurn = { id: string; status: string; items: AgentItem[]; error?: { message?: string }; omittedItems?: number };
export type AgentRequest = { id: string; method: string; supported: boolean;
  params: { threadId?: string; command?: string; reason?: string; questions?: { id: string; header: string; question: string; options?: { label: string; description?: string }[] }[] } };
export type AgentSubmission = { id: string; text: string; mode: 'start' | 'steer'; status: 'sending' | 'accepted' | 'unknown' };
export type SourceState = {
  supported: boolean | null; sources: SourceInfo[]; sourceId: string | null; threads: AgentThread[]; threadCursor: string | null;
  thread: AgentThread | null; turns: AgentTurn[]; historyCursor: string | null; requests: AgentRequest[];
  loading: boolean; busy: boolean; error: string | null;
  projects: AgentProject[]; projectsLoading: boolean;
  activeTurnId: string | null; submissions: AgentSubmission[];
  fromCache: boolean; threadVerified: boolean; historyLoading: boolean; historyError: string | null;
};

export class SourceStore {
  private state: SourceState = { supported: null, sources: [], sourceId: null, threads: [], threadCursor: null, thread: null, turns: [], historyCursor: null, requests: [], loading: false, busy: false, error: null, projects: [], projectsLoading: false, activeTurnId: null, submissions: [], fromCache: false, threadVerified: false, historyLoading: false, historyError: null };
  readonly ready: Promise<void>;
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private generation = 0;
  private refreshGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private olderPagesLoaded = false;
  private reconnectThread: string | null = null;
  private revision = 0;
  private turnRevisions = new Map<string, number>();
  private streamedUserItems = new Map<string, Map<string, AgentItem>>();
  private sourcesVerified = false;
  private selectionVersion = 0;
  private hydrating = false;
  private bufferedEvents: EventFrame[] = [];
  private historyBase: AgentTurn[] = [];
  private headRead: Promise<void> | null = null;
  private headAgain = false;
  private olderRead: Promise<void> | null = null;
  private prepared: PreparedHistory | undefined;
  private preparing: { cursor: string; task: Promise<PreparedHistory | null> } | null = null;

  constructor(private channel: RpcChannel, private options: { cache?: ConversationCache } = {}) {
    this.ready = options.cache ? options.cache.ready.then(() => {
      if (!this.disposed && !this.sourcesVerified && options.cache!.sources.length) this.update({ sources: options.cache!.sources.map((s) => ({ ...s, status: 'offline' })), supported: true });
    }) : Promise.resolve();
    this.disposers.push(channel.onPush((frame) => { if (frame.type === 'event') this.event(frame); }), channel.onStatus((status) => {
      if (status.state === 'open') {
        const id = this.state.thread?.id, selection = this.selectionVersion;
        void this.refresh().then(() => { if (!this.disposed && selection === this.selectionVersion && id && this.state.sources.some((s) => s.id === this.state.sourceId && s.enabled && s.status === 'online')) void this.openThread(id); });
      } else {
        this.generation++; this.refreshGeneration++;
        this.cancelReads();
        this.update({ loading: false, busy: false, requests: [], activeTurnId: null, threadVerified: false, historyLoading: false,
          submissions: this.state.submissions.map((s) => s.status === 'sending' ? { ...s, status: 'unknown' } : s),
          error: '连接已断开，恢复后会重新读取；未确认的发送请先检查会话' });
      }
    }));
  }
  getState = (): SourceState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose() { this.disposed = true; this.generation++; this.refreshGeneration++; for (const dispose of this.disposers) dispose(); if (this.timer) clearTimeout(this.timer); this.listeners.clear(); void this.options.cache?.flush(); }
  hasCachedSource(id: string) { return Boolean(this.options.cache?.threads(id).length); }
  private cancelReads() { this.headRead = null; this.headAgain = false; this.olderRead = null; this.preparing = null; }
  private persistHistory(cachedPage = false) {
    const { sourceId, thread, turns, historyCursor, threadVerified } = this.state;
    if (!sourceId || !thread || (!threadVerified && !cachedPage)) return;
    this.historyBase = turns;
    this.options.cache?.save({ sourceId, thread, turns, cursor: historyCursor, ...(this.prepared?.cursor === historyCursor ? { prepared: this.prepared } : {}) });
  }
  private update(patch: Partial<SourceState>) {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (patch.turns || patch.submissions) {
      const recorded = new Set(next.turns.flatMap((turn) => turn.items.filter((item) => item.type === 'userMessage').flatMap((item) => [item.id, item.clientId])));
      next.submissions = next.submissions.filter((submission) => !recorded.has(submission.id));
    }
    this.state = next; for (const listener of this.listeners) listener();
    if (patch.turns || patch.thread || patch.historyCursor !== undefined) this.persistHistory();
  }

  async refresh() {
    if (!this.channel.isOpen) return;
    const token = ++this.refreshGeneration;
    try {
      const { sources } = await this.channel.call<{ sources: SourceInfo[] }>('source.list', {}, 25_000);
      await this.options.cache?.ready;
      if (token !== this.refreshGeneration || this.disposed) return;
      this.sourcesVerified = true;
      for (const old of this.options.cache?.sources ?? []) if (!sources.some((s) => s.id === old.id && s.enabled)) void this.options.cache?.forgetSource(old.id);
      this.options.cache?.rememberSources(sources);
      this.update({ supported: true, sources });
      const selected = sources.find((s) => s.id === this.state.sourceId);
      if (!selected?.enabled) this.reconnectThread = null;
      if (this.state.sourceId && !selected?.enabled) {
        this.generation++; this.cancelReads(); this.update({ thread: null, turns: [], threads: [], requests: [], activeTurnId: null, submissions: [], loading: false, busy: false, threadVerified: false, historyLoading: false, error: selected?.error ?? '这个来源已撤销授权' });
      } else if (selected?.status !== 'online' && this.state.sourceId) {
        this.reconnectThread ??= this.state.thread?.id ?? null;
        this.generation++;
        // Keep the conversation mounted so an unsent native input draft survives.
        this.cancelReads();
        this.update({ requests: [], activeTurnId: null, loading: false, busy: false, threadVerified: false, historyLoading: false,
          submissions: this.state.submissions.map((s) => s.status === 'sending' ? { ...s, status: 'unknown' } : s),
          error: selected?.error ?? '来源暂时离线，恢复后可以继续，草稿已保留' });
      }
      if (selected?.status === 'online' && this.reconnectThread) {
        const id = this.reconnectThread; this.reconnectThread = null; await this.openThread(id);
      }
    } catch (error) {
      if (token !== this.refreshGeneration || this.disposed) return;
      if (error instanceof RpcCallError && ['method_not_found', '-32601', 'unknown_method'].includes(error.code)) this.update({ supported: false, sources: [] });
      else this.update({ error: describeError(error) });
    }
  }

  async selectSource(sourceId: string | null, options: { deferThreads?: boolean } = {}) {
    this.generation++;
    this.selectionVersion++; this.hydrating = false; this.bufferedEvents = [];
    this.reconnectThread = null;
    this.turnRevisions.clear(); this.streamedUserItems.clear();
    this.cancelReads(); this.prepared = undefined; this.historyBase = [];
    this.update({ sourceId, thread: null, turns: [], requests: [], threads: sourceId ? this.options.cache?.threads(sourceId) ?? [] : [], threadCursor: null, historyCursor: null, loading: false, busy: false, error: null, projects: [], projectsLoading: false, activeTurnId: null, submissions: [], fromCache: false, threadVerified: false, historyLoading: false, historyError: null });
    if (sourceId && !options.deferThreads) await this.loadThreads();
  }

  async loadThreads(more = false) {
    const { sourceId, threadCursor } = this.state;
    if (!sourceId || (more && !threadCursor) || !this.channel.isOpen) return;
    const token = this.generation;
    this.update({ loading: true, error: null });
    try {
      const page = await this.channel.call<{ threads: AgentThread[]; next_cursor: string | null }>('agent.threads', { source_id: sourceId, ...(more ? { cursor: threadCursor } : {}) }, 25_000);
      if (token !== this.generation) return;
      const threads = (Array.isArray(page.threads) ? page.threads : []).map(agentThread).filter((thread): thread is AgentThread => thread !== null);
      this.update({ threads: more ? unique([...this.state.threads, ...threads]) : unique([...threads, ...(this.options.cache?.threads(sourceId) ?? [])]), threadCursor: page.next_cursor });
    } catch (error) { if (token === this.generation) this.update({ error: describeError(error) }); }
    finally { if (token === this.generation) this.update({ loading: false }); }
  }

  async loadProjects() {
    const sourceId = this.state.sourceId, token = this.generation;
    if (!sourceId || !this.channel.isOpen) return;
    this.update({ projectsLoading: true, error: null });
    try {
      const result = await this.channel.call<{ projects: AgentProject[] }>('agent.projects', { source_id: sourceId }, 25_000);
      if (token === this.generation) this.update({ projects: Array.isArray(result.projects) ? result.projects.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.cwd === 'string') : [] });
    } catch (error) { if (token === this.generation) this.update({ error: describeError(error) }); }
    finally { if (token === this.generation) this.update({ projectsLoading: false }); }
  }

  async openThread(threadId: string) {
    const sourceId = this.state.sourceId;
    if (!sourceId) return;
    ++this.generation;
    const selection = ++this.selectionVersion;
    this.cancelReads(); this.prepared = undefined; this.historyBase = [];
    this.olderPagesLoaded = false;
    this.turnRevisions.clear(); this.streamedUserItems.clear();
    const source = this.state.sources.find((s) => s.id === sourceId);
    const memory = this.options.cache?.peek(sourceId, threadId);
    this.hydrating = Boolean(this.options.cache && !memory); this.bufferedEvents = [];
    this.update({ thread: memory?.thread ?? this.state.threads.find((t) => t.id === threadId) ?? { id: threadId, name: 'Codex 会话', cwd: '' }, turns: memory?.turns ?? [], requests: [], loading: true, busy: false, error: null, activeTurnId: null, submissions: [], threadVerified: false, fromCache: Boolean(memory), historyCursor: memory?.cursor ?? null, historyLoading: false, historyError: null });
    let cached = memory;
    if (!cached && this.options.cache) cached = await this.options.cache.get(sourceId, threadId);
    if (selection !== this.selectionVersion || this.disposed || this.state.sourceId !== sourceId || this.state.thread?.id !== threadId) return;
    this.hydrating = false;
    if (cached) {
      this.historyBase = cached.turns; this.prepared = cached.prepared; this.olderPagesLoaded = true;
      this.update({ thread: cached.thread, turns: cached.turns, historyCursor: cached.cursor, fromCache: true });
    }
    const buffered = this.bufferedEvents; this.bufferedEvents = [];
    for (const event of buffered) this.event(event);
    if (!this.channel.isOpen) { this.update({ loading: false, ...(!cached ? { error: '尚无本机会话记录，请连接电脑后读取' } : {}) }); return; }
    const currentSource = this.state.sources.find((s) => s.id === sourceId);
    if (currentSource && currentSource.status !== 'online') { this.reconnectThread = threadId; this.update({ loading: false }); return; }
    const token = this.generation;
    const verify = async () => {
      try {
        if (source?.capabilities.control) await this.channel.call('agent.subscribe', { source_id: sourceId, thread_id: threadId }, 25_000);
        if (token !== this.generation) return;
        await this.readThread(false, token);
      } catch (error) { if (token === this.generation) this.update({ error: describeError(error) }); }
      finally { if (token === this.generation) this.update({ loading: false }); }
    };
    if (cached) void verify(); else await verify();
  }

  readThread(older = false, token = this.generation): Promise<void> {
    if (older) return this.loadOlder();
    if (this.hydrating) return Promise.resolve();
    if (this.headRead) return this.headRead;
    const { sourceId, thread } = this.state;
    if (!sourceId || !thread || !this.channel.isOpen) return Promise.resolve();
    const reading = this.readLatest(sourceId, thread.id, token).finally(() => {
      if (this.headRead !== reading) return;
      this.headRead = null;
      if (this.headAgain && token === this.generation && !this.disposed) { this.headAgain = false; void this.readThread(); }
    });
    this.headRead = reading; return reading;
  }
  private async readLatest(sourceId: string, threadId: string, token: number) {
    const revision = this.revision, base = this.historyBase;
    try {
      const [page, pending] = await Promise.all([
        this.fetchPage(sourceId, threadId),
        this.channel.call<{ requests: AgentRequest[] }>('agent.pending', { source_id: sourceId, thread_id: threadId }),
      ]);
      if (token !== this.generation || this.disposed) return;
      const known = new Set(base.map((t) => t.id));
      let turns = page.turns, nextCursor = page.cursor;
      // Reconcile a gap since the last visit in the background. Do not put
      // disconnected cached and new windows next to each other as if contiguous.
      for (let count = 0; count < 5 && known.size && turns.length && !turns.some((t) => known.has(t.id)) && nextCursor; count++) {
        const older = await this.fetchPage(sourceId, threadId, nextCursor);
        if (token !== this.generation || this.disposed) return;
        if (older.cursor === nextCursor) break;
        turns = unique([...older.turns, ...turns]); nextCursor = older.cursor;
      }
      const overlaps = turns.some((t) => known.has(t.id));
      const extendsOlder = overlaps && !known.has(turns[0]?.id);
      turns = turns.map((turn) => {
        const previous = this.state.turns.find((existing) => existing.id === turn.id);
        if (previous && (this.turnRevisions.get(turn.id) ?? 0) > revision) return previous;
        const streamed = this.streamedUserItems.get(turn.id);
        if (!streamed) return turn;
        for (const item of turn.items) streamed.delete(item.id);
        return { ...turn, items: [...turn.items, ...streamed.values()] };
      });
      const freshIds = new Set(turns.map((t) => t.id));
      const previous = this.state.turns;
      const overlapIndex = previous.findIndex((t) => freshIds.has(t.id));
      let lastOverlap = -1;
      for (let i = previous.length - 1; i >= 0; i--) if (freshIds.has(previous[i].id)) { lastOverlap = i; break; }
      const suffix = lastOverlap >= 0 ? previous.slice(lastOverlap + 1).filter((t) => !freshIds.has(t.id)) : [];
      const merged = overlaps || !base.length
        ? unique([...(overlapIndex >= 0 ? previous.slice(0, overlapIndex) : previous.filter((t) => !freshIds.has(t.id))), ...turns, ...suffix])
        : unique([...turns, ...previous.filter((t) => !freshIds.has(t.id) && this.turnRevisions.has(t.id))]);
      const historyCursor = this.olderPagesLoaded && overlaps && !extendsOlder ? this.state.historyCursor : nextCursor;
      if (this.prepared?.cursor !== historyCursor) this.prepared = undefined;
      this.update({ thread: page.thread, turns: merged, historyCursor, requests: pending.requests, fromCache: false, threadVerified: true, error: null,
        ...(revision === this.revision ? { activeTurnId: currentAgentTurn(page.thread, turns, page.activeTurnId) } : {}) });
      this.prefetchOlder();
    } catch (error) { if (token === this.generation) this.update({ error: describeError(error) }); }
  }
  private async fetchPage(sourceId: string, threadId: string, cursor?: string) {
    const raw = await this.channel.call<{ thread: AgentThread; turns: AgentTurn[]; next_cursor: string | null; active_turn_id?: string | null }>('agent.read', { source_id: sourceId, thread_id: threadId, limit: 10, ...(cursor ? { cursor } : {}) }, 25_000);
    const thread = agentThread(raw.thread);
    if (!thread || thread.id !== threadId) throw new Error('会话数据无效，请刷新');
    return { thread, turns: agentTurns(raw.turns), cursor: typeof raw.next_cursor === 'string' ? raw.next_cursor : null, activeTurnId: raw.active_turn_id };
  }
  private prepareOlder(cursor: string): Promise<PreparedHistory | null> {
    if (this.prepared?.cursor === cursor) return Promise.resolve(this.prepared);
    if (this.preparing?.cursor === cursor) return this.preparing.task;
    const { sourceId, thread } = this.state, token = this.generation;
    if (!sourceId || !thread || !this.channel.isOpen) return Promise.resolve(null);
    const task = this.fetchPage(sourceId, thread.id, cursor).catch(async (error) => {
      const expired = error instanceof RpcCallError && ['invalid_cursor', 'cursor_expired', 'invalid_params', '-32602'].includes(error.code);
      if (!expired || !this.state.threadVerified || token !== this.generation) throw error;
      // A cursor may belong to an older app-server snapshot. Refresh the head
      // and walk past already cached pages instead of dropping the transcript.
      await this.readThread();
      if (token !== this.generation) throw error;
      const head = await this.fetchPage(sourceId, thread.id);
      return head.cursor ? this.fetchPage(sourceId, thread.id, head.cursor) : { ...head, turns: [] };
    }).then((page) => {
      if (token !== this.generation || this.disposed) return null;
      if (page.cursor === cursor) throw new Error('历史分页未前进，请重试');
      const prepared = { cursor, turns: page.turns, nextCursor: page.cursor };
      if (this.state.historyCursor === cursor) { this.prepared = prepared; this.persistHistory(); }
      return prepared;
    }).finally(() => { if (this.preparing?.task === task) this.preparing = null; });
    this.preparing = { cursor, task }; return task;
  }
  private prefetchOlder() {
    const cursor = this.state.historyCursor;
    if (cursor && this.channel.isOpen && !this.state.historyError) void this.prepareOlder(cursor).catch(() => {});
  }
  loadOlder(): Promise<void> {
    if (this.olderRead) return this.olderRead;
    if (!this.state.historyCursor || (!this.channel.isOpen && this.prepared?.cursor !== this.state.historyCursor)) return Promise.resolve();
    const token = this.generation;
    this.update({ historyLoading: true, historyError: null });
    const reading = (async () => {
      try {
        const maximumPages = Math.max(6, Math.ceil(this.state.turns.length / 5) + 2);
        for (let count = 0; count < maximumPages && this.state.historyCursor; count++) {
          const page = await this.prepareOlder(this.state.historyCursor);
          if (!page || token !== this.generation || this.disposed) return;
          const ids = new Set(this.state.turns.map((t) => t.id)), older = page.turns.filter((t) => !ids.has(t.id));
          this.prepared = undefined; this.olderPagesLoaded = true;
          this.update({ turns: [...older, ...this.state.turns], historyCursor: page.nextCursor });
          if (!this.channel.isOpen) this.persistHistory(true);
          if (older.length || !page.nextCursor) break;
        }
        this.prefetchOlder();
      } catch (error) { if (token === this.generation) this.update({ historyError: describeError(error) }); }
      finally { if (token === this.generation) this.update({ historyLoading: false }); }
    })().finally(() => { if (this.olderRead === reading) this.olderRead = null; });
    this.olderRead = reading; return reading;
  }

  async action(method: string, params: Record<string, unknown> = {}): Promise<boolean> {
    if (this.state.busy || !this.channel.isOpen || !this.state.sourceId) return false;
    const source = this.state.sources.find((s) => s.id === this.state.sourceId);
    if (!source?.enabled || source.status !== 'online' || !source.capabilities.control) return false;
    if (method !== 'agent.create' && !this.state.threadVerified) return false;
    const token = this.generation;
    const inputId = (method === 'agent.send' || method === 'agent.steer') && typeof params.text === 'string' ? newAgentMessageId() : null;
    this.update({ busy: true, error: null, ...(inputId ? { submissions: [...this.state.submissions.slice(-19), { id: inputId, text: params.text as string, mode: method === 'agent.steer' ? 'steer' as const : 'start' as const, status: 'sending' as const }] } : {}) });
    try {
      const result = await this.channel.call<{ thread?: AgentThread; turn?: AgentTurn; turnId?: string; delivery?: { state: string; mode: 'start' | 'steer'; client_message_id: string; turn_id?: string } }>(method, { source_id: this.state.sourceId, thread_id: this.state.thread?.id, ...params, ...(inputId ? { client_message_id: inputId } : {}) }, 25_000);
      if (token !== this.generation) return false;
      if (inputId) {
        const turnId = result.delivery?.turn_id ?? result.turnId ?? result.turn?.id;
        if (turnId) this.turnRevisions.set(turnId, ++this.revision);
        this.update({ submissions: this.state.submissions.map((s) => s.id === inputId ? { ...s, status: 'accepted', mode: result.delivery?.mode ?? s.mode } : s),
          ...(turnId ? { activeTurnId: turnId } : {}) });
        void this.readThread();
      } else if ((method === 'agent.create' || method === 'agent.fork') && result.thread) { this.update({ threads: [result.thread, ...this.state.threads] }); await this.openThread(result.thread.id); }
      else if (method === 'agent.archive') { if (this.state.thread) await this.options.cache?.forgetThread(this.state.sourceId!, this.state.thread.id); await this.selectSource(this.state.sourceId); }
      else { if (result.thread) this.update({ thread: agentThread(result.thread) ?? this.state.thread }); await this.readThread(); }
      return true;
    } catch (error) {
      const unknown = error instanceof RpcCallError && ['timeout', 'offline', 'disconnected', 'connection_closed'].includes(error.code);
      if (token === this.generation) this.update({ error: unknown ? '操作结果未知，请先刷新会话确认，避免重复操作' : describeError(error),
        ...(inputId ? { submissions: unknown ? this.state.submissions.map((s) => s.id === inputId ? { ...s, status: 'unknown' as const } : s) : this.state.submissions.filter((s) => s.id !== inputId) } : {}) });
      if (token === this.generation && error instanceof RpcCallError && error.code === 'turn_changed') void this.readThread();
      return false;
    }
    finally { if (token === this.generation) this.update({ busy: false }); }
  }

  private event(frame: EventFrame) {
    if (frame.category === 'source') {
      if (frame.name === 'source.changed' && this.state.thread && frame.payload && typeof frame.payload === 'object' && 'source_ids' in frame.payload && Array.isArray(frame.payload.source_ids) && frame.payload.source_ids.includes(this.state.sourceId)) {
        this.reconnectThread = this.state.thread.id;
      }
      void this.refresh(); return;
    }
    if (frame.category !== 'agent' || !frame.payload || typeof frame.payload !== 'object') return;
    const p = frame.payload as Record<string, unknown>;
    if (p.source_id !== this.state.sourceId) return;
    if (frame.name === 'panecast/disconnected') {
      this.reconnectThread = this.state.thread?.id ?? null;
      this.generation++;
      this.cancelReads();
      this.update({ requests: [], loading: false, busy: false, activeTurnId: null, threadVerified: false, historyLoading: false,
        sources: this.state.sources.map((source) => source.id === p.source_id ? { ...source, status: 'offline' } : source),
        submissions: this.state.submissions.map((s) => s.status === 'sending' ? { ...s, status: 'unknown' } : s),
        error: 'Codex 来源已断开，恢复后会重新读取会话' }); return;
    }
    if (p.threadId !== this.state.thread?.id && !(frame.name === 'serverRequest/resolved' && this.state.requests.some((r) => r.id === String(p.requestId)))) return;
    if (this.hydrating) { this.bufferedEvents.push(frame); if (this.bufferedEvents.length > 2000) this.bufferedEvents.shift(); return; }
    if (['item/started', 'item/completed'].includes(frame.name) && p.item && typeof p.item === 'object') {
      const item = agentItem(p.item), id = String(p.turnId);
      if (!item) return;
      this.turnRevisions.set(id, ++this.revision);
      if (item.type === 'userMessage') {
        if (!this.streamedUserItems.has(id)) this.streamedUserItems.set(id, new Map());
        this.streamedUserItems.get(id)!.set(item.id, item);
      }
      const existing = this.state.turns.find((t) => t.id === id) ?? { id, status: 'inProgress', items: [] };
      this.update({ turns: unique([...this.state.turns, { ...existing, items: unique([...existing.items, item]) }]) });
    }
    if (frame.name === 'item/agentMessage/delta' || frame.name === 'item/commandExecution/outputDelta') {
      const id = String(p.turnId), itemId = String(p.itemId);
      this.turnRevisions.set(id, ++this.revision);
      const turns = [...this.state.turns];
      let turnIndex = turns.findIndex((t) => t.id === id);
      if (turnIndex < 0) { turns.push({ id, status: 'inProgress', items: [] }); turnIndex = turns.length - 1; }
      const turn = turns[turnIndex], items = [...turn.items];
      let itemIndex = items.findIndex((i) => i.id === itemId);
      if (itemIndex < 0) { items.push({ id: itemId, type: frame.name.includes('agentMessage') ? 'agentMessage' : 'commandExecution' }); itemIndex = items.length - 1; }
      const key = frame.name.includes('agentMessage') ? 'text' : 'aggregatedOutput';
      const limit = key === 'text' ? 16_000 : 6000;
      const combined = (items[itemIndex][key] ?? '') + String(p.delta ?? '');
      items[itemIndex] = { ...items[itemIndex], [key]: combined.slice(-limit), truncated: items[itemIndex].truncated || combined.length > limit };
      turns[turnIndex] = { ...turn, items }; this.update({ turns });
    }
    if (frame.name === 'turn/started' && p.turn && typeof p.turn === 'object') {
      const turn = agentTurn(p.turn);
      if (turn) { this.turnRevisions.set(turn.id, ++this.revision); this.update({ turns: unique([...this.state.turns, turn]), activeTurnId: turn.id }); }
    }
    if (frame.name === 'turn/completed' && p.turn && typeof p.turn === 'object') {
      const turn = agentTurn(p.turn);
      if (!turn) return;
      this.turnRevisions.set(turn.id, ++this.revision);
      const previous = this.state.turns.find((t) => t.id === turn.id);
      this.update({ turns: unique([...this.state.turns, { ...turn, items: unique([...(previous?.items ?? []), ...(turn.items ?? [])]) }]),
        ...(this.state.activeTurnId === turn.id ? { activeTurnId: null } : {}) });
    }
    if (frame.name === 'turn/completed' || frame.name === 'serverRequest/resolved' || p.request_id != null) {
      if (this.headRead) this.headAgain = true;
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.readThread(); }, 200);
    }
  }
}

function unique<T extends { id: string }>(items: T[]): T[] { return [...new Map(items.map((item) => [item.id, item])).values()]; }

export function itemText(item: AgentItem): string {
  switch (item.type) {
    case 'userMessage': return (item.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    case 'agentMessage': case 'plan': return item.text ?? '';
    case 'commandExecution': return [item.command, item.aggregatedOutput].filter(Boolean).join('\n');
    case 'fileChange': return (item.changes ?? []).map((c) => `${c.path}\n${c.diff ?? ''}`).join('\n\n');
    case 'mcpToolCall': return `${item.server ?? ''} / ${item.tool ?? ''} · ${item.status ?? ''}`;
    default: return '';
  }
}
