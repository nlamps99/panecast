import { pickDefaultTarget } from '../../session/surfaces';
import { TerminalSession } from '../../session/terminalSession';
import { DemoChannel } from '../demoChannel';
import { PANE_COLS, visibleWidth } from '../demoText';
import type { PushFrame } from '../../protocol/frames';
import { Mirror, plain, rpc, rpcError } from '../testing/demoHarness';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** A subscription's first frame: rev 1, clear, every row, the cursor. */
function expectFullSnapshot(frame: PushFrame | undefined, surfaceId: string) {
  expect(frame).toMatchObject({ type: 'screen.diff', surfaceId, rev: 1 });
  const ops = frame?.type === 'screen.diff' ? frame.ops : [];
  expect(ops[0]).toEqual({ op: 'clear' });
  expect(ops[ops.length - 1]).toEqual({ op: 'cursor', x: 0, y: 0 });
  expect(ops.filter((op) => op.op === 'row')).toHaveLength(ops.length - 2);
}

const ALL_SURFACES = [
  ['demo-ws-1', 'demo-sf-1'],
  ['demo-ws-1', 'demo-sf-2'],
  ['demo-ws-2', 'demo-sf-3'],
  ['demo-ws-3', 'demo-sf-4'],
  ['demo-ws-3', 'demo-sf-5'],
  ['demo-ws-4', 'demo-sf-6'],
  ['demo-ws-5', 'demo-sf-7'],
] as const;

