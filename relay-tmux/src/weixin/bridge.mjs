import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { notificationSignal } from '../notification-signal.mjs';
import { decisionPrompt } from './terminal.mjs';

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 32);
const HELP = 'Panecast 微信终端\n/list 列出终端\n/use 编号 选择终端\n/status 查看连接与发送状态\n/read 查看最新正文\n/key up、down、enter、escape 操作终端选项\n/stop 停止当前任务\n/unbind 取消终端绑定\n/dismiss 清除未确认的微信回复记录\n\n选择后，普通文字直接发送到该终端。只推送问题和完成结果；工具过程不推送。暂支持本人微信私聊和文字。';
const params = target => ({ workspace_id: target.workspace_id, surface_id: target.surface_id });
const baseline = page => ({ conversation: page.conversation_id ?? null, generation: page.generation ?? '', sequence: Math.max(0, ...(page.items ?? []).map(i => (i.updatedSequence ?? i.sequence ?? 0) + 1)), lastFinal: page.items?.findLast(i => i.type === 'agentMessage' && i.phase === 'final')?.id ?? null });
const identityChanged = (old, page) => old && (old.conversation !== (page.conversation_id ?? null) || old.generation !== (page.generation ?? ''));
const allText = page => (page.items ?? []).filter(i => i.type === 'agentMessage').slice(-3).map(i => i.text).filter(Boolean).join('\n\n');

export function inboundMessage(raw, account) {
  if (raw?.from_user_id !== account.ownerId || raw.message_type !== 1 || (raw.group_id != null && raw.group_id !== '') || (raw.to_user_id && raw.to_user_id !== account.botId)) return null;
  const id = typeof raw.message_id === 'string' ? raw.message_id : Number.isSafeInteger(raw.message_id) ? String(raw.message_id) : null;
  if (!id || id.length > 200 || (raw.message_state !== undefined && raw.message_state !== 2)) return null;
  const items = Array.isArray(raw.item_list) ? raw.item_list : [];
  const text = items.filter(i => i.type === 1 && typeof i.text_item?.text === 'string').map(i => i.text_item.text).join('\n');
  const invalid = items.some(i => i.type !== 1) ? '目前支持文字消息，请输入文字指令。' : text.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? '文字过长或含终端控制字符，请调整后重发。' : null;
  return { id, text: invalid ? '' : text, invalid, status: 'pending', context: typeof raw.context_token === 'string' && raw.context_token.length < 16000 ? raw.context_token : '' };
}

export function messageChunks(value, size = 2000) {
  const chars = [...value.slice(0, 18000)], result = [];
  while (chars.length) {
    let end = Math.min(size, chars.length);
    if (end < chars.length) { const newline = chars.slice(0, end).lastIndexOf('\n'); if (newline > size / 2) end = newline + 1; }
    result.push(chars.splice(0, end).join(''));
  }
  return result;
}

