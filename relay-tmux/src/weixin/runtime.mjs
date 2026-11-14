import { join } from 'node:path';
import { WeixinApi } from './api.mjs';
import { acquireLock, readAccount, savePrivate, statePath, WeixinState, weixinDirectory } from './storage.mjs';
import { TerminalGateway } from './terminal.mjs';
import { WeixinBridge } from './bridge.mjs';

/** Login/logout changes take effect without restarting the user's terminals. */
export class WeixinRuntime {
  constructor(registry, config, journal, options = {}) {
    Object.assign(this, { registry, config, journal, options }); this.directory = weixinDirectory(config); this.stopped = true; this.epoch = null;
  }
  async status(state, message = '') { this.currentStatus = { state, message }; await savePrivate(join(this.directory, 'status.json'), { state, message, at: Date.now() }); }
  start() {
    if (process.platform === 'win32') return;
    this.stopped = false;
    this.timer = setInterval(() => void this.reconcile(), 3000); this.timer.unref();
    void this.reconcile();
  }
  reconcile() {
    if (this.stopped) return Promise.resolve();
    if (this.loading) return this.loading;
    const task = this.update().finally(() => { if (this.loading === task) this.loading = null; });
    this.loading = task; return task;
  }
  async update() {
    try {
      const account = await readAccount(this.directory);
      if ((account?.epoch ?? null) === this.epoch) { if (account && this.currentStatus) await this.status(this.currentStatus.state, this.currentStatus.message); return; }
      await this.stopAccount();
      if (!account || this.stopped) { this.epoch = null; return; }
      const release = await acquireLock(this.directory);
      this.release = release; this.epoch = account.epoch;
      const state = new WeixinState(statePath(this.directory, account)); await state.load();
      if (this.stopped) { await release(); this.release = null; return; }
      this.controller = new AbortController();
      const terminal = this.options.terminalFactory?.() ?? new TerminalGateway(this.registry, this.config);
      this.terminal = terminal;
      const api = this.options.apiFactory?.(account) ?? new WeixinApi({ origin: account.origin, token: account.token });
      const bridge = new WeixinBridge({ account, state, api, terminal, journal: this.journal, signal: this.controller.signal,
        logger: message => { void this.status('reconnecting', message).catch(() => {}); },
        onHealthy: () => { if (this.currentStatus?.state !== 'connected') void this.status('connected').catch(() => {}); } });
      await this.status('connecting');
      this.task = bridge.run().then(() => this.status('stopped')).catch(error => this.status(error.code === '-14' ? 'login_required' : 'error', error.code === '-14' ? '微信登录已失效，请重新扫码' : '微信通道已停止；检查状态文件后重新绑定')).finally(async () => {
        terminal.close(); await release(); if (this.release === release) this.release = null;
      });
      this.task.catch(() => {});
    } catch {
      await this.stopAccount();
      await this.status('error', '微信配置或进程锁不可用；请运行 panecast weixin status 检查').catch(() => {});
    }
  }
  async stopAccount() { this.controller?.abort(); await this.task?.catch(() => {}); this.task = null; this.terminal?.close(); this.terminal = null; await this.release?.(); this.release = null; }
  async close() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); await this.loading; await this.stopAccount(); }
}
