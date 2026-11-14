import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath, access, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TerminalGateway, decisionPrompt, terminalCode } from '../weixin/terminal.mjs';
import { acquireLock, savePrivate, readPrivate } from '../weixin/storage.mjs';
import { TerminalConversationReader, localConversationSource } from './terminal-conversation.mjs';
import { scoped, unscoped } from './ids.mjs';
import { serveSupervisor, callSupervisor } from '../../supervisor/ipc.mjs';

const exec = promisify(execFile);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
export const supervisorDirectory = config => join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'supervisor');

export class SupervisorGateway extends TerminalGateway {
  constructor(registry, config) { super(registry, config); this.readers = new Map(); }
  ownedKey(target) { return JSON.stringify([target.sourceId, target.workspace_id, target.surface_id]); }
  async ownedSessions() { return await readPrivate(join(supervisorDirectory(this.session.config), 'owned-sessions.json')) ?? {}; }
  async registerOwned(target, spec, specPath) {
    const sessions = await this.ownedSessions();
    const ownedSession = { sessionId: spec.sessionId, provider: 'claude', role: spec.role, cwd: spec.cwd, processFile: specPath + '.process.json' };
    sessions[this.ownedKey(target)] = ownedSession;
    await savePrivate(join(supervisorDirectory(this.session.config), 'owned-sessions.json'), sessions);
    return { ...target, ownedSession, cwd: spec.cwd, provider: 'claude' };
  }
  async agentAlive(target, provider) {
    if (target.ownedSession) {
      try {
        const processInfo = await readPrivate(target.ownedSession.processFile);
        if (processInfo?.sessionId !== target.ownedSession.sessionId || !Number.isSafeInteger(processInfo.pid)) return false;
        const { stdout } = await exec('/bin/ps', ['-p', String(processInfo.pid), '-o', 'command=']);
        return stdout.includes(target.ownedSession.sessionId) && /(?:^|\/)claude(?:\s|$)/.test(stdout);
      } catch { return false; }
    }
    const surface = unscoped(target.surface_id).id.toLowerCase(), workspace = unscoped(target.workspace_id).id.toLowerCase();
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm='], { maxBuffer: 4 * 1024 * 1024 });
    const candidates = stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match && new RegExp(`(?:^|/)${provider}(?:$|\\s)`).test(match[2]) ? [match[1]] : [];
    });
    for (const pid of candidates) {
      // Never log or persist this output: it may contain environment credentials.
      const result = await exec('/bin/ps', ['eww', '-p', pid, '-o', 'command='], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' }));
      const env = name => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(result.stdout)?.[1]?.toLowerCase();
      if (env('CMUX_SURFACE_ID') === surface && env('CMUX_WORKSPACE_ID') === workspace) return true;
    }
    return false;
  }
  async input(target, text, snapshot, signal) {
    if (!['claude', 'codex'].includes(snapshot.provider) || !await this.agentAlive(target, snapshot.provider)) {
      const error = new Error('原编码执行者已退出或无法确认，未向 shell 发送指令。'); error.notSent = true; throw error;
    }
    return super.input(target, text, snapshot, signal);
  }
  async key(target, key) {
    const page = await this.snapshot(target);
    if (!['claude', 'codex'].includes(page.provider) || !await this.agentAlive(target, page.provider)) throw new Error('原编码执行者已退出，未发送按键。');
    return super.key(target, key);
  }
  async list() {
    const result = await super.list();
    const owned = await this.ownedSessions();
    for (const target of result.targets) {
      if (this.closed) break;
      try {
        const source = this.registry.get(target.sourceId);
        if (!localConversationSource(source.config.url)) continue;
        const known = owned[this.ownedKey(target)];
        if (known && (!target.resume?.checkpoint_id || target.resume.checkpoint_id === known.sessionId)) {
          target.ownedSession = known; target.cwd = known.cwd; target.provider = known.provider; continue;
        }
        const binding = target.resume;
        const location = typeof binding?.execution_location === 'string' ? binding.execution_location : binding?.execution_location?.kind;
        if (location && location !== 'local') continue;
        if (binding?.remote_surface_id || binding?.remote_pty_session_id) continue;
        if (binding?.cwd) target.cwd = await realpath(binding.cwd);
        target.provider = binding?.kind;
      } catch { /* An ordinary or remote shell stays visible without claiming a local project. */ }
    }
    return result;
  }
  reader(source) {
    const key = JSON.stringify([source.config.codex_home, source.config.claude_home]);
    if (!this.readers.has(key)) this.readers.set(key, new TerminalConversationReader({ codexHome: source.config.codex_home, claudeHome: source.config.claude_home }));
    return this.readers.get(key);
  }
  async snapshot(target) {
    const surface = await this.validate(target), source = this.registry.get(target.sourceId);
    if (!localConversationSource(source.config.url)) return { available: false, provider: 'terminal', conversation_id: null, items: [] };
    const known = (await this.ownedSessions())[this.ownedKey(target)];
    const binding = surface.resume_binding ?? (known ? { kind: known.provider, checkpoint_id: known.sessionId, execution_location: 'local' } : null);
    const page = await this.reader(source).read(binding, { limit: 150 });
    source.weixinPasteCapability ??= this.session.client(source.config.id).call('system.capabilities', {}).then(r => (r.methods ?? []).includes('terminal.paste')).catch(() => false);
    if (await source.weixinPasteCapability) page.input_method = 'terminal.paste';
    return page;
  }
  async question(target) { return decisionPrompt(await this.screen(target)); }
  async focus(target) { await this.validate(target); await this.session.dispatch('workspace.select', { workspace_id: target.workspace_id }); }
  async startupStatus(manager) {
    const screen = await this.screen(manager.target);
    if (/Yes, I trust this folder|trust this (?:folder|project)|Select login method|sign in to Claude/i.test(screen)) return '请在 cmux「监工」工作区完成 Claude 的首次信任或登录确认。窗口会保留，确认后自动继续。';
    return null;
  }
  async managerSnapshot(manager) {
    await this.validate(manager.target);
    const source = this.registry.get(manager.target.sourceId);
    if (!localConversationSource(source.config.url)) throw new Error('监工需要运行在本机 cmux。');
    const page = await this.reader(source).read({ kind: 'claude', checkpoint_id: manager.sessionId, execution_location: 'local' }, { limit: 150 });
    source.weixinPasteCapability ??= this.session.client(source.config.id).call('system.capabilities', {}).then(r => (r.methods ?? []).includes('terminal.paste')).catch(() => false);
    if (await source.weixinPasteCapability) page.input_method = 'terminal.paste';
    return page;
  }
  async createWorkspace(sourceId, title, cwd, command, focus = false) {
    const source = this.registry.get(sourceId);
    if (source.config.type !== 'cmux' || source.config.access !== 'control' || !localConversationSource(source.config.url)) throw new Error('需要可操作的本机 cmux 来源。');
    try { await this.session.client(sourceId).call('workspace.list', {}); }
    catch (error) { error.notSent = true; throw error; }
    const result = await this.session.dispatch('workspace.create', { source_id: sourceId, title, cwd, initial_command: command, focus });
    const workspace_id = result.workspace_id ?? result.workspace?.id;
    if (!workspace_id) throw new Error('创建工作区的回执无效');
    let surface_id = result.surface_id;
    if (!surface_id) surface_id = (await this.session.dispatch('surface.list', { workspace_id })).surfaces?.find(s => s.type === 'terminal')?.id;
    if (!surface_id) throw new Error('工作区已创建，但没有确认执行终端');
    if (focus) await this.session.dispatch('workspace.select', { workspace_id });
    const target = { sourceId, workspace_id, surface_id, title, access: 'control', cwd };
    return { ...target, code: terminalCode(target) };
  }
}

