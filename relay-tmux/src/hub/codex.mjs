import { RpcError } from '../tmux.mjs';
import { RpcPeer, localEndpoint } from './rpc.mjs';
import { homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { stat, realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mobileItem, mobileTurn } from './codex-history.mjs';
import { desktopParent } from './desktop-bridge.mjs';

const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const READS = new Set(['agent.threads', 'agent.read', 'agent.pending', 'agent.projects']);
const ACTIONS = new Set([...READS, 'agent.subscribe', 'agent.unsubscribe', 'agent.create', 'agent.resume', 'agent.fork', 'agent.rename', 'agent.archive', 'agent.send', 'agent.steer', 'agent.interrupt', 'agent.respond']);
const text = (value, max = 100_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RpcError('invalid_params', '内容为空或过长');
  return value;
};

export class CodexSource {
  constructor(config, emit, peerFactory = (options) => new RpcPeer(options)) {
    this.config = config; this.emit = emit; this.peerFactory = peerFactory;
    this.pending = new Map(); this.subscribed = new Set(); this.freshThreads = new Map();
    this.mode = config.mode ?? 'attach';
    if (!['attach', 'history', 'managed'].includes(this.mode)) throw new Error('Codex mode must be attach, history, or managed');
    if (config.url) localEndpoint(config.url);
  }

  get controllable() { return this.mode !== 'history' && this.config.access === 'control'; }

  async connection() {
    if (!this.peer || this.peer.closed) {
      const c = this.config;
      if (this.mode === 'attach' && c.desktop_app) {
        let owner;
        try { owner = JSON.parse(await readFile(c.socket + '.lock', 'utf8')); } catch {}
        if (!Number.isInteger(owner?.parent_pid) || owner.desktop_app !== c.desktop_app || !await desktopParent(c.desktop_app, owner.parent_pid)) {
          throw new RpcError('desktop_not_connected', '桌面 App 尚未通过桥接启动；当前入口不属于桌面任务服务');
        }
      }
      const transport = this.mode === 'attach'
        ? c.url ? { url: localEndpoint(c.url), token: c.token }
          : { socketPath: c.socket ?? join(c.codex_home ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock') }
        : { command: c.executable ?? 'codex', args: ['app-server', '--listen', 'stdio://'],
        env: c.codex_home ? { CODEX_HOME: c.codex_home } : {} };
      this.peer = this.peerFactory({ ...transport, codex: true });
      this.pending.clear(); this.subscribed.clear(); this.freshThreads.clear();
      this.peer.onMessage((message) => this.onMessage(message));
    }
    await this.peer.connect();
    return this.peer;
  }

  onMessage(message) {
    if (typeof message.method !== 'string') return;
    if (message.method === 'panecast/disconnected') { this.pending.clear(); this.subscribed.clear(); this.freshThreads.clear(); }
    if (message.method === 'serverRequest/resolved') this.pending.delete(String(message.params?.requestId));
    if (message.id != null && typeof message.params?.threadId === 'string' && /^(item\/|tool\/)/.test(message.method)) {
      this.pending.set(String(message.id), { id: String(message.id), rpcId: message.id, method: message.method,
        params: message.params ?? {}, supported: APPROVALS.has(message.method) || message.method === 'tool/requestUserInput' });
    }
    // Forward conversation events only. Account/auth/config messages stay on the host.
    if (/^(thread\/|turn\/|item\/|serverRequest\/|panecast\/)/.test(message.method) || message.method === 'tool/requestUserInput') {
      const params = { ...message.params };
      if (params.item) { params.item = mobileItem(params.item); if (!params.item) return; }
      if (params.turn) params.turn = mobileTurn(params.turn);
      this.emit({ type: 'event', category: 'agent', name: message.method,
        payload: { ...params, source_id: this.config.id, ...(message.id != null ? { request_id: String(message.id) } : {}) } });
    }
  }

  async dispatch(method, p = {}) {
    if (!ACTIONS.has(method)) throw new RpcError('method_not_found', '不支持这个 Codex 操作');
    if (!READS.has(method) && !this.controllable) throw new RpcError('read_only', this.mode === 'history' ? '这个来源只读取历史；实时操作需要连接原会话的服务' : '这个连接源只允许读取');
    const peer = await this.connection();
    if (method === 'agent.projects') return { projects: await this.projects(peer) };
    if (method === 'agent.threads') {
      const result = await peer.call('thread/list', { limit: 40, sortKey: 'updated_at',
        sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], modelProviders: [], useStateDbOnly: true,
        ...(p.cursor ? { cursor: text(p.cursor, 4096) } : {}), ...(p.archived === true ? { archived: true } : {}) });
      const loaded = this.mode === 'history' ? new Set() : await this.loaded(peer);
      return { threads: (result.data ?? []).map((thread) => this.thread(thread, loaded.has(thread.id))), next_cursor: result.nextCursor ?? null };
    }
    if (method === 'agent.create') {
      const projects = await this.projects(peer);
      const project = p.project_id ? projects.find((item) => item.id === p.project_id) : projects[0];
      if (!project) throw new RpcError('invalid_project', '请选择一个可用的项目目录');
      const result = await peer.call('thread/start', { cwd: project.cwd });
      this.subscribed.add(result.thread.id);
      this.freshThreads.set(result.thread.id, result.thread);
      if (typeof p.name === 'string' && p.name.trim()) {
        await peer.call('thread/name/set', { threadId: result.thread.id, name: text(p.name, 300) });
        result.thread.name = p.name.trim();
      }
      return { thread: this.thread(result.thread, true) };
    }
    if (method === 'agent.pending') return { requests: [...this.pending.values()].filter((r) => !p.thread_id || r.params.threadId === p.thread_id).map(({ rpcId, ...request }) => request) };
    if (method === 'agent.respond') return this.respond(peer, p);
    const threadId = text(p.thread_id, 200);
    if (method === 'agent.read') {
      let thread;
      try { ({ thread } = await peer.call('thread/read', { threadId })); }
      catch (error) {
        // A newly created thread has no persisted rollout until its first turn.
        if (this.freshThreads.has(threadId) && /no rollout found/i.test(error.message)) return { thread: this.thread(this.freshThreads.get(threadId), true), turns: [], next_cursor: null };
        throw error;
      }
      const live = this.mode !== 'history' && (await this.loaded(peer)).has(threadId);
      try {
        const page = await peer.call('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full', ...(p.cursor ? { cursor: text(p.cursor, 4096) } : {}) });
        this.freshThreads.delete(threadId);
        const active = live && thread.status?.type === 'active' ? (page.data ?? []).find((turn) => turn.status === 'inProgress')?.id ?? null : null;
        return { thread: this.thread(thread, live), turns: [...(page.data ?? [])].reverse().map(mobileTurn), next_cursor: page.nextCursor ?? null,
          ...(!p.cursor ? { active_turn_id: active } : {}) };
      } catch (error) {
        if (this.freshThreads.has(threadId) && /not materialized yet|before first user message/i.test(error.message)) return { thread: this.thread(thread, live), turns: [], next_cursor: null };
        if (!['-32601', 'method_not_found'].includes(error.code) || p.cursor) throw error;
        const legacy = await peer.call('thread/read', { threadId, includeTurns: true });
        return { thread: this.thread(legacy.thread, live), turns: (legacy.thread.turns ?? []).map(mobileTurn), next_cursor: null };
      }
    }
    if (method === 'agent.subscribe') {
      if (this.freshThreads.has(threadId)) return { thread: this.thread(this.freshThreads.get(threadId), true) };
      // Reading a saved ID must never load a second copy of a task running elsewhere.
      if (!(await this.loaded(peer)).has(threadId)) {
        const { thread } = await peer.call('thread/read', { threadId });
        return { thread: this.thread(thread, false) };
      }
      const result = await peer.call('thread/resume', { threadId, excludeTurns: true });
      this.subscribed.add(threadId);
      return { thread: this.thread(result.thread, true) };
    }
    // The source connection is shared by phones; closing a view must not unsubscribe another phone.
    if (method === 'agent.unsubscribe') return {};
    if (method === 'agent.resume' || method === 'agent.fork') {
      const loaded = (await this.loaded(peer)).has(threadId);
      if (!loaded && method === 'agent.resume') {
        const page = await peer.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        if (page.data?.[0]?.status === 'inProgress') throw new RpcError('thread_busy_elsewhere', '这条记录可能仍在另一个服务中运行。可从这段历史新建对话，或先在电脑上结束原任务。');
      }
      const result = await peer.call(method === 'agent.fork' ? 'thread/fork' : 'thread/resume', { threadId, excludeTurns: true });
      this.subscribed.add(result.thread.id);
      return { thread: this.thread(result.thread, true) };
    }
    if (!(await this.loaded(peer)).has(threadId)) throw new RpcError('thread_not_attached', '这里只读到了历史记录；请先在连接的桌面服务中打开这个会话，再刷新');
    if (method === 'agent.rename') return peer.call('thread/name/set', { threadId, name: text(p.name, 300) });
    if (method === 'agent.archive') return peer.call('thread/archive', { threadId });
    if (method === 'agent.interrupt') return peer.call('turn/interrupt', { threadId, turnId: text(p.turn_id, 200) });
    if (!this.subscribed.has(threadId)) {
      await peer.call('thread/resume', { threadId, excludeTurns: true });
      this.subscribed.add(threadId);
    }
    if (method === 'agent.send' || method === 'agent.steer') {
      const clientUserMessageId = p.client_message_id == null ? randomUUID() : text(p.client_message_id, 160);
      const input = [{ type: 'text', text: text(p.text) }];
      let result, mode = method === 'agent.steer' ? 'steer' : 'start';
      if (mode === 'steer') {
        try { result = await peer.call('turn/steer', { threadId, expectedTurnId: text(p.turn_id, 200), input, clientUserMessageId }); }
        catch (error) {
          // This explicit rejection guarantees that the input was not accepted.
          // A timeout or a different active turn must never trigger a resend.
          if (error.code === '-32600' && /expected active turn id|ExpectedTurnMismatch/.test(error.message)) throw new RpcError('turn_changed', '当前任务已切换，尚未追加；请刷新会话后再发送');
          if (error.code !== '-32600' || error.message !== 'no active turn to steer') throw error;
          mode = 'start'; result = await peer.call('turn/start', { threadId, input, clientUserMessageId });
        }
      } else result = await peer.call('turn/start', { threadId, input, clientUserMessageId });
      return { ...result, delivery: { client_message_id: clientUserMessageId, turn_id: result.turnId ?? result.turn?.id, state: 'accepted', mode } };
    }
  }

  async loaded(peer) { return new Set((await peer.call('thread/loaded/list')).data ?? []); }

  async projects(peer) {
    const configured = Array.isArray(this.config.projects) ? this.config.projects : [];
    const candidates = [...configured, ...(this.config.cwd ? [{ cwd: this.config.cwd }] : [])];
    if (!configured.length) {
      const page = await peer.call('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], modelProviders: [], useStateDbOnly: true });
      for (const thread of page.data ?? []) if (thread.cwd) candidates.push({ cwd: thread.cwd });
      candidates.push({ cwd: homedir(), name: '个人目录' });
    }
    const paths = new Map();
    for (const candidate of candidates) {
      if (typeof candidate?.cwd !== 'string' || !isAbsolute(candidate.cwd)) continue;
      try {
        const cwd = await realpath(candidate.cwd);
        if (paths.has(cwd) || !(await stat(cwd)).isDirectory()) continue;
        paths.set(cwd, { id: createHash('sha256').update(cwd).digest('hex').slice(0,24), name: String(candidate.name ?? basename(cwd) ?? cwd), cwd });
      } catch { /* Only offer existing, reachable directories. */ }
      if (paths.size >= 30) break;
    }
    return [...paths.values()];
  }

  thread(thread, live = false) {
    return { id: thread.id, name: thread.name ?? thread.preview?.slice(0, 100) ?? thread.id,
      cwd: thread.cwd ?? '', updatedAt: thread.updatedAt, status: this.mode === 'history' ? { type: 'history' } : thread.status,
      live,
      ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}) };
  }

  respond(peer, p) {
    const request = this.pending.get(String(p.request_id));
    if (!request) throw new RpcError('request_resolved', '这个请求已处理或连接已变化，请刷新');
    if (request.params.threadId !== p.thread_id) throw new RpcError('invalid_target', '请求不属于这个会话');
    let result;
    if (APPROVALS.has(request.method)) {
      if (!['accept', 'decline', 'cancel'].includes(p.decision)) throw new RpcError('invalid_params', '无效的审批选择');
      result = { decision: p.decision };
    } else if (request.method === 'tool/requestUserInput') {
      const answers = {};
      for (const question of request.params.questions ?? []) {
        const answer = p.answers?.[question.id];
        if (!Array.isArray(answer) || answer.length < 1 || answer.length > 10) throw new RpcError('invalid_params', '请回答每一个问题');
        answers[question.id] = { answers: answer.map((a) => text(a, 10_000)) };
      }
      result = { answers };
    } else throw new RpcError('unsupported_request', '请在电脑上的 Codex 处理这个请求');
    peer.respond(request.rpcId, result); this.pending.delete(request.id);
    this.emit({ type: 'event', category: 'agent', name: 'serverRequest/resolved', payload: { source_id: this.config.id, threadId: p.thread_id, requestId: request.id } });
    return {};
  }

  close() { this.peer?.close(); this.pending.clear(); this.subscribed.clear(); this.freshThreads.clear(); }
}