export class WeixinBridge {
  constructor({ account, state, api, terminal, journal, signal, logger = () => {}, onHealthy = () => {} }) {
    Object.assign(this, { account, state, api, terminal, journal, logger, onHealthy });
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.parentSignal = signal; this.abort = () => this.controller.abort();
    if (signal.aborted) this.abort(); else signal.addEventListener('abort', this.abort, { once: true });
    this.operations = Promise.resolve(); this.stopped = false; this.observing = false;
  }
  serial(operation) { const task = this.operations.then(operation); this.operations = task.catch(() => {}); return task; }
  async enqueue(id, text, target = null) {
    if (!text) return;
    await this.state.change(s => {
      if (s.delivered.includes(id) || s.outbox.some(e => e.id === id)) return;
      if (s.outbox.length >= 80) throw new Error('微信回复积压过多，请恢复连接后重试');
      s.outbox.push({ id, target, text, chunks: messageChunks(text), next: 0, status: 'pending' });
    });
  }
  async accept(batch) {
    if (!Array.isArray(batch.msgs) || typeof batch.get_updates_buf !== 'string') throw new Error('微信轮询响应无效');
    await this.state.change(s => {
      for (const raw of batch.msgs) {
        const entry = inboundMessage(raw, this.account);
        if (!entry) continue;
        // Even a redelivered message can refresh the reply context.
        if (entry.context) s.context = entry.context;
        if (s.seen.includes(entry.id) || s.inbox.some(m => m.id === entry.id)) continue;
        if (s.inbox.length >= 100) throw new Error('微信指令积压过多，暂缓读取');
        s.inbox.push(entry);
      }
      s.cursor = batch.get_updates_buf || s.cursor;
    });
    await this.processPending();
  }
  async processPending() {
    if (this.state.value.notice && this.state.value.context) {
      const text = this.state.value.notice;
      await this.enqueue('recovery:' + digest(text), text); await this.state.change(s => { s.notice = null; });
    }
    while (!this.signal.aborted) {
      const entry = this.state.value.inbox.find(e => e.status === 'pending');
      if (!entry) break;
      await this.state.change(s => { s.inbox.find(e => e.id === entry.id).status = 'processing'; });
      let reply;
      try { reply = entry.invalid ?? await this.command(entry.text); }
      catch (error) { reply = error.uncertain ? '发送结果未确认，已停止自动重试。请用 /read 查看终端后再决定是否重发。' : '操作未完成。请用 /status 检查绑定、来源权限和终端状态后重试。'; }
      await this.enqueue('reply:' + entry.id, typeof reply === 'string' ? reply : reply?.text, typeof reply === 'object' ? reply?.target : null);
      await this.state.change(s => { s.inbox = s.inbox.filter(e => e.id !== entry.id); s.seen.push(entry.id); });
    }
  }
  async selected(control = false) {
    const target = this.state.value.target;
    if (!target) throw new Error('尚未选择终端');
    await this.terminal.validate(target, control); return target;
  }
  async command(text) {
    const input = text.trim();
    if (!input || ['/help', '帮助', '/start'].includes(input)) return HELP;
    if (['/list', '终端列表'].includes(input)) {
      const { targets, offline, truncated } = await this.terminal.list();
      await this.state.change(s => { s.catalog = targets; });
      return [targets.length ? '发送 /use 编号 选择终端：' : '没有可用的 cmux 终端，请在电脑上打开终端并授权来源。', ...targets.map(t => `${t.code}  ${t.title}${t.access === 'read' ? '（只读）' : ''}`), offline ? `${offline} 个来源暂时离线。` : '', truncated ? '终端过多，仅列出前 100 个。' : ''].filter(Boolean).join('\n');
    }
    if (input.startsWith('/use ')) {
      const code = input.slice(5).trim(), { targets } = await this.terminal.list();
      const target = targets.find(t => t.code === code);
      if (!target) return '编号无效或终端已关闭，请先发送 /list 获取最新列表。';
      const page = await this.terminal.snapshot(target);
      await this.state.change(s => { s.target = target; s.baseline = baseline(page); s.prompt = null; s.eventCursor = `${this.journal.epoch}:${this.journal.sequence}`; });
      return `已选择：${target.title}\n${page.available ? '发送文字即可继续这个终端的对话。' : '没有结构化对话记录。文字仍直接发送到终端；用 /read 查看画面。'}`;
    }
    if (input === '/unbind') {
      await this.state.change(s => { s.target = null; s.baseline = null; s.prompt = null; s.outbox = s.outbox.filter(e => !e.target); });
      return '已取消终端绑定。发送 /list 可重新选择。';
    }
    if (input === '/status') {
      let target = '尚未选择终端';
      try { target = (await this.selected()).title; } catch { if (this.state.value.target) target = '绑定的终端已关闭、离线或权限已撤销，请 /list 重新选择'; }
      const pending = this.state.value.outbox.filter(e => e.status !== 'pending' || e.next > 0).length;
      return `微信已连接\n当前：${target}\n${pending ? `${pending} 条回复未确认，可用 /read 重新查看结果。` : '没有未确认的回复。'}`;
    }
    if (input === '/dismiss') {
      await this.state.change(s => { const unresolved = s.outbox.filter(e => ['unknown', 'rejected'].includes(e.status)); s.delivered.push(...unresolved.map(e => e.id)); s.outbox = s.outbox.filter(e => !unresolved.includes(e)); });
      return '已清除未确认的微信回复记录。终端指令没有重新执行。';
    }
    if (!this.state.value.target) return '先发送 /list 查看终端，再用 /use 编号 选择。';
    const target = await this.selected();
    if (input === '/read') {
      const page = await this.terminal.snapshot(target);
      return { text: `${target.title}\n\n${page.available ? allText(page) || '暂无正文。' : (await this.terminal.screen(target)) || '暂无终端输出。'}`, target };
    }
    const page = await this.terminal.snapshot(target);
    if (identityChanged(this.state.value.baseline, page)) return '这个终端的会话已变化。请重新发送 /use ' + target.code + ' 后继续。';
    if (input === '/stop' || input.startsWith('/key ')) {
      const key = input === '/stop' ? 'ctrl-c' : input.slice(5).trim();
      if (!['up', 'down', 'left', 'right', 'enter', 'escape', 'tab', 'ctrl-c'].includes(key)) return '支持 /key up、down、left、right、enter、escape、tab、ctrl-c。';
      await this.terminal.validate(target, true);
      if (this.signal.aborted) return null;
      try { await this.terminal.key(target, key); } catch (error) { error.uncertain = true; throw error; }
      return key === 'ctrl-c' ? '已向当前终端发送 Ctrl-C。' : `已发送 ${key}。`;
    }
    if (input.startsWith('/') && !input.startsWith('/send ')) return '未知指令。发送 /help 查看用法；要把以 / 开头的内容发给终端，请使用 /send 内容。';
    const line = input.startsWith('/send ') ? text.slice(text.indexOf('/send ') + 6) : text;
    if (!line.trim()) return '请输入要发送的文字。';
    const prompt = decisionPrompt(await this.terminal.screen(target));
    if (prompt) return `${prompt}\n\n当前终端等待选择。使用 /key up、/key down、/key enter，或在 Panecast 中操作。`;
    await this.terminal.validate(target, true);
    if (this.signal.aborted) return null;
    try { await this.terminal.input(target, line, page, this.signal); } catch (error) { error.uncertain = true; throw error; }
    return `已发送到 ${target.title}。`;
  }
  async observe() {
    const target = this.state.value.target;
    if (!target) return;
    let page;
    try { page = await this.terminal.snapshot(target); } catch { return; }
    const old = this.state.value.baseline;
    if (identityChanged(old, page)) {
      await this.enqueue('changed:' + digest(JSON.stringify([params(target), page.conversation_id, page.generation])), `「${target.title}」的会话已变化，请重新 /use ${target.code} 选择。`, target);
      return;
    }
    // Explicit final/question metadata only. An idle screen or a pause in output
    // must never turn commentary/tool logs into completion notifications.
    let prompt = null;
    try { prompt = decisionPrompt(await this.terminal.screen(target)); } catch { /* Do not invent a decision on an unreadable screen. */ }
    const fresh = (page.items ?? []).filter(i => i.type === 'agentMessage' && (i.updatedSequence ?? i.sequence ?? 0) >= (old?.sequence ?? Infinity));
    for (const item of fresh.filter(i => i.phase === 'final' || (i.needsInput === true && !prompt))) {
      await this.enqueue(`item:${page.conversation_id}:${item.id}`, `${target.title} · ${item.needsInput ? '需要你回应' : '已完成'}\n\n${item.text}`, target);
    }
    const promptKey = prompt ? digest(JSON.stringify([params(target), page.conversation_id, page.items?.findLast(i => i.type === 'userMessage')?.id, prompt.split('\n').map(line => line.replace(/^\s*[›❯>→●]?\s*/, '')).join('\n')])) : null;
    if (promptKey && promptKey !== this.state.value.prompt) await this.enqueue('prompt:' + promptKey, `${target.title} · 需要你选择\n\n${prompt}\n\n使用 /key up、/key down、/key enter，或打开 Panecast。`, target);
    const events = await this.journal.page({ cursor: this.state.value.eventCursor, limit: 100 });
    if (!events.reset) for (const event of events.events) {
      const p = event.payload ?? {}, kind = notificationSignal(event);
      if (!kind || p.surface_id !== target.surface_id || (p.workspace_id && p.workspace_id !== target.workspace_id)) continue;
      // Structured completion is the primary signal; a duplicate hook stays quiet.
      if (kind === 'completed' && fresh.some(i => i.phase === 'final')) continue;
      if (kind === 'attention' && prompt) continue;
      const recentFinal = page.items?.findLast(i => i.phase === 'final' && i.timestamp > Date.now() - 30000);
      const text = kind === 'completed' ? recentFinal?.text || p.body || p.title : p.body || p.message || p.title;
      const id = kind === 'completed' && recentFinal ? `item:${page.conversation_id}:${recentFinal.id}` : 'event:' + (p.panecast_event_id ?? digest(JSON.stringify(p)));
      if (text) await this.enqueue(id, `${target.title} · ${kind === 'completed' ? '已完成' : '需要你处理'}\n\n${text}`, target);
    }
    const nextBaseline = baseline(page);
    // Metadata-only changes must not force a state-file rewrite every two seconds.
    if (JSON.stringify(old) !== JSON.stringify(nextBaseline) || this.state.value.prompt !== promptKey || this.state.value.eventCursor !== events.next_cursor) await this.state.change(s => { s.baseline = nextBaseline; s.prompt = promptKey; s.eventCursor = events.next_cursor; });
  }
  async flush() {
    if (!this.state.value.context) return;
    for (const value of [...this.state.value.outbox]) {
      if (this.signal.aborted) return;
      if (!['pending', 'rejected'].includes(value.status)) continue;
      if (value.status === 'rejected' && value.context === this.state.value.context) continue;
      if (value.target) {
        try { await this.terminal.validate(value.target); }
        catch { await this.state.change(s => { s.outbox = s.outbox.filter(e => e.id !== value.id); }); continue; }
      }
      for (let index = value.next; index < value.chunks.length; index++) {
        const context = this.state.value.context;
        await this.state.change(s => { Object.assign(s.outbox.find(e => e.id === value.id), { status: 'sending', context }); });
        try { await this.api.send(this.account.ownerId, value.chunks[index], context, 'panecast-' + digest(`${value.id}:${index}`), this.signal); }
        catch (error) {
          await this.state.change(s => { s.outbox.find(e => e.id === value.id).status = error.uncertain ? 'unknown' : 'rejected'; });
          if (error.code === '-14') throw error;
          this.logger('微信回复未送达；已保留状态，未自动重复发送。');
          break;
        }
        await this.state.change(s => {
          const entry = s.outbox.find(e => e.id === value.id); entry.next = index + 1; entry.status = 'pending';
          if (entry.next === entry.chunks.length) { s.outbox = s.outbox.filter(e => e.id !== value.id); s.delivered.push(value.id); }
        });
      }
    }
  }
  async run() {
    await this.serial(() => this.processPending());
    let backoff = 1000;
    const observer = (async () => {
      while (!this.signal.aborted) {
        try { await this.serial(async () => { await this.observe(); await this.flush(); }); }
        catch (error) { if (error.code === '-14') { this.controller.abort(); throw error; } await this.state.queue; this.logger('微信结果同步暂不可用。'); }
        await delay(2000, undefined, { signal: this.signal }).catch(() => {});
      }
    })();
    // Attach a handler immediately; the polling loop may still be in a long poll.
    let observationError;
    observer.catch(error => { observationError = error; this.controller.abort(); });
    try {
      while (!this.signal.aborted) {
        try { const batch = await this.api.updates(this.state.value.cursor, this.signal); this.onHealthy(); await this.serial(async () => { await this.accept(batch); await this.flush(); }); backoff = 1000; await delay(200, undefined, { signal: this.signal }).catch(() => {}); }
        catch (error) {
          if (this.signal.aborted) break;
          if (error.code === '-14') throw error;
          // A poisoned disk queue stops the bridge instead of losing a cursor.
          await this.state.queue;
          this.logger('微信连接中断，稍后重连。'); await delay(backoff, undefined, { signal: this.signal }).catch(() => {}); backoff = Math.min(30000, backoff * 2);
        }
      }
      if (observationError) throw observationError;
    } finally { this.stopped = true; this.controller.abort(); await observer.catch(() => {}); await this.operations; this.parentSignal.removeEventListener('abort', this.abort); }
  }
}
