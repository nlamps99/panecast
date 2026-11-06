import type { Machine } from './appStore';

export type Diagnostic = { name: string; state: 'ok' | 'warning' | 'error'; detail: string; ms?: number };
async function health(base: string, name: string, fetchImpl: typeof fetch, broker?: { relayId: string; token: string }): Promise<Diagnostic> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4000);
  const started = Date.now();
  try {
    const url = new URL(`${base.replace(/\/$/, '')}/v1/health`);
    if (broker) url.searchParams.set('relay_id', broker.relayId);
    const response = await fetchImpl(url.toString(), { signal: abort.signal, ...(broker ? { headers: { Authorization: `Bearer ${broker.token}` } } : {}) });
    if (response.status === 401) return { name, state: 'error', detail: '这台电脑的配对已失效，请重新扫码' };
    if (!response.ok) return { name, state: 'error', detail: `HTTP ${response.status}，请检查服务是否启动` };
    const body = await response.json();
    if (body.ok !== true) return { name, state: 'warning', detail: '地址可达，但返回内容不符合 Panecast 健康检查' };
    return { name, state: body.relay_online === false ? 'warning' : 'ok', detail: body.relay_online === false ? '服务器可达，电脑离线；检查电脑上的 relay 是否运行' : '服务可达', ms: Date.now() - started };
  } catch { return { name, state: 'error', detail: abort.signal.aborted ? '连接超时；检查网络、地址和防火墙' : '无法访问；检查网络和服务地址' }; }
  finally { clearTimeout(timer); }
}
export async function diagnose(machine: Machine, fetchImpl: typeof fetch = fetch): Promise<Diagnostic[]> {
  if (machine.mode === 'demo') return [{ name: '演示电脑', state: 'ok', detail: '演示环境可以正常交互，不检测真实网络' }];
  const computer = machine.computer;
  if (!computer) return [];
  const network = await Promise.all([
    health(computer.broker.serverUrl, '中转服务器', fetchImpl, computer.broker),
    computer.lan ? health(computer.lan.url, '局域网直连', fetchImpl) : Promise.resolve<Diagnostic>({ name: '局域网直连', state: 'warning', detail: '尚未配对局域网，不影响经服务器连接' }),
  ]);
  const status = machine.channel.status;
  const authenticated: Diagnostic = { name: '手机连接', state: status.state === 'open' ? 'ok' : 'error', detail: status.state === 'open' ? '已通过身份验证并建立连接' : status.state === 'auth_failed' ? '配对已失效，请重新扫码' : '尚未连接；先解决上方网络或电脑离线问题' };
  let backend: Diagnostic = { name: '终端后端', state: 'warning', detail: '连接恢复后才能检查' };
  if (machine.channel.isOpen) {
    const started = Date.now();
    try {
      const result = await machine.channel.call<{ backend?: string; backend_ready?: boolean }>('relay.diagnostics', {}, 5000);
      backend = { name: '终端后端', state: result.backend_ready ? 'ok' : 'error', detail: result.backend_ready ? `${result.backend ?? '终端'} 正常` : 'relay 在线，但终端不可用；请打开终端并检查连接权限', ms: Date.now() - started };
    } catch {
      try {
        await machine.channel.call('workspace.list', {}, 5000);
        backend = { name: '终端后端', state: 'ok', detail: '工作区可读取；升级 relay 可获得更完整的诊断', ms: Date.now() - started };
      } catch { backend = { name: '终端后端', state: 'error', detail: '无法读取工作区，请检查终端是否运行以及 relay 的访问权限' }; }
    }
  }
  return [...network, authenticated, backend];
}
export function diagnosticReport(rows: readonly Diagnostic[]): string {
  return ['Panecast 连接诊断', new Date().toISOString(), ...rows.map((row) => `${row.name}: ${row.state}${row.ms === undefined ? '' : ` (${row.ms} ms)`} — ${row.detail}`)].join('\n');
}
