// Isolated gateway fixture. No real sockets, credentials, model calls or input.
(() => {
  localStorage.clear();
  const listeners = new Set(), notifications = [], calls = [];
  const runs = new Map([['a', { active: false, turn: 0 }], ['b', { active: false, turn: 0 }], ['c', { active: true, turn: 0 }]]);
  const history = Array.from({ length: 2400 }, (_, index) => `HISTORY_ROW_${String(index).padStart(4, '0')}`);
  const recent = ['a', 'b'].map((id, index) => ({ workspaceId: `w-${id}`, surfaceId: id, title: `终端 ${id.toUpperCase()}`, workspaceTitle: `项目 ${id.toUpperCase()}`, windowId: 'window', at: 2 - index }));
  const initial = window.__fixtureInitialTarget ?? 'a';
  localStorage.setItem('panecast.session-memory.v1', JSON.stringify({ version: 1, computers: { fixture: { recent, windowId: initial === 'c' ? 'window-two' : 'window', lastTarget: { workspaceId: `w-${initial}`, surfaceId: initial } } } }));
  if (window.__fixtureChat) localStorage.setItem('panecast.prefs.v1', JSON.stringify({ terminalPresentation: 'chat' }));
  const computer = { id: 'fixture', name: '测试电脑', pairedAt: new Date().toISOString(), broker: { serverUrl: 'https://qa.invalid', relayId: 'fixture', deviceId: 'fixture', token: 'fixture-only' } };
  const secrets = new Map([['panecast.computers.v2', JSON.stringify({ version: 2, selectedId: 'fixture', computers: [computer], transport: { fixture: 'broker' } })]]);
  let revision = 0, socket, applicationPosition = 1000, latency = window.__fixtureLatency ?? 0, queue = Promise.resolve();
  const applicationRows = () => ['PROGRAM HEADER', ...Array.from({ length: 43 }, (_, i) => `APP_HISTORY_${String(applicationPosition + i).padStart(4, '0')}`), '› fixture prompt'];
  const emit = event => { for (const listener of listeners) listener(event); };
  const frame = data => emit({ id: socket, type: 'message', data: JSON.stringify(data) });
  const screen = surface => frame({ type: 'screen.full', surface_id: surface, rev: ++revision,
    rows: surface === 'b' ? applicationRows() : history.slice(-12), cols: 90, rowsCount: surface === 'b' ? 45 : 12, cursor: { x: 0, y: 11 } });
  async function rpc(method, params) {
    calls.push({ method, params, at: performance.now() });
    if (latency) await new Promise(resolve => setTimeout(resolve, latency));
    if (method === 'window.list') return { windows: [{ id: 'window', ref: 'window:1', workspace_count: 2, key: true }, { id: 'window-two', ref: 'window:2', workspace_count: 1 }] };
    if (method === 'workspace.list') {
      const windowId = params.window_id ?? 'window';
      return { window_id: windowId, workspaces: (windowId === 'window-two' ? ['c'] : ['a', 'b']).map((id, index) => ({ id: `w-${id}`, title: `项目 ${id.toUpperCase()}`, index })) };
    }
    if (method === 'surface.list') { const id = params.workspace_id.slice(2); return { surfaces: [{ id, title: `终端 ${id.toUpperCase()}`, type: 'terminal', focused: true }] }; }
    if (method === 'surface.subscribe') { setTimeout(() => screen(params.surface_id), 50); return {}; }
    if (method === 'terminal.replay') return { render_grid: { active_screen: params.surface_id === 'b' ? 'alternate' : 'primary', columns: 90, rows: params.surface_id === 'b' ? 45 : 12, modes: [{ ansi: false, code: 1000, on: params.surface_id === 'b' }] } };
    if (method === 'terminal.scroll') { applicationPosition = Math.max(1, applicationPosition - params.delta_lines * 9); setTimeout(() => screen('b'), 20); return {}; }
    if (method === 'surface.read_text') return { text: applicationRows().join('\n') };
    if (method === 'surface.history') {
      const end = params.cursor ? Number(params.cursor) : history.length - (params.tail_lines ?? 12);
      const start = Math.max(0, end - Math.min(160, params.limit));
      return { rows: history.slice(start, end), next_cursor: start ? String(start) : null, ...(!params.cursor ? { anchor_rows: history.slice(end) } : {}) };
    }
    if (method === 'terminal.conversation') {
      const run = runs.get(params.surface_id), id = params.surface_id;
      const items = [{ id: `user-${run.turn}`, type: 'userMessage', sequence: run.turn * 10, content: [{ type: 'text', text: '请运行测试' }] }];
      if (!run.active) items.push({ id: `reply-${run.turn}`, type: 'agentMessage', sequence: run.turn * 10 + 1, phase: 'final', text: `会话 ${id} 已完成 ${run.turn}` });
      return { available: true, provider: 'codex', conversation_id: `chat-${id}`, generation: 'fixture', revision: `${run.turn}:${run.active}`, active: run.active, items, head_sequence: run.turn * 10 + 2 };
    }
    if (method === 'inbox.sync') return { events: [], cursor: '0', head: '0', more: false };
    if (method === 'source.list') return { sources: [] };
    return {};
  }
  window.panecastDesktop = {
    version: 1,
    getSecret: async key => secrets.get(key) ?? null, setSecret: async (key, value) => { secrets.set(key, value); }, deleteSecret: async key => { secrets.delete(key); },
    request: async () => ({ status: 200, body: '{}' }), abortRequest() {},
    connectSocket: async id => { socket = id; setTimeout(() => emit({ id, type: 'open' }), 0); },
    sendSocket: (id, data) => {
      const value = JSON.parse(data);
      if (value.method) queue = queue.then(() => rpc(value.method, value.params ?? {})).then(result => frame({ id: value.id, ok: true, result }));
      else if (value.type === 'ping') frame({ type: 'pong' });
    },
    closeSocket() {}, onSocket: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    notify: async options => { notifications.push(options); return true; }, onNotification: () => () => {},
    dialog: async options => options.cancelId, writeClipboard: async () => true,
  };
  window.panecastFixture = {
    calls, notifications,
    delay(ms) { latency = ms; },
    run(id) { const current = runs.get(id); runs.set(id, { active: true, turn: current.turn + 1 }); },
    complete(id) { runs.get(id).active = false; },
    output() { history.push('LIVE_OUTPUT_WHILE_READING'); screen('a'); },
  };
})();
