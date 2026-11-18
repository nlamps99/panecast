import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { RpcError } from '../tmux.mjs';
import { writeJSON } from '../push.mjs';
import { saveUpload } from './share-files.mjs';
import { sharesDirectory, shareTerminals } from './share-binding.mjs';

/*
 * Tasks for a shared window. A program sends text and files with the share's
 * key (over the broker's HTTP API, which opens a guest session for each
 * call); the gateway queues them and types them, one at a time, into the
 * share's first terminal, where the owner can watch. When Claude's turn for a
 * task ends, its last message is the task's result.
 *
 * The window's Claude reports its own turns through hooks (withTaskHooks):
 * each terminal appends what Claude passes to its hooks to a file of its own
 * (SessionStart, UserPromptSubmit, Stop, SessionEnd). Stop carries the turn's
 * prompt_id and Claude's last message. An Esc leaves no Stop; the transcript
 * then holds "[Request interrupted by user]" under the same promptId.
 */

/** The text goes into the window as one paste. */
export const TASK_TEXT_MAX = 32_000;
export const TASK_FILES_MAX = 10;
export const TASK_FILES_BYTES = 20 * 1024 * 1024;
export const TASK_WAIT_MAX_S = 300;
/** Records kept per share; the folders of older tasks stay in the shared directory. */
const TASK_RECORDS_KEPT = 200;
/** A pasted task Claude has not taken by then is reported, never pasted again: it may still sit in the input box. */
const SUBMIT_TIMEOUT_MS = 60_000;
/** How long a new terminal may take before Claude reports it started. */
const START_TIMEOUT_MS = 120_000;
const RESULT_FILES_MAX = 50;
const FINAL = new Set(['done', 'failed', 'canceled']);
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const INTERRUPTED = /^\[Request interrupted by user/;

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const taskEventsDirectory = (config, share) => join(sharesDirectory(config), share.id, 'events');
export const taskRecordFile = (config, share) => join(sharesDirectory(config), share.id, 'tasks.json');
/** The name cmux gives a terminal in CMUX_SURFACE_ID, as the hook files it. */
export const surfaceFileName = (surfaceId) => String(surfaceId ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
const marker = (id) => `【任务 ${id}】`;
/** Claude hands a paste to its hooks wrapped in <pasted_content> tags, so the mark is looked for near the start. */
const MARKER = /【任务 (t[0-9a-f]{10})】/;
/**
 * Claude turns a multi-line paste into "[Pasted text #1 +7 lines]" and drops a
 * Return that arrives with it, so Enter goes as its own key a moment later.
 * An Enter it still missed is pressed again, never the paste: on an empty
 * prompt Enter does nothing.
 */
const ENTER_RETRY_MS = [10_000, 25_000];

/**
 * The hook command: appends the JSON Claude passes on stdin, one line, to the
 * file of the terminal it runs in. It writes nothing to stdout, which Claude
 * would add to the conversation, and never fails the turn.
 */
export function taskHookCommand(directory) {
  const folder = quote(directory);
  return `n=$(printf %s "\${CMUX_SURFACE_ID:-unknown}" | /usr/bin/tr 'A-Z' 'a-z' | /usr/bin/tr -cd 'a-z0-9_-'); /bin/mkdir -p ${folder} && { /bin/cat; echo; } >> ${folder}/"$n".jsonl; exit 0`;
}

/** `settings` with the task hooks, every other hook kept. */
export function withTaskHooks(settings, directory) {
  const command = taskHookCommand(directory);
  const hooks = { ...settings?.hooks };
  for (const event of HOOK_EVENTS) {
    const others = (hooks[event] ?? []).filter((entry) => !entry?.hooks?.some((hook) => hook?.command === command));
    hooks[event] = [...others, { hooks: [{ type: 'command', command }] }];
  }
  return { ...settings, hooks };
}

/** What the window receives for a task. Paths are relative to the shared directory, where Claude runs. */
export function taskPrompt(task) {
  const lines = [marker(task.id), task.text];
  if (task.attachments?.length) lines.push('', '附件（图片和 PDF 用 Read 工具查看）：', ...task.attachments.map((path) => `- ./${path}`));
  lines.push('', `（要交付文件的话，保存到 ./tasks/${task.id}/out/ 里；你最后的回复会作为这个任务的结果返回。）`);
  return lines.join('\n');
}

/** Complete lines appended to a hook file since `offset`. A half-written last line waits for the next read. */
export async function readHookEvents(path, offset = 0) {
  let handle;
  try { handle = await open(path, 'r'); } catch (error) { if (error.code === 'ENOENT') return { events: [], offset: 0, missing: true }; throw error; }
  try {
    const { size } = await handle.stat();
    let start = size < offset ? 0 : offset;
    if (size - start > 32 * 1024 * 1024) start = size - 16 * 1024 * 1024;
    if (size === start) return { events: [], offset: start };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let from = 0;
    // A read that starts mid-file (a very long history) skips the cut line.
    if (start > 0 && start !== offset) from = buffer.indexOf(0x0a) + 1;
    const end = buffer.lastIndexOf(0x0a);
    if (end < from) return { events: [], offset: start + from };
    const events = buffer.subarray(from, end).toString('utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try { const value = JSON.parse(line); return value && typeof value === 'object' && typeof value.hook_event_name === 'string' ? [value] : []; } catch { return []; }
    });
    return { events, offset: start + end + 1 };
  } finally { await handle.close(); }
}

const blockText = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';

/** Whether Claude's transcript shows the turn of `promptId` interrupted (Esc), and the last text Claude wrote in it. */
export async function promptOutcome(transcriptPath, promptId) {
  if (typeof transcriptPath !== 'string' || !promptId) return { seen: false };
  let handle;
  try { handle = await open(transcriptPath, 'r'); } catch { return { seen: false }; }
  let text;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally { await handle.close(); }
  let seen = false, interrupted = false, last = '';
  for (const line of text.split('\n')) {
    if (!line.includes(promptId)) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.promptId !== promptId || entry.isSidechain) continue;
    seen = true;
    const said = blockText(entry.message?.content);
    if (entry.type === 'user' && INTERRUPTED.test(said)) interrupted = true;
    if (entry.type === 'assistant' && said.trim()) last = said;
  }
  return { seen, interrupted, text: last };
}