export class SupervisorLauncher {
  constructor(directory, gateway, registry) { Object.assign(this, { directory, gateway, registry }); }
  async binary() {
    const path = process.env.PANECAST_CLAUDE_BIN || (await exec('/usr/bin/which', ['claude'], { env: { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':') } })).stdout.trim();
    await access(path, constants.X_OK); return path;
  }
  async launch(spec, sourceId) {
    const directory = join(this.directory, 'agents', spec.id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'launch.json'); let binary;
    try { binary = await this.binary(); } catch (error) { error.notSent = true; throw error; }
    const identityFile = join(directory, 'identity.json'), mcpConfig = join(directory, 'mcp.json');
    if (spec.role === 'manager') {
      await savePrivate(identityFile, { id: spec.id, connectionFile: join(this.directory, 'connection.json') });
      await savePrivate(mcpConfig, { mcpServers: { panecast_supervisor: { command: process.execPath, args: [fileURLToPath(new URL('../../supervisor/mcp.mjs', import.meta.url)), identityFile] } } });
    }
    await savePrivate(path, { ...spec, binary, mcpConfig });
    const command = ['exec', quote(process.execPath), quote(fileURLToPath(new URL('../../supervisor/launch.mjs', import.meta.url))), quote(path)].join(' ');
    const target = await this.gateway.createWorkspace(sourceId, spec.title, spec.cwd, command, spec.role === 'manager');
    return this.gateway.registerOwned(target, spec, path);
  }
  async manager(manager) {
    const source = [...this.registry.sources.values()].find(s => s.config.type === 'cmux' && s.config.enabled && s.config.access === 'control' && localConversationSource(s.config.url));
    if (!source) throw new Error('请先连接一个可操作的本机 cmux 来源。');
    const cwd = join(this.directory, 'workspace'); await mkdir(cwd, { recursive: true, mode: 0o700 });
    return this.launch({ ...manager, cwd, role: 'manager' }, source.config.id);
  }
  async worker(task, projectTarget) { return this.launch({ ...task, title: `任务 · ${task.title}`, cwd: projectTarget.cwd, role: 'worker' }, projectTarget.sourceId); }
}