describe('DemoChannel as a relay', () => {
  it('behaves like a relay: subscribe, matching checksums, input echo, history', async () => {
    const channel = new DemoChannel();
    const session = new TerminalSession(channel);
    const calls = jest.spyOn(channel, 'call');

    const targetPromise = pickDefaultTarget(channel);
    await jest.advanceTimersByTimeAsync(200);
    const target = await targetPromise;
    expect(target).toEqual({ workspaceId: 'demo-ws-1', surfaceId: 'demo-sf-1' });

    session.setTarget(target);
    await jest.advanceTimersByTimeAsync(200);
    expect(session.getState().subscription).toBe('live');
    const rows = session.getState().screen.rows;
    expect(rows).toHaveLength(120);
    // Padded to the pane width like cmux; only the full-width rules reach it exactly.
    for (const row of rows) expect(visibleWidth(row)).toBe(PANE_COLS);

    // Two checksum rounds: the session's hash agrees, so it never resubscribes.
    await jest.advanceTimersByTimeAsync(10_500);
    expect(calls.mock.calls.filter(([method]) => method === 'surface.unsubscribe')).toHaveLength(0);

    session.submitLine('ls');
    session.submitLine('make deploy');
    await jest.advanceTimersByTimeAsync(500);
    const screen = plain(session.getState().screen.rows);
    expect(screen).toContain('~/code/panecast main $ ls');
    expect(screen).toContain('client  relay  broker  docs  scripts  README.md  LICENSE');
    expect(screen).toContain('~/code/panecast main $ make deploy');
    expect(screen).toContain('（演示模式：命令不会真的执行）');
    expect(screen[screen.length - 3]).toBe('~/code/panecast main $');

    session.startBrowsing();
    const load = session.loadOlder();
    await jest.advanceTimersByTimeAsync(200);
    await load;
    const browse = session.getState().browse!;
    expect(browse.error).toBeNull();
    // This scrollback fits one page: everything above the live window, oldest first.
    expect(plain(browse.olderRows)[0]).toBe('[build] 001 compiled src/module-1/index.ts in 17 ms');
    expect(browse.exhausted).toBe(true);
    session.dispose();
  });

  it('keeps every checksum exact across all terminals while they change and take input', async () => {
    const channel = new DemoChannel();
    const mirror = new Mirror(channel);
    for (const [workspaceId, surfaceId] of ALL_SURFACES) {
      void channel.call('surface.subscribe', { workspace_id: workspaceId, surface_id: surfaceId, lines: 120 });
    }
    await jest.advanceTimersByTimeAsync(200);
    expect(mirror.screens.size).toBe(ALL_SURFACES.length);

    const input: [string, Record<string, unknown>][] = [
      ['surface.send_text', { workspace_id: 'demo-ws-1', surface_id: 'demo-sf-1', text: 'echo 你好，世界' }],
      ['surface.send_key', { workspace_id: 'demo-ws-1', surface_id: 'demo-sf-1', key: 'enter' }],
      ['surface.send_key', { workspace_id: 'demo-ws-3', surface_id: 'demo-sf-5', key: 'down' }],
      ['surface.send_key', { workspace_id: 'demo-ws-3', surface_id: 'demo-sf-5', key: 'enter' }],
      ['surface.send_text', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3', text: 'y' }],
      ['surface.send_key', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3', key: 'enter' }],
      ['surface.send_key', { workspace_id: 'demo-ws-1', surface_id: 'demo-sf-2', key: 'ctrl-c' }],
      ['surface.send_text', { workspace_id: 'demo-ws-1', surface_id: 'demo-sf-2', text: './scripts/check --watch\r' }],
    ];
    for (const [method, params] of input) {
      await rpc(channel, method, params, 1_000);
    }
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mirror.mismatches).toEqual([]);
    expect(mirror.droppedDiffs).toBe(0);
    // A checksum per terminal every 5 s for over a minute.
    expect(mirror.checksums).toBeGreaterThanOrEqual(ALL_SURFACES.length * 12);
    expect(mirror.rows('demo-sf-1')).toContain('你好，世界');
    expect(mirror.rows('demo-sf-3')).toContain('已同步 3 条笔记到 ~/备份/笔记');
    expect(mirror.rows('demo-sf-5')).toContain('  v1.4.0 已发布到预发布环境');
    expect(mirror.rows('demo-sf-2')).toContain('~/code/panecast main $ ./scripts/check --watch');
    mirror.dispose();
  });

  it('stops its timers on unsubscribe and when nobody listens, and starts afresh after', async () => {
    const channel = new DemoChannel();
    const mirror = new Mirror(channel);
    const params = { workspace_id: 'demo-ws-1', surface_id: 'demo-sf-2', lines: 120 };
    await rpc(channel, 'surface.subscribe', params, 3_000);
    expect(mirror.diffs).toBeGreaterThan(3);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await rpc(channel, 'surface.unsubscribe', { surface_id: 'demo-sf-2' }, 100);
    expect(jest.getTimerCount()).toBe(0);
    const diffs = mirror.diffs;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mirror.diffs).toBe(diffs);

    // A new subscription starts with a full snapshot again.
    mirror.frames = [];
    await rpc(channel, 'surface.subscribe', params, 100);
    expectFullSnapshot(mirror.frames[0], 'demo-sf-2');

    // The last listener leaving (the app left the demo) drops subscriptions and timers.
    mirror.dispose();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(jest.getTimerCount()).toBe(0);

    // A listener that comes back and subscribes again gets a full screen, not a no-op.
    const again = new Mirror(channel);
    await rpc(channel, 'surface.subscribe', params, 100);
    expectFullSnapshot(again.frames[0], 'demo-sf-2');
    again.dispose();
  });

  it('pages long, growing scrollback from one frozen snapshot', async () => {
    const channel = new DemoChannel();
    const mirror = new Mirror(channel);
    const ids = { workspace_id: 'demo-ws-3', surface_id: 'demo-sf-4' };
    await rpc(channel, 'surface.subscribe', { ...ids, lines: 120 }, 2_000);

    // First page and a full read at the same instant, so both see the same scrollback.
    const first = channel.call<{ rows: string[]; anchor_rows: string[]; next_cursor: string | null }>('surface.history', {
      ...ids,
      tail_lines: 120,
      limit: 200,
    });
    const full = channel.call<{ text: string }>('surface.read_text', { ...ids, lines: 100_000 });
    await jest.advanceTimersByTimeAsync(50);
    const page = await first;
    const expected = (await full).text.split('\n');
    expect(page.anchor_rows).toHaveLength(120);
    expect(page.rows).toHaveLength(200);

    // The log keeps growing while we page; the cursor pages the snapshot, not the live log.
    const pages = [page.rows];
    let cursor = page.next_cursor;
    while (cursor) {
      await jest.advanceTimersByTimeAsync(3_000);
      const next = await rpc<{ rows: string[]; next_cursor: string | null; anchor_rows?: unknown }>(channel, 'surface.history', {
        ...ids,
        cursor,
        limit: 200,
      });
      expect(next.anchor_rows).toBeUndefined();
      pages.push(next.rows);
      cursor = next.next_cursor;
    }
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const stitched = [...pages.reverse().flat(), ...page.anchor_rows];
    expect(stitched).toEqual(expected);
    expect(plain(stitched.slice(0, 2))).toEqual([
      '~/code/weather-service release/1.4 $ tail -f logs/server.log',
      expect.stringContaining('weather-service v1.3.2 启动'),
    ]);
    // The live log moved on meanwhile.
    expect(mirror.rows('demo-sf-4')).not.toEqual(plain(expected.slice(-120)));
    mirror.dispose();
  });

  it('expires cursors of evicted snapshots, like SurfaceHistoryService', async () => {
    const channel = new DemoChannel();
    const ids = { workspace_id: 'demo-ws-3', surface_id: 'demo-sf-4' };
    const first = await rpc<{ next_cursor: string }>(channel, 'surface.history', ids);
    for (let i = 0; i < 8; i++) await rpc(channel, 'surface.history', ids);
    const error = await rpcError(channel, 'surface.history', { ...ids, cursor: first.next_cursor });
    expect(error.code).toBe('history_unavailable');
    expect(error.message).toMatch(/expired/);
    expect((await rpcError(channel, 'surface.history', { ...ids, cursor: 'garbage' })).code).toBe('history_unavailable');
  });

  it('answers only after the simulated latency and rejects what it does not know', async () => {
    const channel = new DemoChannel();
    let done = false;
    void channel.call('window.list').then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);

    const unknown = await rpcError(channel, 'surface.split');
    expect(unknown.code).toBe('method_not_found');
    expect(unknown.message).toBe('演示模式不支持 surface.split');
    expect((await rpcError(channel, 'surface.subscribe', { surface_id: 'demo-sf-1' })).code).toBe('invalid_params');
    expect((await rpcError(channel, 'surface.send_key', { surface_id: 'demo-sf-1' })).code).toBe('invalid_params');
    expect((await rpcError(channel, 'surface.send_text', { surface_id: 'nope', text: 'x' })).code).toBe('not_found');
  });

  it('reads a surface as text, like cmux surface.read_text', async () => {
    const channel = new DemoChannel();
    const result = await rpc<{ text: string; surface_id: string; workspace_id: string; window_id: string }>(
      channel,
      'surface.read_text',
      { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3', lines: 5 },
    );
    expect(result).toMatchObject({ surface_id: 'demo-sf-3', workspace_id: 'demo-ws-2', window_id: 'demo-win-1' });
    const rows = result.text.split('\n');
    expect(rows).toHaveLength(5);
    expect(plain(rows)[2]).toBe('同步到备份文件夹吗？[Y/n]');
  });
});