/** Files Claude left in the task's out folder, relative to the shared directory. */
async function resultFiles(directory, id) {
  const root = join(directory, 'tasks', id, 'out'), files = [];
  const walk = async (folder, depth) => {
    let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= RESULT_FILES_MAX || entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(path, depth + 1);
      else if (entry.isFile()) files.push({ path: relative(directory, path).split('\\').join('/'), size: (await stat(path).catch(() => ({ size: 0 }))).size });
    }
  };
  await walk(root, 0);
  return files;
}

/** What a caller sees of a task. */
function view(task, queue) {
  const { surface_id, prompt_id, sent_at, finishing, enters, ...rest } = task;
  const position = task.status === 'queued' ? queue.filter((other) => other.status === 'queued').findIndex((other) => other.id === task.id) + 1 : undefined;
  return { ...rest, ...(position ? { position } : {}) };
}

const newTaskId = () => `t${randomBytes(5).toString('hex')}`;

/** Accepts `{ name, data_base64 }` or a data URL; returns `{ name, data }`. */
export function taskAttachment(value, index) {
  if (!value || typeof value !== 'object') throw new RpcError('invalid_params', '附件格式无效');
  let data = value.data_base64 ?? value.data ?? value.base64;
  let name = typeof value.name === 'string' && value.name.trim() ? value.name : typeof value.filename === 'string' ? value.filename : '';
  if (typeof data !== 'string') throw new RpcError('invalid_params', '附件需要 base64 数据');
  const url = /^data:([\w.+/-]+)?(?:;[\w=.+-]+)*;base64,/.exec(data);
  if (url) {
    data = data.slice(url[0].length);
    if (!name) name = `${index + 1}.${({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' })[url[1]] ?? 'bin'}`;
  }
  data = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new RpcError('invalid_params', '附件的 base64 数据无效');
  return { name: name || `${index + 1}.bin`, data: Buffer.from(data, 'base64') };
}

/**
 * Runs the tasks of every share created with `--tasks`. One instance per
 * gateway: it alone writes each share's tasks.json, and it sends a share's
 * tasks one at a time, only while the window's Claude is idle.
 */
export class ShareTasks {
  constructor({ config, shares, client, fileLinks = null, now = Date.now, pollMs = 1000, settleMs = 400, shareTerminalCommand = null, openShareWorkspace = null }) {
    Object.assign(this, { config, shares, client, fileLinks, now, pollMs, settleMs, shareTerminalCommand, openShareWorkspace, states: new Map(), timer: null, ticking: null, closed: false });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }

  close() { this.closed = true; clearInterval(this.timer); for (const state of this.states.values()) for (const wake of state.waiters) wake(); }

