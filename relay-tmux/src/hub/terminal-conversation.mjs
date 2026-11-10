import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { RpcError } from '../tmux.mjs';

const WINDOW = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clipped = (value, limit = 16000) => typeof value === 'string' ? value.slice(0, limit) : '';
const blocks = value => Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'text', text: value }] : [];
const body = value => clipped(blocks(value).filter(p => ['text', 'input_text', 'output_text'].includes(String(p?.type).toLowerCase())).map(p => clipped(p.text)).join('\n'));
const safeUser = text => !/^\s*(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<system-reminder>|<local-command-caveat>)/.test(text);
const display = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const command = value => Array.isArray(value) ? value.length >= 3 && ['-lc', '-c'].includes(value[1]) ? clipped(value.slice(2).join(' '), 2000) : clipped(value.join(' '), 2000) : clipped(value, 2000);
const state = value => /fail|error|denied/i.test(value ?? '') ? 'failed' : /progress|running/i.test(value ?? '') ? 'inProgress' : 'completed';

function question(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions)) return '';
  return questions.map(q => [q.question, ...(q.options ?? []).map(o => `${o.label}${o.description ? `：${o.description}` : ''}`)].filter(Boolean).join('\n')).join('\n\n');
}

/** Only public messages and tool details leave the host; reasoning/auth records are ignored. */
export function parseConversation(records, provider, sessionId, options = {}) {
  const result = new Map();
  let branch = [], parent = null;
  let active = false, knownActivity = false;
  const put = (id, type, fields, record, block = 0) => {
    if (!id) return;
    const sequence = record.offset * 1000 + block;
    const previous = result.get(id);
    result.set(id, { ...previous, id, type, ...fields, sequence: Math.min(previous?.sequence ?? sequence, sequence),
      updatedSequence: sequence, timestamp: Date.parse(record.value.timestamp ?? '') || 0 });
  };
  if (provider === 'codex') {
    const canonical = records.some(r => r.value.type === 'event_msg' && r.value.payload?.type === 'item_completed');
    const eventUsers = records.some(r => r.value.type === 'event_msg' && r.value.payload?.type === 'user_message');
    for (const record of records) {
      const r = record.value, p = r.payload ?? {};
      if (p.thread_id && p.thread_id !== sessionId) continue;
      if (r.type === 'event_msg' && p.type === 'task_started') { active = true; knownActivity = true; }
      if (r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)) { active = false; knownActivity = true; }
      if (r.type === 'event_msg' && p.type === 'item_completed') {
        if (!knownActivity) active = true;
        const item = p.item ?? {}, type = String(item.type).toLowerCase();
        const id = `${p.turn_id ?? 'turn'}:${typeof item.id === 'string' ? item.id : record.offset}`;
        if (type === 'usermessage') {
          const text = body(item.content); if (text && safeUser(text)) put(id, 'userMessage', { content: [{ type: 'text', text }] }, record);
        } else if (type === 'agentmessage' && item.phase !== 'analysis') {
          const text = body(item.content); if (text) put(id, 'agentMessage', { text }, record);
          if (item.phase === 'final') active = false;
        } else if (type === 'commandexecution') put(id, 'commandExecution', { command: command(item.command), aggregatedOutput: clipped(item.aggregated_output, 6000), status: item.exit_code ? 'failed' : state(item.status) }, record);
        else if (type === 'filechange') put(id, 'fileChange', { status: state(item.status), changes: Object.entries(item.changes ?? {}).slice(0, 20).map(([path, change]) => ({ path: clipped(path, 500), diff: clipped(change?.unified_diff, 2000) })) }, record);
        else if (/tool|websearch|collab|imagegeneration/.test(type) && type !== 'reasoning') put(id, 'toolExecution', { tool: clipped(item.tool ?? item.name ?? item.type, 100), text: clipped(display(item.output ?? item.result), 4000), status: state(item.status) }, record);
      }
      if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && p.name === 'request_user_input') {
        let input; try { input = JSON.parse(p.arguments ?? p.input); } catch {}
        const text = question(input); if (text) put(`${p.call_id}:question`, 'agentMessage', { text }, record);
      }
      if (canonical) continue;
      if (r.type === 'event_msg' && p.type === 'user_message') {
        const text = clipped(p.message); if (text && safeUser(text)) put(`user:${record.offset}`, 'userMessage', { content: [{ type: 'text', text }] }, record);
      } else if (r.type === 'response_item' && p.type === 'message') {
        const text = body(p.content), id = p.id ?? `message:${record.offset}`;
        if (p.role === 'assistant' && p.channel !== 'analysis' && text) put(id, 'agentMessage', { text }, record);
        else if (p.role === 'user' && !eventUsers && text && safeUser(text)) put(id, 'userMessage', { content: [{ type: 'text', text }] }, record);
      } else if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && p.name !== 'request_user_input') {
        let input; try { input = JSON.parse(p.arguments ?? p.input); } catch { input = {}; }
        put(p.call_id ?? p.id, /exec|shell/.test(p.name) ? 'commandExecution' : 'toolExecution', {
          command: command(input.cmd ?? input.command), tool: clipped(p.name, 100), text: clipped(display(input), 2000), status: 'inProgress',
        }, record);
      } else if (r.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const id = p.call_id, old = result.get(id);
        put(id, old?.type ?? 'toolExecution', { aggregatedOutput: clipped(display(p.output), 6000), text: clipped(display(p.output), 6000), status: /(?:exited with code|exit_code["\s:]+)[1-9]/i.test(display(p.output)) ? 'failed' : 'completed' }, record);
      }
    }
  } else {
    // Claude stores branches in one file. Follow only the current main leaf.
    records = records.filter(r => !r.value.sessionId || r.value.sessionId === sessionId);
    const byUuid = new Map(records.filter(r => r.value.uuid).map(r => [r.value.uuid, r]));
    let leaf = records.findLast(r => ['user', 'assistant'].includes(r.value.type) && !r.value.isSidechain);
    const marker = records.findLast(r => r.value.type === 'last-prompt' && r.value.leafUuid);
    const requestedLeaf = options.leaf ?? (marker && marker.offset > (leaf?.offset ?? -1) ? marker.value.leafUuid : null);
    if (requestedLeaf) leaf = byUuid.get(requestedLeaf);
    const chain = new Set(); let cursor = leaf;
    parent = requestedLeaf ?? null;
    while (cursor && !chain.has(cursor.value.uuid)) { chain.add(cursor.value.uuid); parent = cursor.value.parentUuid ?? null; cursor = byUuid.get(parent); }
    branch = records.filter(r => chain.has(r.value.uuid)).map(r => ({ offset: r.offset, uuid: r.value.uuid }));
    const visible = records.filter(r => !r.value.isSidechain && chain.has(r.value.uuid));
    for (const record of visible) {
      const r = record.value, message = r.message ?? {};
      if (!['user', 'assistant'].includes(r.type)) continue;
      const content = blocks(message.content);
      for (let i = 0; i < Math.min(content.length, 128); i++) {
        const b = content[i], id = `${r.uuid}:${i}`;
        if (b.type === 'text' && r.type === 'user' && !r.isMeta) {
          const text = clipped(b.text); if (text && safeUser(text)) put(id, 'userMessage', { content: [{ type: 'text', text }] }, record, i);
        } else if (b.type === 'text' && r.type === 'assistant' && b.text) put(id, 'agentMessage', { text: clipped(b.text) }, record, i);
        else if (b.type === 'image' && r.type === 'user') put(id, 'userMessage', { content: [{ type: 'text', text: '[图片]' }] }, record, i);
        else if (b.type === 'tool_use') {
          const text = b.name === 'AskUserQuestion' ? question(b.input) : '';
          if (text) put(`${b.id}:question`, 'agentMessage', { text }, record, i);
          const type = b.name === 'Bash' ? 'commandExecution' : ['Edit', 'Write', 'MultiEdit'].includes(b.name) ? 'fileChange' : 'toolExecution';
          put(b.id, type, { command: type === 'toolExecution' ? clipped(display(b.input), 2000) : command(b.input?.command), tool: clipped(b.name, 100), text: clipped(display(b.input), 2000), status: 'inProgress',
            ...(type === 'fileChange' ? { changes: [{ path: clipped(b.input?.file_path, 500), diff: clipped([b.input?.old_string, b.input?.new_string ?? b.input?.content].filter(Boolean).join('\n'), 2000) }] } : {}) }, record, i);
          active = true;
        } else if (b.type === 'tool_result') {
          const old = result.get(b.tool_use_id), output = typeof b.content === 'string' ? b.content : body(b.content);
          put(b.tool_use_id, old?.type ?? 'toolExecution', { aggregatedOutput: clipped(output, 6000), text: clipped(output, 6000), status: b.is_error ? 'failed' : 'completed' }, record, i);
        }
      }
      // Claude stores compaction context as a user record even while idle.
      // Only an actual user turn can start work; metadata and summaries cannot.
      if (r.type === 'user' && !r.isMeta && !r.isCompactSummary && content.some(c => c.type === 'text')) active = true;
      if (r.type === 'assistant' && (message.stop_reason === 'end_turn' || (content.some(c => c.type === 'text') && !content.some(c => c.type === 'tool_use')))) active = false;
    }
  }
  return { items: [...result.values()].sort((a, b) => a.sequence - b.sequence), active, branch, parent };
}

export class TerminalConversationReader {
  constructor(options = {}) { this.home = options.home ?? homedir(); this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.home, '.codex'); this.claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(this.home, '.claude'); this.files = new Map(); this.heads = new Map(); }
  async find(provider, id) {
    const key = `${provider}:${id}`, cached = this.files.get(key);
    if (cached) { try { if ((await lstat(cached.path)).isFile() && (await realpath(cached.path)).startsWith(cached.root + sep)) return cached.path; } catch {} this.files.delete(key); }
    const roots = provider === 'codex' ? [join(this.codexHome, 'sessions'), join(this.codexHome, 'archived_sessions')] : [join(this.claudeHome, 'projects')];
    for (const configured of roots) {
      let root; try { root = await realpath(configured); } catch { continue; }
      const queue = [root], found = []; let visited = 0;
      while (queue.length && visited < 100000) {
        const directory = queue.shift(); let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          visited++; const path = join(directory, entry.name);
          if (entry.isDirectory()) queue.push(path);
          else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) {
            const actual = await realpath(path); if (actual.startsWith(root + sep)) found.push(actual);
          }
        }
      }
      if (found.length > 1) throw new RpcError('conversation_ambiguous', '这段对话有多份记录，请先使用终端视图');
      if (found.length) { this.files.set(key, { path: found[0], root }); return found[0]; }
    }
    return null;
  }
  async read(binding, params = {}) {
    const provider = binding?.kind, id = binding?.checkpoint_id;
    if (!['codex', 'claude'].includes(provider) || !UUID.test(id ?? '')) return { available: false, provider: 'terminal', conversation_id: null, items: [], next_cursor: null };
    const base = { provider, conversation_id: id, name: provider === 'codex' ? 'Codex' : 'Claude Code' };
    const location = typeof binding.execution_location === 'string' ? binding.execution_location : binding.execution_location?.kind;
    if (binding.remote_surface_id || binding.remote_pty_session_id || (location && location !== 'local')) return { ...base, available: false, items: [], next_cursor: null };
    const file = await this.find(provider, id);
    if (!file) return { ...base, available: false, items: [], next_cursor: null };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(), epoch = `${info.dev}:${info.ino}:${info.birthtimeMs}`, fileRevision = `${id}:${epoch}:${info.size}:${info.mtimeMs}`;
      const limit = Math.max(20, Math.min(150, Number.isInteger(params.limit) ? params.limit : 80)), cacheKey = `${provider}:${id}:${limit}`;
      const reply = entry => {
        let previous;
        if (typeof params.branch === 'string' && params.branch.length <= 4096) { try { previous = JSON.parse(Buffer.from(params.branch, 'base64url').toString('utf8')); } catch {} }
        const reset = Boolean(previous && (previous.id !== id || previous.epoch !== epoch || (previous.offset >= entry.start && !entry.ancestors.has(previous.uuid))));
        const value = entry.value;
        return !params.cursor && params.revision === value.revision && !reset
          ? { ...base, available: true, generation: value.generation, revision: value.revision, active: value.active, branch: value.branch, unchanged: true, head_sequence: info.size * 1000 }
          : { ...value, ...(reset ? { reset: true } : {}) };
      };
      const cached = this.heads.get(cacheKey);
      if (!params.cursor && cached?.fileRevision === fileRevision) return reply(cached);
      // Validate the file's own identity, not just its filename.
      let first = Buffer.alloc(Math.min(info.size, 65536)); await handle.read(first, 0, first.length, 0);
      if (first.indexOf(10) < 0 && first.length < info.size) { first = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024)); await handle.read(first, 0, first.length, 0); }
      const head = first.toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const identity = head.find(r => provider === 'codex' ? r.type === 'session_meta' : r.sessionId);
      const actualId = provider === 'codex' ? identity?.payload?.id ?? identity?.payload?.session_id : identity?.sessionId;
      if (actualId !== id) throw new RpcError('conversation_identity', '对话记录与当前终端不一致，请刷新后重试');
      const generation = createHash('sha256').update(epoch).digest('hex').slice(0, 16);
      let before = info.size, leaf;
      if (params.cursor) {
        if (typeof params.cursor !== 'string' || params.cursor.length > 4096) throw new RpcError('invalid_params', '历史位置无效');
        let value; try { value = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch {}
        if (value?.id !== id || value?.epoch !== epoch || !Number.isSafeInteger(value?.before) || value.before <= 0 || value.before > info.size) throw new RpcError('cursor_expired', '对话历史已更新，请刷新后重试');
        if (value.leaf && (typeof value.leaf !== 'string' || value.leaf.length > 200)) throw new RpcError('invalid_params', '历史位置无效');
        before = value.before;
        leaf = value.leaf;
      }
      let start = Math.max(0, before - WINDOW), records = [];
      for (let tries = 0; tries < 4; tries++) {
        const readStart = start ? start - 1 : 0;
        const buffer = Buffer.alloc(before - readStart); await handle.read(buffer, 0, buffer.length, readStart);
        const firstNewline = buffer.indexOf(10);
        let index = start ? firstNewline < 0 ? buffer.length : firstNewline + 1 : 0;
        while (index < buffer.length) {
          const end = buffer.indexOf(10, index); if (end < 0) break;
          try { records.push({ offset: readStart + index, value: JSON.parse(buffer.toString('utf8', index, end)) }); } catch {}
          index = end + 1;
          if (records.length % 64 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        if (records.length || !start) break;
        before = start; start = Math.max(0, before - WINDOW);
      }
      const parsed = parseConversation(records, provider, id, { leaf });
      const ordered = [...parsed.items].sort((a, b) => a.updatedSequence - b.updatedSequence);
      const cutoff = ordered.length > limit ? Math.floor(ordered[ordered.length - limit].updatedSequence / 1000) : records[0]?.offset ?? start;
      const items = parsed.items.filter(item => Math.floor(item.updatedSequence / 1000) >= cutoff);
      const ancestor = parsed.branch.findLast(record => record.offset < cutoff)?.uuid ?? parsed.parent;
      const next = cutoff > 0 ? Buffer.from(JSON.stringify({ id, epoch, before: cutoff, ...(provider === 'claude' && ancestor ? { leaf: ancestor } : {}) })).toString('base64url') : null;
      const revision = createHash('sha256').update(JSON.stringify([id, generation, parsed.active, items])).digest('hex').slice(0, 24);
      const latest = parsed.branch.at(-1);
      const branch = latest ? Buffer.from(JSON.stringify({ id, epoch, uuid: latest.uuid, offset: latest.offset })).toString('base64url') : null;
      const value = { ...base, available: true, generation, revision, active: parsed.active, branch, head_sequence: info.size * 1000, items, next_cursor: next };
      const entry = { fileRevision, value, start: records[0]?.offset ?? start, ancestors: new Set(parsed.branch.map(record => record.uuid)) };
      if (!params.cursor) {
        this.heads.delete(cacheKey); this.heads.set(cacheKey, entry);
        while (this.heads.size > 8) this.heads.delete(this.heads.keys().next().value);
      }
      return reply(entry);
    } finally { await handle.close(); }
  }
}

export function localConversationSource(url) {
  const endpoint = new URL(url);
  return ['ws:', 'wss:'].includes(endpoint.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
}
