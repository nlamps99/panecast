import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
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
 *
 * A task may name another agent: Codex CLI or Antigravity CLI (agy). Each
 * agent has its own window in the share's workspace, opened on its first
 * task, and its own queue; different agents work at the same time. They
 * differ (checked on Codex 0.170 and agy 1.5.11, see AGENTS below): both
 * start their session only with the first prompt, so a new or cleared
 * window counts as ready when its screen shows the idle prompt; agy reports
 * only a session's first prompt and no Esc, and its Stop has no message, so
 * its transcript and screen fill in.
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
const exec = promisify(execFile);

/** Agents a task may run with; `claude` is the share's first window. */
export const TASK_AGENTS = ['claude', 'codex', 'agy'];
const AGENT_NAMES = { claude: 'claude', 'claude-code': 'claude', codex: 'codex', agy: 'agy', antigravity: 'agy', 'antigravity-cli': 'agy' };
export function taskAgent(value) {
  if (value === undefined || value === null || value === '') return 'claude';
  const agent = AGENT_NAMES[String(value).trim().toLowerCase()];
  if (!agent) throw new RpcError('invalid_params', 'agent 只能是 claude、codex 或 agy');
  return agent;
}
/** The idle prompt of a TUI: no turn running, no menu or question in front of it. Codex shows "? for shortcuts" while it works too. */
const idleScreen = (refuse, busy) => (text) => /\? for shortcuts/.test(text) && !refuse.test(text) && !busy.test(text);
const CODEX_BUSY = /esc to interrupt/i;
const AGY_BUSY = /esc to cancel/i;
/**
 * How each agent's window is driven.
 * - `clear`: the command that starts an empty conversation. Claude confirms it
 *   with SessionStart "clear"; Codex (/new) and agy (/clear) say nothing until
 *   the next prompt, so their cleared screen (no task mark left) confirms it.
 * - `lazy`: the session (and SessionStart) begins only with the first prompt.
 * - `busy`: the screen while a turn runs. Codex can still be ending its turn
 *   just after its Stop hook, and then drops /new with `refused`; agy's
 *   /clear would cancel a running turn. Their clear waits for an idle screen,
 *   and a /new Codex dropped is typed again.
 */
const AGENTS = {
  claude: { label: 'Claude', clear: '/clear', lazy: false },
  codex: { label: 'Codex', clear: '/new', lazy: true, busy: CODEX_BUSY, refused: /is disabled while a task is in progress/g,
    idle: idleScreen(/Update now|trust this|Do you trust/i, CODEX_BUSY) },
  agy: { label: 'Antigravity', clear: '/clear', lazy: true, busy: AGY_BUSY, idle: idleScreen(/trust the contents|Do you trust/i, AGY_BUSY), interrupted: /Interrupted · What should/ },
};
const occurrences = (pattern, text) => (pattern ? text.match(pattern)?.length ?? 0 : 0);
/** How many times a clear command is typed before the task fails. */
const CLEAR_TYPED_MAX = 3;
const CLEAR_SETTLE_MS = 1500;
const TASK_MARK = /【任务 t[0-9a-f]{10}】/;
const INTERRUPTED = /^\[Request interrupted by user/;

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const taskEventsDirectory = (config, share) => join(sharesDirectory(config), share.id, 'events');
export const taskRecordFile = (config, share) => join(sharesDirectory(config), share.id, 'tasks.json');
/**
 * The hook for Codex and agy: the same append, to the folder named by
 * PANECAST_TASK_EVENTS, which only a task window's environment sets. agy
 * loads hooks only from an installed plugin, which then runs in every agy
 * session; elsewhere this does nothing.
 */
export const ENV_HOOK_COMMAND = `[ -n "$PANECAST_TASK_EVENTS" ] || exit 0; n=$(printf %s "\${CMUX_SURFACE_ID:-unknown}" | /usr/bin/tr 'A-Z' 'a-z' | /usr/bin/tr -cd 'a-z0-9_-'); /bin/mkdir -p "$PANECAST_TASK_EVENTS" && { /bin/cat; echo; } >> "$PANECAST_TASK_EVENTS/$n.jsonl"; exit 0`;
export const AGY_PLUGIN = 'panecast-tasks';
/** agy's hooks.json: hook name → event → handlers (agy 1.5.11 refuses Claude's layout). */
export const agyHooks = () => ({ panecast: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ type: 'command', command: ENV_HOOK_COMMAND }]])) });

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
 * Each task starts from an empty conversation unless it asks to continue:
 * `/clear` ends the session (SessionEnd "clear") and starts the next
 * (SessionStart "clear"), and the task goes in after that.
 */