/** Hosts the independent supervisor module behind an owner-only local socket. */
export class SupervisorRuntime {
  constructor(registry, config, options = {}) { Object.assign(this, { registry, config, options }); this.directory = supervisorDirectory(config); this.closed = false; }
  async start() {
    if (process.platform !== 'darwin' && !this.options.test) return;
    try {
      this.release = await acquireLock(this.directory, 'service');
      const { SupervisorStore } = await import('../../supervisor/store.mjs');
      const { SupervisorController } = await import('../../supervisor/controller.mjs');
      this.store = new SupervisorStore(join(this.directory, 'tasks.sqlite'));
      this.gateway = this.options.gateway ?? new SupervisorGateway(this.registry, this.config);
      this.controller = new SupervisorController({ store: this.store, gateway: this.gateway, launcher: this.options.launcher ?? new SupervisorLauncher(this.directory, this.gateway, this.registry), managerTitle: this.options.title ?? '监工' });
      const key = createHash('sha256').update(this.directory).digest('hex').slice(0, 18), socket = join(tmpdir(), `panecast-supervisor-${key}.sock`);
      try { const info = await lstat(socket); if (!info.isSocket() || info.uid !== process.getuid()) throw new Error('监工 socket 路径被占用'); await unlink(socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const token = randomBytes(32).toString('hex');
      this.stopServer = await serveSupervisor(socket, token, (method, args) => this.controller.serial(() => this.dispatch(method, args)));
      await savePrivate(join(this.directory, 'connection.json'), { socket, token });
      this.timer = setInterval(() => {
        if (!this.ticking && !this.closed) { this.ticking = this.controller.serial(() => this.controller.tick()).catch(() => {}).finally(() => { this.ticking = null; }); }
      }, 2000); this.timer.unref();
    } catch (error) {
      this.lastError = '监工后台未能启动，请检查任务存储和进程锁。';
      await this.close();
    }
  }
  async dispatch(method, args) {
    if (method === 'start') return this.controller.start({ fresh: args.fresh === true });
    if (method === 'status') return this.controller.status();
    if (method === 'ready') return this.controller.connected(args.managerId);
    if (method === 'pause') return this.controller.pause();
    if (method === 'resume') { this.store.setMeta('enabled', true); return this.controller.status(); }
    if (method === 'tool') return this.controller.tool(args.managerId, args.name, args.arguments);
    if (method === 'message') return this.controller.submitUser(args.id ?? randomBytes(12).toString('hex'), args.text, args.audience ?? this.store.meta('audience') ?? '');
    if (method === 'resolve') {
      const op = this.store.operation(args.operationId);
      if (!op || op.state !== 'unknown' || !['received', 'cancelled'].includes(args.state)) throw new Error('请选择未确认的指令，并明确 received 或 cancelled。');
      this.store.saveOperation({ ...op, state: args.state }); return { resolved: true };
    }
    if (method === 'clear-wake') {
      const manager = this.store.meta('manager'); if (manager) this.store.setMeta('manager', { ...manager, wake: null }); return { cleared: true };
    }
    throw new Error('不支持的监工操作');
  }
  enabled() { return this.controller?.enabled() === true; }
  configured() { return Boolean(this.store?.meta('manager')); }
  async pause() { return this.controller.serial(() => this.controller.pause()); }
  async resume() { return this.controller.serial(() => { this.store.setMeta('enabled', true); return { resumed: true }; }); }
  attachAudience(audience) { this.controller?.attachAudience(audience); }
  async message(id, text, audience) { if (!this.controller) throw new Error(this.lastError ?? '监工后台未就绪'); return this.controller.serial(() => this.controller.submitUser(id, text, audience)); }
  outputs(audience, after) { return this.store?.outputs(audience, after) ?? []; }
  status() { return this.controller?.status() ?? { enabled: false, error: this.lastError }; }
  async close() {
    this.closed = true; clearInterval(this.timer); this.gateway?.close(); await this.ticking;
    await this.stopServer?.(); this.stopServer = null;
    await this.controller?.close(); this.store?.close();
    this.store = null; await this.release?.(); this.release = null;
  }
}

export async function supervisorCLI(args, configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), connection = join(supervisorDirectory(config), 'connection.json'), action = args[0] ?? 'status';
  const params = action === 'start' ? { fresh: args.includes('--new') } : action === 'message' ? { text: args.slice(1).filter(v => v !== '--json').join(' ') } : action === 'resolve' ? { operationId: args[1], state: args[2] } : {};
  if (!['start', 'status', 'pause', 'resume', 'message', 'resolve', 'clear-wake'].includes(action)) throw new Error('用法：panecast supervisor start | status | pause | resume | message 文字 | resolve ID received|cancelled');
  const result = await callSupervisor(connection, action, params);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (action === 'start') console.log('已创建或连接 cmux「监工」工作区。首次请在窗口确认 Claude 的信任提示；就绪后，微信文字会自动交给它。');
  else if (action === 'status') {
    console.log(`监工：${result.enabled ? '已启用' : '已暂停'} · ${result.manager?.state ?? '尚未启动'}\n任务：${result.tasks?.length ?? 0} · 待处理请求：${result.pendingRequests ?? 0}`);
    if (result.manager?.lastError) console.log(result.manager.lastError);
    for (const task of result.tasks ?? []) console.log(`${task.id}\t${task.state}\t${task.title}`);
    for (const op of result.unconfirmed ?? []) console.log(`未确认：${op.id}\t${op.title ?? op.taskId ?? op.kind}`);
  } else console.log(result.message ?? '操作已记录。');
}
