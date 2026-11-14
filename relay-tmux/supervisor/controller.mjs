import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const clean = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
const required = (value, name, max = 8000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${name}无效`); return value.trim(); };
const cursor = page => Math.max(0, ...(page.items ?? []).map(item => (item.updatedSequence ?? item.sequence ?? 0) + 1));
const binding = page => ({ conversation: page.conversation_id ?? null, generation: page.generation ?? '' });
const sameBinding = (expected, page) => expected?.conversation === (page.conversation_id ?? null) && expected?.generation === (page.generation ?? '');
const messages = page => (page.items ?? []).filter(item => ['userMessage', 'agentMessage'].includes(item.type)).slice(-12).map(item => ({ id: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant', text: item.text || item.content?.map(p => p.text ?? '').join('\n'), phase: item.phase, needsInput: item.needsInput === true }));
const textOf = item => item.text || item.content?.map(p => p.text ?? '').join('\n') || '';
const questionKey = value => value ? hash(value.split('\n').map(line => line.replace(/^\s*[›❯>→●]?\s*/, '')).join('\n')) : null;
const taskSummary = task => ({ id: task.id, title: task.title, goal: task.goal, state: task.state, priority: task.priority, summary: task.summary, blocker: task.blocker, terminal: task.target.title, updatedAt: task.updatedAt });

/** Provider-independent task decisions. Terminal ownership and transport live in the adapter. */
export class SupervisorController {
  constructor({ store, gateway, launcher, notify = () => {}, managerTitle = '监工' }) {
    Object.assign(this, { store, gateway, launcher, notify, managerTitle }); this.queue = Promise.resolve(); this.closed = false;
  }
  serial(fn) { const task = this.queue.then(() => { if (this.closed) throw new Error('监工已停止'); return fn(); }); this.queue = task.catch(() => {}); return task; }
  enabled() { return this.store.meta('enabled') === true; }
  connected(id) {
    const manager = this.store.meta('manager');
    if (!manager || manager.id !== id) throw new Error('监工会话已变化');
    this.store.setMeta('manager', { ...manager, connected: true }); return { connected: true };
  }
  status() {
    const manager = this.store.meta('manager');
    return { enabled: this.enabled(), manager: manager ? { id: manager.id, title: manager.title, target: manager.target, state: manager.state, lastError: manager.lastError, wakeState: manager.wake?.state } : null,
      tasks: this.store.tasks().map(taskSummary), pendingRequests: this.store.inbox().length,
      unconfirmed: this.store.unknownOperations().map(op => ({ id: op.id, taskId: op.taskId, kind: op.kind, title: op.title, project: op.project, message: op.message })) };
  }
  async start({ fresh = false } = {}) {
    const existing = this.store.meta('manager');
    if (existing?.target) {
      let reachable = false;
      try { await this.gateway.validate(existing.target); reachable = true; } catch {}
      const alive = reachable && (this.gateway.agentAlive ? await this.gateway.agentAlive(existing.target, 'claude') : true);
      if (alive) { await this.gateway.focus?.(existing.target); this.store.setMeta('enabled', true); return this.status(); }
      if (!fresh) throw new Error('无法确认原监工仍在运行。请先查看保留的工作区；确认需要新会话时用 supervisor start --new。');
    }
    if (!fresh && (existing?.state === 'launching' || existing?.state === 'launch_unknown')) throw new Error('上次创建监工的结果未确认，请先检查 cmux。确认没有重复实例后可运行 supervisor start --new。');
    const id = randomUUID(), manager = { id, sessionId: randomUUID(), title: this.managerTitle, state: 'launching', cursor: 0, seenConsole: [], wake: null, createdAt: Date.now() };
    this.store.transaction(() => { this.store.setMeta('enabled', true); this.store.setMeta('manager', manager); });
    try {
      manager.target = await this.launcher.manager(manager);
      manager.state = 'starting'; this.store.setMeta('manager', manager);
      this.store.enqueue({ id: 'startup:' + id, type: 'user', origin: 'setup', audience: this.store.meta('audience') ?? '', text: '监工已启动。检查工具和任务记录并简短报告就绪；不要给其他终端派工。' });
      this.store.event('manager_started', null, { managerId: id, target: manager.target });
      return this.status();
    } catch (error) {
      this.store.setMeta('manager', { ...manager, state: error.notSent ? 'launch_failed' : 'launch_unknown', lastError: error.notSent ? '监工还未创建，请检查 Claude 和 cmux 连接后重试。' : '创建或启动监工未确认，请检查 cmux 后处理。' }); throw error;
    }
  }
  pause() { this.store.setMeta('enabled', false); this.store.event('manager_paused', null); return { message: '已暂停自动调度，任务记录和监工终端仍可查看。' }; }
  attachAudience(audience) { this.store.setMeta('audience', audience); }
  submitUser(id, text, audience) {
    if (!this.enabled()) throw new Error('监工尚未启动，请在电脑运行 panecast supervisor start。');
    this.store.enqueue({ id: 'user:' + id, type: 'user', origin: 'weixin', audience, text: required(text, '消息') });
    return { queued: true };
  }
  async syncConsole(manager, page) {
    const seen = new Set(manager.seenConsole ?? []);
    for (const item of (page.items ?? []).filter(i => i.type === 'userMessage')) {
      if (seen.has(item.id)) continue; seen.add(item.id);
      const text = clean(textOf(item));
      if (!text || text.startsWith('[Panecast 唤醒 ') || text.startsWith('Panecast 监工启动。')) continue;
      this.store.enqueue({ id: `console:${manager.id}:${item.id}`, type: 'user', origin: 'console', audience: this.store.meta('audience') ?? '', text: text.slice(0, 8000) });
    }
    manager.seenConsole = [...seen].slice(-300); this.store.setMeta('manager', manager);
  }
  trigger(id, taskId, userOnly = false, allowSetup = false) {
    const input = this.store.input(required(id, '触发事件', 250));
    if (!input || (!allowSetup && input.origin === 'setup') || (userOnly && input.type !== 'user') || (input.type !== 'user' && input.taskId !== taskId)) throw new Error('需要有效的用户请求，或属于当前任务的事件。');
    return input;
  }
  task(id) { const task = this.store.task(required(id, '任务 ID', 100)); if (!task) throw new Error('任务不存在'); return task; }
  async checked(task) {
    const page = await this.gateway.snapshot(task.target);
    if (!page.available || !sameBinding(task.binding, page)) {
      this.store.saveTask({ ...task, state: 'blocked', blocker: '原终端会话已经变化，请重新确认任务归属。' });
      throw new Error('任务的原会话已变化，未向新会话发送任何内容。');
    }
    return page;
  }
  async listTerminals() {
    const manager = this.store.meta('manager'), { targets, offline } = await this.gateway.list();
    return { terminals: targets.filter(t => t.surface_id !== manager?.target?.surface_id).map(t => ({ id: t.code, title: t.title, project: t.cwd, provider: t.provider,
      currentTask: this.store.tasks().find(task => task.target.surface_id === t.surface_id && task.state !== 'done')?.id })), offlineSources: offline };
  }
  async adopt(args) {
    this.trigger(args.trigger_id, null, true);
    const title = required(args.title, '任务名称', 160), goal = required(args.goal, '任务目标');
    const { targets } = await this.gateway.list(), target = targets.find(t => t.code === args.terminal_id);
    if (!target || target.surface_id === this.store.meta('manager')?.target?.surface_id) throw new Error('请选择已发现的执行者终端。');
    const page = await this.gateway.snapshot(target);
    if (!page.available) throw new Error('该终端没有可核对的编码会话记录，暂不能交给监工自动操作。');
    const targetKey = hash([target.sourceId, target.workspace_id, target.surface_id, page.conversation_id, page.generation]);
    const old = this.store.targetTask(targetKey);
    if (old && old.state !== 'done') return taskSummary(old);
    const task = { id: 'task-' + randomUUID().slice(0, 8), targetKey, target, binding: binding(page), title, goal,
      state: page.active ? 'running' : 'observing', priority: 3, cursor: cursor(page), createdAt: Date.now(), audience: this.store.meta('audience') ?? '', revision: 0, repairs: 0 };
    this.store.transaction(() => {
      if (old) this.store.saveTask({ ...old, targetKey: old.targetKey + ':' + old.id });
      this.store.saveTask(task); this.store.event('task_adopted', task.id, { title, goal, trigger: args.trigger_id });
      for (const item of (page.items ?? []).filter(i => i.type === 'agentMessage' && i.phase === 'final').slice(-1)) this.store.event('final', task.id, { text: item.text, itemId: item.id, baseline: true }, `baseline:${task.id}:${item.id}`);
    });
    return taskSummary(task);
  }
  async create(args) {
    this.trigger(args.trigger_id, null, true);
    const title = required(args.title, '任务名称', 160), goal = required(args.goal, '目标'), project = required(args.project, '项目路径', 4096);
    const operationId = hash(['create', args.trigger_id, title, goal, project]);
    const prior = this.store.operation(operationId); if (prior) return prior;
    const { targets } = await this.gateway.list(), projectTarget = targets.find(t => t.cwd === project);
    if (!projectTarget) throw new Error('项目必须来自 list_terminals 的本机项目路径。');
    const task = { id: 'task-' + randomUUID().slice(0, 8), title, goal, targetKey: 'new:' + operationId, executionId: operationId, priority: 3, state: 'starting', createdAt: Date.now(), audience: this.store.meta('audience') ?? '', sessionId: randomUUID(), cursor: 0, repairs: 0, revision: 0 };
    this.store.saveOperation({ id: operationId, kind: 'create', taskId: task.id, state: 'attempting', title, goal, project });
    try {
      task.target = await this.launcher.worker(task, projectTarget);
      task.expectedSessionId = task.sessionId;
      this.store.transaction(() => { this.store.saveTask(task); this.store.saveOperation({ id: operationId, taskId: task.id, kind: 'create', state: 'sent' }); this.store.event('task_created', task.id, { title, goal, project }); });
      return taskSummary(task);
    } catch {
      this.store.saveOperation({ id: operationId, taskId: task.id, kind: 'create', state: 'unknown', title, goal, project });
      throw new Error('新任务启动结果未确认，已停止自动重试。请检查 cmux。');
    }
  }
  async send(args) {
    const task = this.task(args.task_id), source = this.trigger(args.trigger_id, task.id), instruction = required(args.instruction, '工作指令');
    const id = hash(['send', args.trigger_id, task.id, instruction]);
    const prior = this.store.operation(id); if (prior) return prior;
    if (task.state === 'done' && (source.type !== 'user' || source.createdAt <= (task.completedAt ?? 0))) throw new Error('任务已验收，新的用户要求到达后才能继续。');
    if (this.store.operations(task.id, ['unknown', 'attempting']).length) throw new Error('这个任务还有未确认的指令，请先核查结果；不会自动重发。');
    if (source.type !== 'user' && task.repairs >= 3) throw new Error('连续自动跟进已达 3 次，请报告阻塞并等待用户指示。');
    if (this.store.operations(task.id, ['queued']).length) throw new Error('任务已有待发送指令，等待投递后再安排下一步。');
    await this.checked(task); await this.gateway.validate(task.target, true);
    return this.store.transaction(() => {
      const op = this.store.saveOperation({ id, kind: 'send', taskId: task.id, state: 'queued', instruction, triggerId: args.trigger_id });
      this.store.saveTask({ ...task, state: 'queued', repairs: source.type === 'user' ? 0 : task.repairs + 1, blocker: null });
      return op;
    });
  }
  async pauseTask(args) {
    const task = this.task(args.task_id); this.trigger(args.trigger_id, task.id, true);
    const id = hash(['pause', args.trigger_id, task.id]), prior = this.store.operation(id); if (prior) return prior;
    await this.checked(task); await this.gateway.validate(task.target, true);
    this.store.saveOperation({ id, taskId: task.id, kind: 'pause', state: 'attempting' });
    try { await this.gateway.key(task.target, 'ctrl-c'); }
    catch { this.store.saveOperation({ id, taskId: task.id, kind: 'pause', state: 'unknown' }); throw new Error('停止任务的回执未确认，请查看终端。'); }
    this.store.transaction(() => {
      for (const op of this.store.operations(task.id, ['queued'])) this.store.saveOperation({ ...op, state: 'cancelled' });
      this.store.saveOperation({ id, taskId: task.id, kind: 'pause', state: 'sent' }); this.store.saveTask({ ...task, state: 'paused' });
    });
    return taskSummary(this.task(task.id));
  }
  async answerTask(args) {
    const task = this.task(args.task_id); this.trigger(args.trigger_id, task.id, true);
    if (!Number.isInteger(args.option) || args.option < 1 || args.option > 12) throw new Error('选项编号无效');
    const id = hash(['answer', args.trigger_id, task.id, args.question_id, args.option]), prior = this.store.operation(id); if (prior) return prior;
    if (this.store.operations(task.id, ['unknown', 'attempting']).length) throw new Error('先核查未确认的输入，再回答问题。');
    await this.checked(task);
    const prompt = await this.gateway.question(task.target);
    if (!prompt || questionKey(prompt) !== args.question_id) throw new Error('问题已经变化，请重新读取，未提交选择。');
    if (/space.*(?:select|toggle)|空格.*(?:选择|勾选)|question \d+.*\d+/i.test(prompt)) throw new Error('这个问题需要多选或分步操作，请在 Panecast 中处理。');
    const parse = value => value.split('\n').flatMap(line => {
      const match = /^\s*([›❯>→●])?\s*(\d{1,2})[.)]\s+/.exec(line); return match ? [{ selected: Boolean(match[1]), number: Number(match[2]) }] : [];
    });
    const choices = parse(prompt), wanted = choices.findIndex(c => c.number === args.option);
    if (wanted < 0 || choices.filter(c => c.selected).length !== 1) throw new Error('无法可靠识别当前高亮选项，请在 Panecast 中处理。');
    await this.gateway.validate(task.target, true);
    this.store.saveOperation({ id, taskId: task.id, kind: 'answer', state: 'attempting' });
    try {
      for (let step = 0; step < 13; step++) {
        const current = await this.gateway.question(task.target);
        if (questionKey(current) !== args.question_id) throw new Error('问题变化');
        const selected = parse(current).findIndex(c => c.selected);
        if (selected < 0) throw new Error('高亮选项未知');
        if (selected === wanted) { await this.gateway.key(task.target, 'enter'); break; }
        if (step === 12) throw new Error('未能选择目标选项');
        await this.gateway.key(task.target, selected < wanted ? 'down' : 'up');
        await delay(150);
      }
    } catch {
      this.store.saveOperation({ id, taskId: task.id, kind: 'answer', state: 'unknown' });
      throw new Error('选项操作结果未确认，未自动重复提交，请查看终端。');
    }
    this.store.saveOperation({ id, taskId: task.id, kind: 'answer', state: 'sent' });
    this.store.saveTask({ ...task, state: 'running', question: null, executionId: id });
    return { submitted: true };
  }
  async tool(managerId, name, args) {
    if (!this.enabled()) throw new Error('监工自动调度已暂停。');
    let manager = this.store.meta('manager');
    if (!manager || manager.id !== managerId) throw new Error('监工会话已变化，请使用当前监工。');
    this.store.event('manager_tool', null, { name, managerId });
    if (name === 'inbox') {
      try { const page = await this.gateway.managerSnapshot(manager); await this.syncConsole(manager, page); } catch {}
      manager = this.store.meta('manager');
      if (manager.wake && ['attempting', 'sent', 'unknown'].includes(manager.wake.state)) this.store.setMeta('manager', { ...manager, state: 'working', wake: { ...manager.wake, state: 'received' } });
      return { requests: this.store.inbox(), tasks: this.store.tasks().map(taskSummary) };
    }
    if (name === 'list_tasks') return this.store.tasks().map(taskSummary);
    if (name === 'list_terminals') return this.listTerminals();
    if (name === 'inspect_terminal') {
      const { targets } = await this.gateway.list(), target = targets.find(t => t.code === args.terminal_id);
      if (!target || target.surface_id === manager.target?.surface_id) throw new Error('请选择有效的执行者终端。');
      const page = await this.gateway.snapshot(target);
      return { title: target.title, project: target.cwd, available: page.available, active: page.active, messages: messages(page), question: await this.gateway.question(target) };
    }
    if (name === 'adopt_task') return this.adopt(args);
    if (name === 'create_task') return this.create(args);
    if (name === 'send_task') return this.send(args);
    if (name === 'pause_task') return this.pauseTask(args);
    if (name === 'answer_task') return this.answerTask(args);
    if (name === 'inspect_task') {
      const task = this.task(args.task_id), page = await this.checked(task);
      const question = await this.gateway.question(task.target);
      return { ...taskSummary(task), active: page.active, messages: messages(page), question, question_id: questionKey(question), evidence: this.store.taskEvents(task.id), deliveries: this.store.operations(task.id).slice(-8) };
    }
    if (name === 'set_priority') {
      const task = this.task(args.task_id); this.trigger(args.trigger_id, task.id, true);
      if (!Number.isInteger(args.priority) || args.priority < 1 || args.priority > 5) throw new Error('优先级范围是 1–5');
      return taskSummary(this.store.saveTask({ ...task, priority: args.priority }));
    }
    if (name === 'record_result') {
      const task = this.task(args.task_id), state = args.state, summary = required(args.summary, '结果说明');
      if (!['needs_input', 'blocked', 'ready_for_review', 'done'].includes(state) || !Array.isArray(args.evidence_ids) || args.evidence_ids.length > 12) throw new Error('结果格式无效');
      const evidence = args.evidence_ids.map(id => this.store.getEvent(id));
      if (evidence.some(event => !event || event.taskId !== task.id)) throw new Error('证据必须属于当前任务。');
      if (state === 'done') {
        if (this.store.operations(task.id, ['queued', 'attempting', 'unknown']).length) throw new Error('仍有未确认的指令，不能标记完成。');
        const page = await this.checked(task); if (page.active) throw new Error('执行者仍在处理，暂不能验收完成。');
        if (!evidence.some(event => event.type === 'final' && (!task.lastSentAt || event.at >= task.lastSentAt))) throw new Error('完成任务需要最近一次执行后的实际结果事件。');
      }
      if (task.state === state && task.summary === summary && JSON.stringify(task.evidence) === JSON.stringify(args.evidence_ids)) return taskSummary(task);
      return taskSummary(this.store.saveTask({ ...task, state, summary, evidence: args.evidence_ids, revision: task.revision + 1, ...(state === 'done' && task.state !== 'done' ? { completedAt: Date.now() } : {}) }));
    }
    if (name === 'notify_user') {
      const text = required(args.text, '消息正文', 16000); let id, audience, task;
      if (args.kind === 'reply') {
        const request = this.trigger(args.request_id, null, true, true);
        audience = request.audience || (request.origin === 'setup' ? this.store.meta('audience') : ''); id = 'reply:' + request.id;
      } else if (['question', 'completed'].includes(args.kind)) {
        task = this.task(args.task_id); await this.gateway.validate(task.target);
        if (args.kind === 'completed' && task.state !== 'done') throw new Error('任务验收完成后才能发送完成通知。');
        if (args.kind === 'question' && !['needs_input', 'blocked'].includes(task.state)) throw new Error('任务需要用户回应时才能发送问题通知。');
        audience = task.audience || this.store.meta('audience');
        id = args.kind === 'completed' ? `completed:${task.id}:${task.executionId ?? 'adopted'}` : `question:${task.id}:${task.executionId ?? 'adopted'}:${hash(task.question || task.blocker || task.summary)}`;
      } else throw new Error('通知类型无效');
      if (!audience) return { deliveredTo: 'console', message: '微信尚未连接，这段答复请显示在终端。' };
      this.store.publish(id, audience, { kind: args.kind, text, ...(task ? { taskId: task.id, target: task.target } : {}) });
      return { queued: true, message: '已进入微信发送队列。' };
    }
    if (name === 'acknowledge') {
      if (!Array.isArray(args.ids) || args.ids.length > 40 || args.ids.some(id => !this.store.input(id))) throw new Error('请求 ID 无效');
      this.store.acknowledge(args.ids); return { acknowledged: args.ids.length };
    }
    throw new Error('不支持这个监工工具');
  }
  async observeTask(task) {
    let page;
    try { page = await this.gateway.snapshot(task.target); }
    catch {
      if (task.state !== 'blocked' && !['done', 'paused'].includes(task.state)) {
        this.store.saveTask({ ...task, state: 'blocked', blocker: '执行终端暂不可访问，请核查连接或权限。' });
        this.store.enqueue({ id: `offline:${task.id}:${task.revision}`, type: 'blocked', taskId: task.id, text: '执行终端暂不可访问。' });
      }
      return;
    }
    if (task.expectedSessionId && !task.binding) {
      if (!page.available || page.conversation_id !== task.expectedSessionId) return;
      task.binding = binding(page); task.state = 'running';
    }
    if (!sameBinding(task.binding, page)) {
      if (task.blocker !== '会话身份已变化') {
        this.store.saveTask({ ...task, state: 'blocked', blocker: '会话身份已变化' });
        this.store.enqueue({ id: `identity:${task.id}:${hash(binding(page))}`, type: 'blocked', taskId: task.id, text: '原终端换了会话，禁止把旧任务指令发给新会话。' });
      }
      return;
    }
    const fresh = (page.items ?? []).filter(i => (i.updatedSequence ?? i.sequence ?? 0) >= task.cursor);
    const relevant = fresh.filter(i => i.type === 'agentMessage' && (i.phase === 'final' || i.needsInput));
    for (const item of relevant) {
      const id = `result:${task.id}:${item.id}`, type = item.needsInput ? 'question' : 'final';
      this.store.event(type, task.id, { text: item.text, itemId: item.id }, id);
      this.store.enqueue({ id, type, taskId: task.id, text: item.text });
      if (!['done', 'paused'].includes(task.state)) task.state = type === 'question' ? 'needs_input' : 'ready_for_review';
    }
    for (const op of this.store.operations(task.id, ['sent', 'unknown'])) {
      if (op.kind === 'send' && (page.items ?? []).some(i => i.type === 'userMessage' && (i.sequence ?? 0) >= op.beforeSequence && clean(textOf(i)) === clean(op.instruction))) {
        this.store.saveOperation({ ...op, state: 'received' });
        task.executionId = op.id;
        if (task.blocker?.includes('未确认')) { task.blocker = null; task.state = page.active ? 'running' : relevant.some(i => i.phase === 'final') ? 'ready_for_review' : 'observing'; }
      }
    }
    let question = null; try { question = await this.gateway.question(task.target); } catch {}
    if (question && question !== task.question) {
      const id = `question:${task.id}:${hash(question)}`; this.store.event('question', task.id, { text: question }, id);
      this.store.enqueue({ id, type: 'question', taskId: task.id, text: question });
      task.state = 'needs_input';
    }
    const nextCursor = cursor(page);
    if (task.cursor !== nextCursor || task.question !== question || relevant.length || task.expectedSessionId) this.store.saveTask({ ...task, expectedSessionId: undefined, cursor: Math.max(task.cursor, nextCursor), question });
    const queued = this.store.operations(task.id, ['queued'])[0];
    if (!queued || page.active || question || task.state === 'paused') return;
    if (this.store.operations(task.id, ['unknown', 'attempting']).length) return;
    await this.gateway.validate(task.target, true);
    const attempting = { ...queued, state: 'attempting', beforeSequence: cursor(page) };
    this.store.saveOperation(attempting);
    try { await this.gateway.input(task.target, queued.instruction, page); }
    catch (error) {
      const message = error.notSent ? '原执行者不可用，指令没有发送；请检查终端。' : '指令发送结果未确认，请查看终端，不会自动重发。';
      this.store.saveOperation({ ...attempting, state: error.notSent ? 'failed' : 'unknown' });
      this.store.saveTask({ ...this.task(task.id), state: 'blocked', blocker: message });
      this.store.enqueue({ id: 'delivery:' + queued.id, type: 'blocked', taskId: task.id, text: message }); return;
    }
    this.store.transaction(() => {
      this.store.saveOperation({ ...attempting, state: 'sent' });
      this.store.saveTask({ ...this.task(task.id), state: 'running', lastSentAt: Date.now(), blocker: null, executionId: queued.id });
    });
  }
  async tick() {
    if (!this.enabled()) return;
    for (const task of this.store.tasks().filter(task => !['done', 'paused'].includes(task.state)).sort((a, b) => a.priority - b.priority)) await this.observeTask(task);
    let manager = this.store.meta('manager'); if (!manager?.target) return;
    let page;
    try { await this.gateway.validate(manager.target); page = await this.gateway.managerSnapshot(manager); }
    catch { if (manager.state !== 'offline') this.store.setMeta('manager', { ...manager, state: 'offline', lastError: '监工终端已关闭或暂不可访问。' }); return; }
    if (!page.available) {
      const setup = await this.gateway.startupStatus?.(manager);
      if (setup) {
        this.store.setMeta('manager', { ...manager, state: 'needs_setup', lastError: setup });
        const audience = this.store.meta('audience'); if (audience) this.store.publish('setup:' + manager.id, audience, { kind: 'question', text: setup });
      }
      if (setup || !manager.connected) return;
    }
    await this.syncConsole(manager, page); manager = this.store.meta('manager');
    manager.state = page.active ? 'working' : 'ready';
    if (manager.lastError?.includes('首次')) manager.lastError = null;
    if (manager.wake && ['sent', 'attempting', 'unknown'].includes(manager.wake.state)) {
      if ((page.items ?? []).some(i => i.type === 'userMessage' && textOf(i).includes(manager.wake.marker))) manager.wake.state = 'received';
      else if (Date.now() - manager.wake.at > 15000) { manager.wake.state = 'unknown'; manager.lastError = '监工输入未确认，暂停自动投递，请检查监工终端。'; }
    }
    this.store.setMeta('manager', manager);
    const inbox = this.store.inbox();
    if (!inbox.length || page.active || manager.wake?.state === 'unknown') return;
    const fingerprint = hash(inbox.map(input => input.id));
    if (manager.wake?.fingerprint === fingerprint) {
      if (manager.wake.state !== 'received' || Date.now() - manager.wake.at < 45000) return;
      if ((manager.wake.reminders ?? 0) >= 1) {
        const audience = this.store.meta('audience');
        if (audience) this.store.publish('manager-stalled:' + fingerprint, audience, { kind: 'question', text: '监工尚未确认处理这批请求，请打开 cmux「监工」查看是否遇到连接或输入问题。' });
        return;
      }
    }
    if (manager.wake && ['sent', 'attempting'].includes(manager.wake.state)) return;
    if (await this.gateway.question(manager.target)) return;
    const marker = '[Panecast 唤醒 ' + randomUUID() + ']';
    const reminders = manager.wake?.fingerprint === fingerprint ? (manager.wake.reminders ?? 0) + 1 : 0;
    manager.wake = { fingerprint, marker, state: 'attempting', at: Date.now(), reminders };
    this.store.setMeta('manager', manager);
    try { await this.gateway.input(manager.target, `${marker}\n有 ${inbox.length} 条新的用户请求或任务结果。先调用 inbox，再处理并 acknowledge。`, page); }
    catch { manager.wake.state = 'unknown'; manager.lastError = '唤醒回执未确认，未自动重试。'; this.store.setMeta('manager', manager); return; }
    manager.wake.state = 'sent'; this.store.setMeta('manager', manager);
  }
  async close() { await this.queue; this.closed = true; }
}