const CLEAR_RETRY_MS = 10_000;
const CLEAR_TIMEOUT_MS = 30_000;
/** Task folders (attachments and results) are deleted this many days after the task ends; 0 keeps them. */
export const TASK_KEEP_DAYS = 7;
const CLEAN_EVERY_MS = 3600_000;
const TASK_ID = /^t[0-9a-f]{10}$/;

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

/**
 * The settings file of a task window: the hooks, and no auto memory. Claude
 * otherwise saves what a task asks it to remember under
 * ~/.claude/projects/<folder>/memory and recalls it after /clear, so one
 * task would still reach the next (seen on Claude Code 2.1.327).
 */
export const taskWindowSettings = (directory) => withTaskHooks({ autoMemoryEnabled: false }, directory);

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
      try { const value = JSON.parse(line); return value && typeof value === 'object' && typeof (value.hook_event_name ?? value.hookEventName) === 'string' ? [value] : []; } catch { return []; }
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

/** One hook event of any agent: Claude and Codex (snake_case, Codex's turn_id) or agy (camelCase). */
export function hookEvent(raw) {
  const name = raw.hook_event_name ?? raw.hookEventName;
  const agy = raw.hookEventName !== undefined;
  return {
    name, agy,
    sessionId: raw.session_id ?? raw.conversationId ?? null,
    transcript: raw.transcript_path ?? raw.transcriptPath ?? null,
    promptId: raw.prompt_id ?? raw.turn_id ?? null,
    // agy names the prompt only in a session's SessionStart and in Stop.
    prompt: typeof raw.prompt === 'string' ? raw.prompt : typeof raw.lastUserInput === 'string' && raw.lastUserInput ? raw.lastUserInput : null,
    message: typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : null,
    source: raw.source ?? null, reason: raw.reason ?? null,
    idle: raw.fullyIdle !== false,
  };
}

/** In agy's transcript: whether the task's prompt arrived, and the last text agy wrote after it. */
export async function agyOutcome(transcriptPath, taskId) {
  if (typeof transcriptPath !== 'string') return { seen: false };
  let text;
  try {
    const handle = await open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 8 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally { await handle.close(); }
  } catch { return { seen: false }; }
  // A running step is written again under the same index when it finishes.
  const steps = new Map();
  for (const line of text.split('\n')) { try { const step = JSON.parse(line); if (Number.isInteger(step?.step_index)) steps.set(step.step_index, step); } catch {} }
  const ordered = [...steps.values()].sort((a, b) => a.step_index - b.step_index);
  const start = ordered.findLastIndex((step) => step.type === 'USER_INPUT' && String(step.content ?? '').includes(marker(taskId)));
  if (start < 0) return { seen: false };
  const reply = ordered.slice(start + 1).findLast((step) => step.type === 'PLANNER_RESPONSE' && String(step.content ?? '').trim());
  return { seen: true, text: reply ? String(reply.content).trim() : '' };
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
  rest.agent ??= 'claude';
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

/** Where an agent CLI is: PANECAST_<AGENT>_BIN, else the PATH plus the usual install folders (never cmux's wrappers). */
export async function agentBinary(agent) {
  const override = process.env[`PANECAST_${agent.toUpperCase()}_BIN`];
  if (override) return override;
  const PATH = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin'].join(':');
  const { stdout } = await exec('/usr/bin/which', [agent], { env: { PATH } }).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) throw new Error(`找不到 ${agent} 命令，请先在这台电脑上安装 ${AGENTS[agent].label} CLI`);
  return stdout.trim();
}

/**
 * The command a Codex or agy window starts with, full access like the
 * share's Claude. Codex always skips the update prompt (whose default answer
 * installs an update); agy trusts the shared directory for this session only.
 * A task window (`events`) reports its turns: Codex takes its hooks on the
 * command line, must skip the hook review, and keeps its memories off.
 * `model`: a name as `codex` or `agy models` lists it.
 */