  /** One share's state, loaded once from its record file. Changes run one at a time per share. */
  async state(share) {
    let state = this.states.get(share.id);
    if (!state) {
      state = { tasks: [], loaded: null, lane: Promise.resolve(), waiters: new Set(), terminal: null, checkedAt: 0, starting: null, live: null };
      this.states.set(share.id, state);
    }
    state.loaded ??= readFile(taskRecordFile(this.config, share), 'utf8').then((text) => {
      const value = JSON.parse(text);
      if (Array.isArray(value?.tasks)) state.tasks = value.tasks;
    }, () => {});
    await state.loaded;
    return state;
  }

  exclusive(share, work) {
    return this.state(share).then((state) => {
      const run = state.lane.then(() => work(state));
      state.lane = run.then(() => {}, () => {});
      return run;
    });
  }

  async save(share, state) {
    const unfinished = state.tasks.filter((task) => !FINAL.has(task.status));
    const finished = state.tasks.filter((task) => FINAL.has(task.status)).slice(-Math.max(0, TASK_RECORDS_KEPT - unfinished.length));
    state.tasks = state.tasks.filter((task) => unfinished.includes(task) || finished.includes(task));
    await writeJSON(taskRecordFile(this.config, share), { version: 1, tasks: state.tasks });
    for (const wake of [...state.waiters]) wake();
  }

