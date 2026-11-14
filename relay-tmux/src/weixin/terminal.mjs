import { createHash } from 'node:crypto';
import { scoped, unscoped } from '../hub/ids.mjs';
import { HubSession } from '../hub/session.mjs';

export const terminalCode = target => createHash('sha256').update(JSON.stringify([target.workspace_id, target.surface_id])).digest('hex').slice(0, 10);
export function decisionPrompt(text) {
  const lines = text.trimEnd().split('\n').slice(-45);
  const hint = /(?:enter|return|回车).*(?:select|confirm|submit|continue|选择|确认|提交)|(?:esc|escape).*(?:cancel|dismiss|取消)|space to (?:select|toggle)/i;
  const last = lines.findLastIndex(line => hint.test(line));
  if (last >= 0 && !lines.slice(last + 1).some(line => line.trim() && !/^[\s─━═│└┘┌┐┬┴┤├┼╰╯╭╮]+$/.test(line))) {
    const first = lines.findIndex(line => /^\s*[›❯>→●]?\s*\d{1,2}[.)]\s+/.test(line));
    if (first >= 0 && lines.slice(first, last).filter(line => /^\s*[›❯>→●]?\s*\d{1,2}[.)]\s+/.test(line)).length >= 2) return lines.slice(Math.max(0, first - 5), last + 1).join('\n').slice(-3000);
  }
  const question = lines.findLastIndex(line => /would you like to (?:run|allow|proceed)|do you want to (?:proceed|allow)|是否(?:允许|继续|执行)|需要你的(?:确认|批准)/i.test(line));
  if (question >= 0 && /\[y\/n\]|\byes\b.*\bno\b|允许一次|拒绝/i.test(lines.slice(question).join(' '))) return lines.slice(question).join('\n').slice(-3000);
  return null;
}

export class TerminalGateway {
  constructor(registry, config) {
    this.registry = registry;
    this.session = new HubSession(registry, config, () => {}, () => {}, () => {});
    void this.session.process(JSON.stringify({ protocolVersion: 1, deviceId: 'local-weixin-bridge' }));
  }
  async list() {
    const targets = []; let offline = 0;
    for (const { config: c } of this.registry.sources.values()) {
      if (!c.enabled || c.type !== 'cmux') continue;
      try {
        const client = this.session.client(c.id);
        const windows = (await client.call('window.list', {})).windows ?? [];
        const seen = new Set();
        for (const window of windows.length ? windows : [{ id: null }]) {
          const { workspaces = [] } = await client.call('workspace.list', window.id ? { window_id: window.id } : {});
          for (const workspace of workspaces) {
            if (seen.has(workspace.id)) continue; seen.add(workspace.id);
            const { surfaces = [] } = await client.call('surface.list', { workspace_id: workspace.id });
            for (const surface of surfaces.filter(s => s.type === 'terminal')) {
              const target = { sourceId: c.id, workspace_id: scoped(c.id, workspace.id), surface_id: scoped(c.id, surface.id), title: `${c.name} / ${workspace.title ?? '工作区'} / ${surface.title ?? '终端'}`.slice(0, 300), access: c.access };
              targets.push({ ...target, code: terminalCode(target) });
              if (targets.length >= 100) return { targets, offline, truncated: true };
            }
          }
        }
      } catch { offline++; }
    }
    return { targets, offline, truncated: false };
  }
  async validate(target, control = false) {
    const source = this.registry.get(target.sourceId);
    if (source.config.type !== 'cmux' || unscoped(target.workspace_id).source !== target.sourceId || unscoped(target.surface_id).source !== target.sourceId) throw new Error('终端绑定无效，请重新 /use 选择');
    if (control && source.config.access !== 'control') throw new Error('当前终端只允许读取');
    const result = await this.session.dispatch('surface.list', { workspace_id: target.workspace_id });
    if (!(result.surfaces ?? []).some(s => s.id === target.surface_id && s.type === 'terminal')) throw new Error('终端已关闭，请用 /list 重新选择');
  }
  async snapshot(target) {
    await this.validate(target);
    const page = await this.session.dispatch('terminal.conversation', { workspace_id: target.workspace_id, surface_id: target.surface_id, limit: 150 });
    const source = this.registry.get(target.sourceId);
    source.weixinPasteCapability ??= this.session.client(target.sourceId).call('system.capabilities', {}).then(r => (r.methods ?? []).includes('terminal.paste')).catch(() => false);
    if (await source.weixinPasteCapability) page.input_method = 'terminal.paste';
    return page;
  }
  async screen(target) {
    await this.validate(target);
    const result = await this.session.dispatch('surface.read_text', { workspace_id: target.workspace_id, surface_id: target.surface_id, lines: 60 });
    return typeof result.text === 'string' ? result.text.slice(-12000) : (result.rows ?? []).map(row => typeof row === 'string' ? row : row.text ?? '').join('\n').slice(-12000);
  }
  async input(target, text, snapshot, signal) {
    await this.validate(target, true);
    const params = { workspace_id: target.workspace_id, surface_id: target.surface_id };
    // Newer gateways expose the target-specific paste+submit operation. A failed
    // write is never retried using a different transport.
    if (signal?.aborted) throw new Error('输入已停止');
    if (snapshot.input_method === 'terminal.paste') {
      if (this.registry.get(target.sourceId).config.access !== 'control') throw new Error('当前终端只允许读取');
      return this.session.client(target.sourceId).call('terminal.paste', { workspace_id: unscoped(target.workspace_id).id, surface_id: unscoped(target.surface_id).id, text, submit_key: 'return' });
    }
    await this.session.dispatch('surface.send_text', { ...params, text });
    if (signal?.aborted) throw new Error('输入已停止');
    await this.key(target, 'enter');
  }
  async key(target, key) {
    if (!['enter', 'up', 'down', 'left', 'right', 'escape', 'tab', 'ctrl-c'].includes(key)) throw new Error('不支持这个按键');
    await this.validate(target, true);
    const params = { workspace_id: target.workspace_id, surface_id: target.surface_id };
    await this.session.dispatch('surface.focus', params);
    await this.session.dispatch('surface.send_key', { ...params, key });
  }
  close() { this.session.dispose(); }
}