export function agentCommand(agent, { binary, events = null, directory, model = null }) {
  const start = events ? ['exec', '/usr/bin/env', `PANECAST_TASK_EVENTS=${quote(events)}`, quote(binary)] : ['exec', quote(binary)];
  const chosen = model ? ['--model', quote(model)] : [];
  if (agent === 'codex') {
    const handler = `{type="command",command=${JSON.stringify(ENV_HOOK_COMMAND)}}`;
    const hooks = `hooks={${[...HOOK_EVENTS, 'Interrupt'].map((event) => `${event}=[{hooks=[${handler}]}]`).join(',')}}`;
    return [...start, '--dangerously-bypass-approvals-and-sandbox', ...(events ? ['--dangerously-bypass-hook-trust', '--disable', 'memories'] : []),
      '-c', 'check_for_update_on_startup=false', ...(events ? ['-c', quote(hooks)] : []), ...chosen].join(' ');
  }
  if (agent === 'agy') return [...start, '--dangerously-skip-permissions', ...chosen, '--settings', quote(JSON.stringify({ trustedWorkspaces: [directory] }))].join(' ');
  throw new Error(`unknown agent ${agent}`);
}

/** Installs (or updates) the agy plugin that carries the task hooks; agy has no other way to take them. */
export async function ensureAgyPlugin(binary, folder) {
  const wanted = JSON.stringify(agyHooks(), null, 1);
  const installed = join(homedir(), '.gemini', 'config', 'plugins', AGY_PLUGIN, 'hooks.json');
  if ((await readFile(installed, 'utf8').catch(() => null)) === wanted) return;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, 'plugin.json'), JSON.stringify({ name: AGY_PLUGIN, version: '0.1.0',
    description: 'Reports the turns of Panecast task windows to the Panecast gateway. Does nothing in other agy sessions.' }, null, 1));
  await writeFile(join(folder, 'hooks.json'), wanted);
  await exec(binary, ['plugin', 'uninstall', AGY_PLUGIN], { timeout: 60_000 }).catch(() => {});
  await exec(binary, ['plugin', 'install', folder], { timeout: 60_000 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const agentOf = (task) => task.agent ?? 'claude';

/**
 * Runs the tasks of every share created with `--tasks`. One instance per
 * gateway: it alone writes each share's tasks.json. Each agent of a share
 * (a lane) sends its tasks one at a time, only while its window is idle.
 */
export class ShareTasks {
  constructor({ config, shares, client, fileLinks = null, now = Date.now, pollMs = 1000, settleMs = 400, clearSettleMs = CLEAR_SETTLE_MS,
    shareTerminalCommand = null, openShareWorkspace = null, laneCommand = null }) {
    Object.assign(this, { config, shares, client, fileLinks, now, pollMs, settleMs, clearSettleMs, shareTerminalCommand, openShareWorkspace,
      laneCommand: laneCommand ?? ((agent, share) => this.defaultLaneCommand(agent, share)), states: new Map(), timer: null, ticking: null, closed: false });
  }

  async defaultLaneCommand(agent, share) {
    const binary = await agentBinary(agent);
    if (agent === 'agy') await ensureAgyPlugin(binary, join(sharesDirectory(this.config), share.id, 'agy-plugin'));
    return `/bin/zsh -lc ${quote(agentCommand(agent, { binary, events: taskEventsDirectory(this.config, share), directory: share.directory }))}`;
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
      state = { tasks: [], loaded: null, lane: Promise.resolve(), waiters: new Set(), lanes: new Map() };
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
    const agent = taskAgent(params.agent);
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
      const task = { id, agent, status: 'queued', text, attachments, ...(params.continue === true ? { continue: true } : {}),
        created_at: new Date(this.now()).toISOString(), started_at: null, finished_at: null, result: null, error: null, files: [] };
      state.tasks.push(task);
      await this.save(share, state);
      queueMicrotask(() => { void this.tick().catch(() => {}); });
      return view(task, state.tasks.filter((entry) => agentOf(entry) === agent));
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
    return this.withLinks(share, view(task, state.tasks.filter((entry) => agentOf(entry) === agentOf(task))));
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
    return state.tasks.slice(-count).reverse().map((task) => view(task, state.tasks.filter((entry) => agentOf(entry) === agentOf(task))));
  }

  /** A queued task leaves the queue; one in the window is interrupted with Esc. */
  async cancel(share, id) {
    return this.exclusive(share, async (state) => {
      const task = state.tasks.find((entry) => entry.id === id);
      if (!task) throw new RpcError('task_not_found', '找不到这个任务');
      if (FINAL.has(task.status)) return view(task, []);
      if (task.status !== 'queued' && task.surface_id) {
        await this.client(share.source_id).call('surface.send_key', { workspace_id: share.workspace_id, surface_id: task.surface_id, key: 'escape' }).catch(() => {});
      }
      Object.assign(task, { status: 'canceled', finished_at: new Date(this.now()).toISOString(), error: '已取消' });
      await this.save(share, state);
      return view(task, []);
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

  /** The window an agent's tasks go to: Claude's is the share's first terminal. */
  windowOf(share, agent) { return agent === 'claude' ? share.surface_id : share.task_windows?.[agent]?.surface_id ?? null; }

  /** Moves every lane of the share along, then cleans old task folders. */
  async advance(share, state) {
    let changed = false;
    for (const agent of TASK_AGENTS) {
      const pending = state.tasks.some((task) => agentOf(task) === agent && !FINAL.has(task.status));
      if (!pending && !state.lanes.has(agent) && !this.windowOf(share, agent)) continue;
      changed = await this.advanceLane(share, state, agent).catch(() => false) || changed;
    }
    if (this.now() - (state.cleanedAt ?? 0) > CLEAN_EVERY_MS) { state.cleanedAt = this.now(); changed = await this.clean(share, state) || changed; }
    if (changed) await this.save(share, state);
  }

  /** Reads one agent window's new hook events and moves that agent's tasks along. */
  async advanceLane(share, state, agent) {
    let changed = false;
    const surfaceId = this.windowOf(share, agent);
    let lane = state.lanes.get(agent);
    if (!lane || lane.surfaceId !== surfaceId) {
      lane = { agent, surfaceId, offset: 0, ready: false, busy: null, sessionId: null, transcript: null, endedAt: null, startedWaiting: null, dirty: false, clearing: null, checkedAt: 0, liveAt: 0, live: null, starting: null };
      state.lanes.set(agent, lane);
    }
    const mine = state.tasks.filter((task) => agentOf(task) === agent);
    if (surfaceId) {
      const read = await readHookEvents(join(taskEventsDirectory(this.config, share), `${surfaceFileName(surfaceId)}.jsonl`), lane.offset);
      lane.offset = read.offset;
      for (const raw of read.events) changed = this.apply(mine, lane, hookEvent(raw)) || changed;
    }
    for (const task of mine.filter((entry) => entry.finishing)) {
      task.finishing = (task.finishing === true ? 0 : task.finishing) + 1;
      if (!task.result && agent === 'claude') task.result = (await promptOutcome(lane.transcript, task.prompt_id)).text || '';
      // agy's Stop carries no message; its transcript may be written a moment later.
      if (!task.result && agent === 'agy') task.result = (await agyOutcome(lane.transcript, task.id)).text || '';
      if (task.result || task.finishing > 5) { delete task.finishing; task.result ??= ''; task.files = await resultFiles(share.directory, task.id); changed = true; }
    }
    changed = await this.watchTurn(share, mine, lane) || changed;
    const sending = mine.find((task) => task.status === 'sending');
    const enters = sending?.enters ?? 1;
    if (sending && enters <= ENTER_RETRY_MS.length && this.now() - Date.parse(sending.sent_at) > ENTER_RETRY_MS[enters - 1]) {
      sending.enters = enters + 1;
      await this.client(share.source_id).call('surface.send_key', { workspace_id: share.workspace_id, surface_id: sending.surface_id, key: 'enter' }).catch(() => {});
    }
    if (sending && this.now() - Date.parse(sending.sent_at) > SUBMIT_TIMEOUT_MS) {
      Object.assign(sending, { status: 'failed', error: `任务送进窗口后 ${AGENTS[agent].label} 没有开始处理（窗口可能在等你确认什么），请看一下窗口`, finished_at: new Date(this.now()).toISOString() });
      changed = true;
    }
    // A paste the agent never took (timed out or canceled) no longer holds the window.
    if (lane.busy?.pasted && !mine.some((task) => task.status === 'sending')) lane.busy = null;
    const next = mine.find((task) => task.status === 'queued');
    if (next && !mine.some((task) => task.status === 'sending' || task.status === 'running')) changed = await this.dispatch(share, mine, lane, next) || changed;
    return changed;
  }

  /** Turn ends the hooks do not report: Claude's Esc (transcript), agy's prompts after the first and its Esc (transcript, screen). */
  async watchTurn(share, mine, lane) {
    if (!lane.busy || this.now() - lane.checkedAt < 3000) return false;
    lane.checkedAt = this.now();
    let changed = false;
    const fail = (task, error, result = null) => { Object.assign(task, { status: 'failed', error, result, finished_at: new Date(this.now()).toISOString() }); changed = true; };
    if (lane.agent === 'claude' && lane.busy.promptId) {
      const outcome = await promptOutcome(lane.transcript, lane.busy.promptId);
      if (outcome.interrupted) {
        const task = mine.find((entry) => entry.prompt_id === lane.busy.promptId && entry.status === 'running');
        if (task) fail(task, '任务在窗口里被中断了', outcome.text || null);
        lane.busy = null;
      }
    }
    if (lane.agent === 'agy' && lane.busy.taskId) {
      const task = mine.find((entry) => entry.id === lane.busy.taskId);
      if (task?.status === 'sending' && (await agyOutcome(lane.transcript, task.id)).seen) {
        Object.assign(task, { status: 'running', prompt_id: `agy:${task.id}`, started_at: new Date(this.now()).toISOString() });
        // Taken: the window is busy with this turn, no longer with a paste.
        lane.busy = { promptId: `agy:${task.id}`, taskId: task.id };
        changed = true;
      }
      const screen = await this.screen(share, lane).catch(() => '');
      const at = screen.lastIndexOf(marker(lane.busy.taskId));
      if (at >= 0 && AGENTS.agy.interrupted.test(screen.slice(at))) {
        if (task?.status === 'running') fail(task, '任务在窗口里被中断了');
        lane.busy = null;
      }
    }
    return changed;
  }

  async screen(share, lane) {
    const { text = '' } = await this.client(share.source_id).call('surface.read_text', { workspace_id: share.workspace_id, surface_id: lane.surfaceId });
    return String(text);
  }

  /** Deletes the folders of tasks that ended more than the share's keep days ago. Only tasks/<task id> folders, never links. */
  async clean(share, state) {
    const days = Number.isFinite(share.task_keep_days) ? share.task_keep_days : TASK_KEEP_DAYS;
    if (!(days > 0)) return false;
    const root = join(share.directory, 'tasks');
    let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch { return false; }
    const cutoff = this.now() - days * 86_400_000;
    let changed = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
      const record = state.tasks.find((task) => task.id === entry.name);
      if (record && !FINAL.has(record.status)) continue;
      const ended = Date.parse(record?.finished_at ?? record?.created_at ?? '') || (await stat(join(root, entry.name)).catch(() => null))?.mtimeMs;
      if (!ended || ended > cutoff) continue;
      await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => {});
      if (record) { Object.assign(record, { files: [], files_removed_at: new Date(this.now()).toISOString() }); changed = true; }
    }
    return changed;
  }

  /** Applies one hook event to a lane and its tasks. */
  apply(mine, lane, event) {
    if (event.transcript) lane.transcript = event.transcript;
    if (event.sessionId) lane.sessionId = event.sessionId;
    const now = new Date(this.now()).toISOString();
    const start = (task, promptId) => Object.assign(task, { status: 'running', prompt_id: promptId, started_at: now, error: null, finished_at: null });
    const markedTask = (prompt, statuses) => {
      const id = TASK_MARK.exec(typeof prompt === 'string' ? prompt.slice(0, 400) : '')?.[0]?.slice(4, -1);
      return id ? mine.find((entry) => entry.id === id && statuses.includes(entry.status)) : null;
    };
    if (event.name === 'SessionStart') {
      Object.assign(lane, { ready: true, busy: null, endedAt: null, dirty: false, clearing: null });
      // agy's only report of a session's first prompt.
      if (event.agy && event.prompt) {
        const task = markedTask(event.prompt, ['sending']);
        lane.busy = { promptId: `agy:${task?.id ?? event.sessionId}`, taskId: task?.id ?? null };
        lane.dirty = true;
        if (task) { start(task, `agy:${task.id}`); return true; }
      }
      return false;
    }
    // /clear ends one session and starts the next right away.
    if (event.name === 'SessionEnd') { Object.assign(lane, { ready: false, busy: null, endedAt: event.reason === 'clear' ? null : this.now() }); return false; }
    if (event.name === 'UserPromptSubmit') {
      Object.assign(lane, { busy: { promptId: event.promptId }, dirty: true });
      // A failed task whose paste was taken late still counts. The first prompt after a paste is the task's even if its text was shortened.
      const task = markedTask(event.prompt, ['sending']) ?? mine.find((entry) => entry.status === 'failed' && entry.prompt_id == null && entry.sent_at && event.prompt?.includes(marker(entry.id)))
        ?? (!TASK_MARK.test(event.prompt ?? '') ? mine.find((entry) => entry.status === 'sending') : undefined);
      if (!task) return false;
      lane.busy.taskId = task.id;
      start(task, event.promptId);
      return true;
    }
    if (event.name === 'Interrupt') {
      lane.busy = null;
      const task = mine.find((entry) => entry.status === 'running' && (!event.promptId || entry.prompt_id === event.promptId));
      if (!task) return false;
      Object.assign(task, { status: 'failed', error: '任务在窗口里被中断了', finished_at: now });
      return true;
    }
    if (event.name === 'Stop') {
      if (!event.idle) return false;
      let task;
      if (event.agy) {
        task = markedTask(event.prompt, ['running', 'sending']);
        lane.busy = null;
      } else {
        if (!lane.busy || !event.promptId || lane.busy.promptId === event.promptId) lane.busy = null;
        task = event.promptId ? mine.find((entry) => entry.prompt_id === event.promptId && entry.status === 'running') : null;
      }
      if (!task) return false;
      Object.assign(task, { status: 'done', result: event.message ?? '', finished_at: now, finishing: true });
      return true;
    }
    return false;
  }

  /** Sends the next task when the agent's window is idle, opening the window first when there is none. */
  async dispatch(share, mine, lane, task) {
    let changed = false;
    if (lane.busy) return changed;
    const agent = lane.agent, profile = AGENTS[agent];
    const client = this.client(share.source_id);
    let live = Boolean(lane.surfaceId);
    if (lane.surfaceId && (this.now() - lane.liveAt > 5000 || !lane.ready)) {
      lane.liveAt = this.now();
      try {
        const { surfaces = [] } = await client.call('surface.list', { workspace_id: share.workspace_id });
        live = surfaces.some((surface) => surface.id === lane.surfaceId);
      } catch { live = false; }
      lane.live = live;
    } else if (lane.surfaceId) live = lane.live ?? true;
    const exited = !lane.ready && lane.endedAt !== null && this.now() - lane.endedAt > 5000;
    if (!live || exited) {
      // No window yet, or it was closed, or its agent exited: start the agent in a new terminal.
      if (lane.starting) return changed;
      lane.starting = this.openLane(share, agent).finally(() => { lane.starting = null; lane.liveAt = 0; });
      await lane.starting.catch((error) => {
        Object.assign(task, { status: 'failed', error: `${profile.label} 任务窗口没能打开：${error.message}`, finished_at: new Date(this.now()).toISOString() });
        changed = true;
      });
      return true;
    }
    if (!lane.ready && profile.lazy && profile.idle(await this.screen(share, lane).catch(() => ''))) lane.ready = true;
    if (!lane.ready) {
      lane.startedWaiting ??= this.now();
      // A terminal without hooks (opened before tasks were on) never reports ready.
      if (this.now() - lane.startedWaiting > START_TIMEOUT_MS && !task.waiting) {
        task.waiting = `等任务窗口里的 ${profile.label} 启动（如果窗口在问「信任这个文件夹」，请在电脑上确认）`;
        changed = true;
      }
      return changed;
    }
    delete task.waiting;
    const target = { workspace_id: share.workspace_id, surface_id: lane.surfaceId };
    if (!task.continue && lane.dirty) return await this.clear(share, task, lane, client, target) || changed;
    await client.call('terminal.paste', { ...target, text: taskPrompt(task) });
    Object.assign(task, { status: 'sending', sent_at: new Date(this.now()).toISOString(), surface_id: lane.surfaceId, enters: 1 });
    if (this.settleMs) await sleep(this.settleMs);
    await client.call('surface.send_key', { ...target, key: 'enter' }).catch(() => {});
    // The agent takes it as a new turn; until it says so the window counts as busy.
    Object.assign(lane, { busy: { promptId: null, pasted: true, taskId: task.id }, dirty: true });
    return true;
  }

  /** Types the agent's clear command before a task that starts fresh; the task goes in once the conversation is empty. */
  async clear(share, task, lane, client, target) {
    const profile = AGENTS[lane.agent];
    const clearing = lane.clearing ??= { since: this.now(), at: null, enters: 0, typed: 0, refusals: 0 };
    const screen = profile.lazy ? await this.screen(share, lane).catch(() => '') : '';
    if (clearing.at === null) {
      if (!profile.busy?.test(screen)) {
        await client.call('surface.send_text', { ...target, text: profile.clear });
        Object.assign(clearing, { at: this.now(), enters: 1, typed: clearing.typed + 1, refusals: occurrences(profile.refused, screen) });
        if (this.settleMs) await sleep(this.settleMs);
        await client.call('surface.send_key', { ...target, key: 'enter' }).catch(() => {});
        return false;
      }
    } else {
      const waited = this.now() - clearing.at;
      // Codex and agy report nothing for a clear: their screen shows it done, no task mark left above an idle prompt.
      if (profile.lazy && waited >= this.clearSettleMs) {
        if (profile.idle(screen) && !TASK_MARK.test(screen)) { Object.assign(lane, { dirty: false, clearing: null }); return false; }
        // Dropped while the turn was still ending: typed again once the screen is idle.
        if (occurrences(profile.refused, screen) > clearing.refusals && clearing.typed < CLEAR_TYPED_MAX) { clearing.at = null; return false; }
      }
      if (waited > CLEAR_RETRY_MS && clearing.enters < 2) {
        clearing.enters++;
        await client.call('surface.send_key', { ...target, key: 'enter' }).catch(() => {});
      }
    }
    if (this.now() - clearing.since <= CLEAR_TIMEOUT_MS) return false;
    lane.clearing = null;
    Object.assign(task, { status: 'failed', error: '清空上一段对话没有成功（窗口可能在等你确认什么），请看一下窗口', finished_at: new Date(this.now()).toISOString() });
    return true;
  }

  /** Opens an agent's task window: Claude's as the share's first terminal, the others beside it in the same workspace. */
  async openLane(share, agent) {
    if (agent === 'claude') return this.reopen(share);
    const command = await this.laneCommand(agent, share);
    const client = this.client(share.source_id);
    const create = () => client.call('surface.create', { workspace_id: share.workspace_id, type: 'terminal', cwd: share.directory, initial_command: command, focus: false });
    let created;
    try { created = await create(); }
    catch {
      // The workspace is gone: Claude's window opens a new one first.
      await this.reopen(share);
      created = await create();
    }
    const surfaceId = created?.surface_id ?? created?.id;
    if (typeof surfaceId !== 'string' || !surfaceId) throw new Error('电脑没有返回新终端');
    const at = new Date(this.now()).toISOString();
    await this.shares.update(share.id, (entry) => {
      entry.task_windows = { ...entry.task_windows, [agent]: { surface_id: surfaceId, created_at: at } };
      entry.terminals = [...shareTerminals(entry).filter((terminal) => terminal.surface_id !== share.task_windows?.[agent]?.surface_id),
        { surface_id: surfaceId, session_id: null, agent, created_at: at }];
    });
    share.task_windows = { ...share.task_windows, [agent]: { surface_id: surfaceId, created_at: at } };
  }

  /** A new terminal in the share's workspace (or a new workspace when that is gone) becomes Claude's task window. */
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
      const moved = entry.workspace_id !== workspaceId;
      const kept = moved ? [] : shareTerminals(entry).filter((terminal) => terminal.surface_id !== entry.surface_id);
      Object.assign(entry, { workspace_id: workspaceId, surface_id: surfaceId, session_id: sessionId,
        terminals: [{ surface_id: surfaceId, session_id: sessionId, created_at: new Date(this.now()).toISOString() }, ...kept] });
      // Other agents' windows went with the old workspace.
      if (moved) delete entry.task_windows;
    });
    if (workspaceId !== share.workspace_id) delete share.task_windows;
    Object.assign(share, { workspace_id: workspaceId, surface_id: surfaceId, session_id: sessionId });
  }
}