  async submit(share, params) {
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new RpcError('invalid_params', '任务内容不能为空');
    if (text.length > TASK_TEXT_MAX) throw new RpcError('invalid_params', `任务文字最多 ${TASK_TEXT_MAX} 个字符`);
    const given = params.attachments ?? [];
    if (!Array.isArray(given) || given.length > TASK_FILES_MAX) throw new RpcError('invalid_params', `每个任务最多 ${TASK_FILES_MAX} 个附件`);
    const files = given.map(taskAttachment);
    if (files.reduce((sum, file) => sum + file.data.length, 0) > TASK_FILES_BYTES) throw new RpcError('too_large', `附件合计不能超过 ${TASK_FILES_BYTES / 1024 / 1024} MB`);
    const id = newTaskId();
    const attachments = [];
    if (files.length) {
      const folder = join(share.directory, 'tasks', id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      for (const file of files) attachments.push(`tasks/${id}/${(await saveUpload(folder, file.name, file.data)).filename}`);
    }
    return this.exclusive(share, async (state) => {
      const task = { id, status: 'queued', text, attachments, created_at: new Date(this.now()).toISOString(), started_at: null, finished_at: null, result: null, error: null, files: [] };
      state.tasks.push(task);
      await this.save(share, state);
      queueMicrotask(() => { void this.tick().catch(() => {}); });
      return view(task, state.tasks);
    });
  }

  async find(share, id) {
    const state = await this.state(share);
    const task = state.tasks.find((entry) => entry.id === id);
    if (!task) throw new RpcError('task_not_found', '找不到这个任务');
    return { state, task };
  }

  /** The task as it is now, or once it finishes within `waitSeconds`. */
  async get(share, id, waitSeconds = 0) {
    let { state, task } = await this.find(share, id);
    const deadline = this.now() + Math.min(Math.max(0, Number(waitSeconds) || 0), TASK_WAIT_MAX_S) * 1000;
    while (!FINAL.has(task.status) && this.now() < deadline && !this.closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.max(0, deadline - this.now()));
        function done() { clearTimeout(timer); state.waiters.delete(done); resolve(); }
        state.waiters.add(done);
      });
      ({ state, task } = await this.find(share, id));
    }
    return this.withLinks(share, view(task, state.tasks));
  }

  async withLinks(share, task) {
    if (!this.fileLinks || !task.files?.length) return task;
    const files = [];
    for (const file of task.files) {
      try { const link = await this.fileLinks.link(share.directory, file.path); files.push({ ...file, url: link.url, expires_at: link.expires_at }); }
      catch (error) { files.push({ ...file, link_error: error.message }); }
    }
    return { ...task, files };
  }

  async list(share, limit = 20) {
    const state = await this.state(share);
    const count = Math.min(Math.max(1, Number(limit) || 20), TASK_RECORDS_KEPT);
    return state.tasks.slice(-count).reverse().map((task) => view(task, state.tasks));
  }

  /** A queued task leaves the queue; one in the window is interrupted with Esc. */
  async cancel(share, id) {
    return this.exclusive(share, async (state) => {
      const task = state.tasks.find((entry) => entry.id === id);
      if (!task) throw new RpcError('task_not_found', '找不到这个任务');
      if (FINAL.has(task.status)) return view(task, state.tasks);
      if (task.status !== 'queued' && task.surface_id) {
        await this.client(share.source_id).call('surface.send_key', { workspace_id: share.workspace_id, surface_id: task.surface_id, key: 'escape' }).catch(() => {});
      }
      Object.assign(task, { status: 'canceled', finished_at: new Date(this.now()).toISOString(), error: '已取消' });
      await this.save(share, state);
      return view(task, state.tasks);
    });
  }

  async tick() {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      let shares;
      try { shares = await this.shares.read(); } catch { return; }
      for (const share of shares) {
        if (share.tasks !== true || share.revoked_at || this.closed) continue;
        await this.exclusive(share, (state) => this.advance(share, state)).catch(() => {});
      }
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  /** Reads the terminal's new hook events and moves this share's tasks along. */
  async advance(share, state) {
    let changed = false;
    const surfaceId = share.surface_id;
    if (state.terminal?.surfaceId !== surfaceId) state.terminal = { surfaceId, offset: 0, ready: false, busy: null, sessionId: null, transcript: null, endedAt: null, startedWaiting: null };
    const terminal = state.terminal;
    const read = await readHookEvents(join(taskEventsDirectory(this.config, share), `${surfaceFileName(surfaceId)}.jsonl`), terminal.offset);
    terminal.offset = read.offset;
    for (const event of read.events) changed = this.apply(state, terminal, event) || changed;
    for (const task of state.tasks.filter((entry) => entry.finishing)) {
      delete task.finishing;
      task.files = await resultFiles(share.directory, task.id);
      // Claude Code before last_assistant_message in the Stop hook: the transcript has it.
      if (!task.result) task.result = (await promptOutcome(terminal.transcript, task.prompt_id)).text || '';
      changed = true;
    }
    // Esc ends a turn without a Stop hook: the transcript shows it.
    if (terminal.busy && this.now() - (terminal.checkedAt ?? 0) > 3000) {
      terminal.checkedAt = this.now();
      const outcome = await promptOutcome(terminal.transcript, terminal.busy.promptId);
      if (outcome.interrupted) {
        const task = state.tasks.find((entry) => entry.prompt_id === terminal.busy.promptId && entry.status === 'running');
        if (task) { Object.assign(task, { status: 'failed', error: '任务在窗口里被中断了', result: outcome.text || null, finished_at: new Date(this.now()).toISOString() }); changed = true; }
        terminal.busy = null;
      }
    }
    const sending = state.tasks.find((task) => task.status === 'sending');
    const enters = sending?.enters ?? 1;
    if (sending && enters <= ENTER_RETRY_MS.length && this.now() - Date.parse(sending.sent_at) > ENTER_RETRY_MS[enters - 1]) {
      sending.enters = enters + 1;
      await this.client(share.source_id).call('surface.send_key', { workspace_id: share.workspace_id, surface_id: sending.surface_id, key: 'enter' }).catch(() => {});
    }
    if (sending && this.now() - Date.parse(sending.sent_at) > SUBMIT_TIMEOUT_MS) {
      Object.assign(sending, { status: 'failed', error: '任务送进窗口后 Claude 没有开始处理（窗口可能在等你确认什么），请看一下窗口', finished_at: new Date(this.now()).toISOString() });
      changed = true;
    }
    // A paste Claude never took (timed out or canceled) no longer holds the window.
    if (terminal.busy?.pasted && !state.tasks.some((task) => task.status === 'sending')) terminal.busy = null;
    const next = state.tasks.find((task) => task.status === 'queued');
    if (next && !state.tasks.some((task) => task.status === 'sending' || task.status === 'running')) changed = await this.dispatch(share, state, terminal, next) || changed;
    if (changed) await this.save(share, state);
  }

  apply(state, terminal, event) {
    const name = event.hook_event_name;
    if (typeof event.transcript_path === 'string') terminal.transcript = event.transcript_path;
    if (typeof event.session_id === 'string') terminal.sessionId = event.session_id;
    if (name === 'SessionStart') { Object.assign(terminal, { ready: true, busy: null, endedAt: null }); return false; }
    // /clear ends one session and starts the next right away.
    if (name === 'SessionEnd') { Object.assign(terminal, { ready: false, busy: null, endedAt: event.reason === 'clear' ? null : this.now() }); return false; }
    if (name === 'UserPromptSubmit') {
      terminal.busy = { promptId: event.prompt_id ?? null };
      const id = MARKER.exec(typeof event.prompt === 'string' ? event.prompt.slice(0, 400) : '')?.[1];
      // The first prompt after a paste is the task's even if Claude shortened its text.
      const task = state.tasks.find((entry) => entry.id === id && (entry.status === 'sending' || (entry.status === 'failed' && entry.prompt_id == null && entry.sent_at)))
        ?? (!id ? state.tasks.find((entry) => entry.status === 'sending') : undefined);
      if (!task) return false;
      Object.assign(task, { status: 'running', prompt_id: event.prompt_id ?? null, started_at: new Date(this.now()).toISOString(), error: null, finished_at: null });
      return true;
    }
    if (name === 'Stop') {
      if (!terminal.busy || !event.prompt_id || terminal.busy.promptId === event.prompt_id) terminal.busy = null;
      const task = event.prompt_id ? state.tasks.find((entry) => entry.prompt_id === event.prompt_id && entry.status === 'running') : null;
      if (!task) return false;
      task.status = 'done';
      task.result = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '';
      task.finished_at = new Date(this.now()).toISOString();
      task.finishing = true;
      return true;
    }
    return false;
  }

  /** Sends the next task when the window's Claude is idle, opening a new terminal first when the old one is gone. */
  async dispatch(share, state, terminal, task) {
    let changed = false;
    if (terminal.busy) return changed;
    const client = this.client(share.source_id);
    let live = true;
    if (this.now() - state.checkedAt > 5000 || !terminal.ready) {
      state.checkedAt = this.now();
      try {
        const { surfaces = [] } = await client.call('surface.list', { workspace_id: share.workspace_id });
        live = surfaces.some((surface) => surface.id === share.surface_id);
      } catch { live = false; }
      state.live = live;
    } else live = state.live ?? true;
    const exited = !terminal.ready && terminal.endedAt !== null && this.now() - terminal.endedAt > 5000;
    if (!live || exited) {
      // The window was closed, or its Claude exited: start the same Claude in a new terminal.
      if (state.starting) return changed;
      state.starting = this.reopen(share).finally(() => { state.starting = null; state.checkedAt = 0; });
      await state.starting.catch((error) => {
        Object.assign(task, { status: 'failed', error: `任务窗口没能打开：${error.message}`, finished_at: new Date(this.now()).toISOString() });
        changed = true;
      });
      return true;
    }
    if (!terminal.ready) {
      terminal.startedWaiting ??= this.now();
      // A terminal without hooks (opened before tasks were on) never reports ready.
      if (this.now() - terminal.startedWaiting > START_TIMEOUT_MS && !task.waiting) { task.waiting = '等任务窗口里的 Claude 启动（如果窗口在问「信任这个文件夹」，请在电脑上确认）'; changed = true; }
      return changed;
    }
    delete task.waiting;
    const target = { workspace_id: share.workspace_id, surface_id: share.surface_id };
    await client.call('terminal.paste', { ...target, text: taskPrompt(task) });
    Object.assign(task, { status: 'sending', sent_at: new Date(this.now()).toISOString(), surface_id: share.surface_id, enters: 1 });
    if (this.settleMs) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    await client.call('surface.send_key', { ...target, key: 'enter' }).catch(() => {});
    // Claude takes it as a new turn; until the hook says so the window counts as busy.
    terminal.busy = { promptId: null, pasted: true };
    return true;
  }

  /** A new terminal in the share's workspace (or a new workspace when that is gone) becomes the task window. */
  async reopen(share) {
    if (!this.shareTerminalCommand) throw new Error('网关不能打开新终端');
    const client = this.client(share.source_id);
    const sessionId = randomUUID();
    const command = await this.shareTerminalCommand(this.config, share, sessionId);
    let created = null, workspaceId = share.workspace_id;
    try { created = await client.call('surface.create', { workspace_id: share.workspace_id, type: 'terminal', cwd: share.directory, initial_command: command, focus: false }); }
    catch {
      if (!this.openShareWorkspace) throw new Error('分享的工作区不在了');
      const opened = await this.openShareWorkspace(share, command);
      workspaceId = opened.workspaceId; created = { surface_id: opened.surfaceId };
    }
    const surfaceId = created?.surface_id ?? created?.id;
    if (typeof surfaceId !== 'string' || !surfaceId) throw new Error('电脑没有返回新终端');
    await this.shares.update(share.id, (entry) => {
      const kept = entry.workspace_id === workspaceId ? shareTerminals(entry).filter((terminal) => terminal.surface_id !== entry.surface_id) : [];
      Object.assign(entry, { workspace_id: workspaceId, surface_id: surfaceId, session_id: sessionId,
        terminals: [{ surface_id: surfaceId, session_id: sessionId, created_at: new Date(this.now()).toISOString() }, ...kept] });
    });
    Object.assign(share, { workspace_id: workspaceId, surface_id: surfaceId, session_id: sessionId });
  }
}
