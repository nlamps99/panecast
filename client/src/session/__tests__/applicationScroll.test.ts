import { TerminalSession, type RpcChannel } from '../terminalSession';
import type { PushFrame } from '../../protocol/frames';
import { plainTerminalRows } from '../../terminal/textTools';

function fixture() {
  const call = jest.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
  const channel: RpcChannel = { isOpen: true, call: call as RpcChannel['call'], onPush: () => () => {}, onStatus: () => () => {} };
  const session = new TerminalSession(channel);
  session.setTarget({ workspaceId: 'workspace', surfaceId: 'surface' });
  return { session, call, channel };
}
const application = { render_grid: { active_screen: 'alternate', columns: 156, rows: 47,
  modes: [{ ansi: false, code: 1000, on: true }, { ansi: false, code: 1006, on: true }] } };

type ProgramOptions = {
  /** Rows one wheel unit moves; a function lets it change between steps. */
  multiplier?: number | ((step: number) => number);
  stationary?: boolean;
  /** Clear the revealed prefix first and fill it in 100 ms later. */
  partial?: boolean;
  /** Push a frame for each scroll, as the relay does on its next poll. */
  push?: boolean;
  /** Color each transcript row in pushed frames. */
  colors?: boolean;
};

/** A full-screen program: 31 transcript rows between a header and an input line. */
function programFixture({ multiplier = 9, stationary = false, partial = false, push: pushes = true, colors = false }: ProgramOptions = {}) {
  let listener: (frame: PushFrame) => void = () => {}, position = 1000, revision = 0, steps = 0;
  const rows = () => ['header', 'transcript', ...Array.from({ length: 31 }, (_, i) => `transcript row #${position + i}`), 'input', `status ${revision}`];
  // read_text returns what is on screen right now, like cmux.
  let screen = rows();
  const color = (row: string) => colors && row.startsWith('transcript row #') ? `\u001b[32m${row}\u001b[0m` : row;
  const push = (snapshot?: string[]) => {
    revision++;
    screen = snapshot ?? rows();
    listener({ type: 'screen.full', surfaceId: 'surface', rev: revision, rows: screen.map(color), cols: 80, rowsCount: 35, cursor: { x: 0, y: 34 } });
  };
  const call = jest.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'terminal.replay') return { render_grid: { ...application.render_grid, rows: 35 } };
    if (method === 'surface.read_text') return { text: screen.join('\n') };
    if (method === 'terminal.scroll') {
      const delta = Number(params?.delta_lines);
      const unit = typeof multiplier === 'function' ? multiplier(steps++) : multiplier;
      if (!stationary) position = Math.max(0, position - delta * unit);
      if (partial && delta > 0) {
        const complete = rows(), clearing = [...complete];
        for (let i = 2; i < 11; i++) clearing[i] = '';
        push(clearing); setTimeout(() => push(complete), 100);
      } else if (pushes) push();
      else screen = rows();
    }
    return {};
  });
  const channel: RpcChannel = { isOpen: true, call: call as RpcChannel['call'], onPush: (fn) => { listener = fn; return () => {}; }, onStatus: () => () => {} };
  const session = new TerminalSession(channel); session.setTarget({ workspaceId: 'workspace', surfaceId: 'surface' }); push();
  return { session, call, push };
}
const acceleratedFixture = (stationary = false, multiplier = 9, partial = false) => programFixture({ stationary, multiplier, partial });
const transcriptOf = (session: TerminalSession) => {
  const browse = session.getState().browse!;
  return plainTerminalRows([...browse.olderRows, ...browse.frozenRows]).filter(row => row.startsWith('transcript row #'));
};
const deltas = (call: jest.Mock) => call.mock.calls.filter(([method]) => method === 'terminal.scroll').map(([, p]) => p?.delta_lines);

it.each([9, 30])('joins accelerated program history when wheel input is multiplied %s times', async multiplier => {
  const { session, call } = acceleratedFixture(false, multiplier); await session.inspectScrollMode(); session.startApplicationHistory();
  for (let i = 0; i < 6; i++) await session.loadOlder();
  const browse = session.getState().browse!;
  expect(browse.error).toBeNull();
  const transcript = [...browse.olderRows, ...browse.frozenRows].filter(row => row.startsWith('transcript row #'));
  expect(transcript).toEqual(Array.from({ length: 31 + 6 * multiplier }, (_, i) => `transcript row #${1000 - 6 * multiplier + i}`));
  expect(browse.frozenRows).toEqual([...Array.from({ length: 31 }, (_, i) => `transcript row #${1000 + i}`), 'input', 'status 1']);
  expect(call.mock.calls.filter(([method]) => method === 'terminal.scroll').map(([, p]) => p?.delta_lines)).toEqual([1, 1, 1, 1, 1, 1]);
  session.resumeLive();
  expect(call.mock.calls.filter(([method]) => method === 'terminal.scroll').at(-1)?.[1]?.delta_lines).toBe(-6);
  session.dispose();
});

it('reaches the oldest transcript without an alignment error when the status keeps changing', async () => {
  jest.useFakeTimers();
  const { session } = acceleratedFixture(true); await session.inspectScrollMode(); session.startApplicationHistory();
  const loading = session.loadOlder();
  await jest.advanceTimersByTimeAsync(1600); await loading;
  expect(session.getState().browse).toMatchObject({ error: null, exhausted: true });
  session.dispose(); jest.useRealTimers();
});

it('waits for a partial redraw to fill its cleared prefix before appending history', async () => {
  jest.useFakeTimers();
  const { session } = acceleratedFixture(false, 9, true); await session.inspectScrollMode(); session.startApplicationHistory();
  const loading = session.loadOlder();
  await jest.advanceTimersByTimeAsync(50);
  expect(session.getState().browse).toMatchObject({ loading: true, olderRows: [] });
  await jest.advanceTimersByTimeAsync(100); await loading;
  const browse = session.getState().browse!;
  expect([...browse.olderRows, ...browse.frozenRows].filter(row => row.startsWith('transcript row #')))
    .toEqual(Array.from({ length: 40 }, (_, i) => `transcript row #${991 + i}`));
  session.dispose(); jest.useRealTimers();
});

it('sizes later steps to about half a screen from what the first unit moved', async () => {
  const { session, call } = programFixture({ multiplier: 3 }); await session.inspectScrollMode(); session.startApplicationHistory();
  for (let i = 0; i < 4; i++) await session.loadOlder();
  expect(session.getState().browse?.error).toBeNull();
  // 35 rows: half is 17, one unit moved 3, so later steps send 5 units.
  expect(deltas(call)).toEqual([1, 5, 5, 5]);
  expect(transcriptOf(session)).toEqual(Array.from({ length: 31 + 48 }, (_, i) => `transcript row #${1000 - 48 + i}`));
  session.resumeLive();
  expect(deltas(call).at(-1)).toBe(-16);
  session.dispose();
});

it('reads the screen directly instead of waiting for the next pushed frame', async () => {
  jest.useFakeTimers();
  const { session } = programFixture({ push: false }); await session.inspectScrollMode(); session.startApplicationHistory();
  const loading = session.loadOlder();
  await jest.advanceTimersByTimeAsync(40); await loading;
  expect(session.getState().browse).toMatchObject({ loading: false, error: null, exhausted: false });
  expect(transcriptOf(session)).toEqual(Array.from({ length: 40 }, (_, i) => `transcript row #${991 + i}`));
  session.dispose(); jest.useRealTimers();
});

it('steps back and continues with single units when a sized step overshoots the overlap', async () => {
  jest.useFakeTimers();
  // The first unit moves 3 rows; later units move 9, so 5 units skip the whole screen.
  const { session, call } = programFixture({ multiplier: (step) => step === 0 ? 3 : 9 });
  await session.inspectScrollMode(); session.startApplicationHistory();
  let loading = session.loadOlder(); await jest.advanceTimersByTimeAsync(20); await loading;
  loading = session.loadOlder(); await jest.advanceTimersByTimeAsync(2_000); await loading;
  expect(deltas(call)).toEqual([1, 5, -5]);
  expect(session.getState().browse).toMatchObject({ error: null, exhausted: false, loading: false });
  loading = session.loadOlder(); await jest.advanceTimersByTimeAsync(20); await loading;
  expect(deltas(call).at(-1)).toBe(1);
  expect(transcriptOf(session)).toEqual(Array.from({ length: 31 + 12 }, (_, i) => `transcript row #${1000 - 12 + i}`));
  session.dispose(); jest.useRealTimers();
});

it('colors rows read as plain text once a pushed frame shows them', async () => {
  jest.useFakeTimers();
  const { session, push } = programFixture({ push: false, colors: true }); await session.inspectScrollMode(); session.startApplicationHistory();
  const loading = session.loadOlder(); await jest.advanceTimersByTimeAsync(40); await loading;
  expect(session.getState().browse!.olderRows.filter(row => row.startsWith('transcript row #'))).toHaveLength(9);
  push();
  const older = session.getState().browse!.olderRows.filter(row => row.includes('transcript row #'));
  expect(older).toHaveLength(9);
  expect(older.every(row => row.startsWith('\u001b[32m'))).toBe(true);
  session.dispose(); jest.useRealTimers();
});

it('paces prefetch steps for colors and ends the pause when the reader reaches the edge', async () => {
  jest.useFakeTimers();
  const { session, call } = programFixture(); await session.inspectScrollMode(); session.startApplicationHistory();
  let loading = session.loadOlder({ prefetch: true }); await jest.advanceTimersByTimeAsync(20); await loading;
  loading = session.loadOlder({ prefetch: true });
  await jest.advanceTimersByTimeAsync(100);
  expect(deltas(call)).toHaveLength(1);
  void session.loadOlder();
  await jest.advanceTimersByTimeAsync(20); await loading;
  expect(deltas(call)).toHaveLength(2);
  session.dispose(); jest.useRealTimers();
});

it('lets a new gesture retry a failed step', async () => {
  const { session } = programFixture(); await session.inspectScrollMode(); session.startApplicationHistory();
  const browse = session.getState().browse!;
  (session as unknown as { update(patch: object): void }).update({ browse: { ...browse, error: '程序画面变化' } });
  await session.loadOlder();
  expect(session.getState().browse?.olderRows).toHaveLength(0);
  await session.loadOlder({ retry: true });
  expect(session.getState().browse).toMatchObject({ error: null });
  expect(transcriptOf(session)).toHaveLength(40);
  session.dispose();
});

it('recognizes application-owned history without treating the current screen as the beginning', async () => {
  const { session, call } = fixture();
  call.mockResolvedValue(application);
  await session.inspectScrollMode();
  session.startBrowsing();
  expect(session.getState().applicationScroll).toMatchObject({ columns: 156, rows: 47 });
  expect(session.getState().browse).toBeNull();
  session.startBrowsing({ freezeApplication: true });
  await session.inspectScrollMode();
  expect(session.getState().browse).not.toBeNull();
  session.resumeLive();
  call.mockResolvedValue({ render_grid: { ...application.render_grid, active_screen: 'primary' } });
  await session.inspectScrollMode(); session.startBrowsing();
  expect(session.getState().applicationScroll).toBeNull();
  expect(session.getState().browse).not.toBeNull();
  session.dispose();
});

it('uses ordinary history for a primary screen, a non-mouse alternate screen, and older relays', async () => {
  const { session, call } = fixture();
  for (const result of [{}, { render_grid: { ...application.render_grid, active_screen: 'primary' } },
    { render_grid: { ...application.render_grid, modes: [{ ansi: false, code: 1000, on: false }] } }]) {
    call.mockResolvedValue(result); await session.inspectScrollMode();
    expect(session.getState().applicationScroll).toBeFalsy();
  }
  call.mockRejectedValue(new Error('method not found'));
  await expect(session.inspectScrollMode()).resolves.toBeUndefined();
  session.startBrowsing(); expect(session.getState().browse).not.toBeNull();
  session.dispose();
});

it('streams small ordered wheel steps before slow acknowledgements without changing pane focus', async () => {
  jest.useFakeTimers();
  const { session, call } = fixture();
  call.mockResolvedValue(application); await session.inspectScrollMode();
  const finishes: (() => void)[] = [];
  call.mockImplementation(async (method) => method === 'terminal.scroll' ? new Promise<void>((resolve) => { finishes.push(resolve); }) : {});
  session.scrollApplication(4); session.scrollApplication(5); session.scrollApplication(6);
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(100);
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll').map(([, p]) => p?.delta_lines)).toEqual([4, 4, 4, 3]);
  session.scrollApplication(50);
  await jest.advanceTimersByTimeAsync(200);
  expect(finishes).toHaveLength(4); // Bounded backpressure, even if the network stalls.
  session.stopApplicationScroll();
  for (const finish of finishes) finish();
  await jest.advanceTimersByTimeAsync(100);
  expect(session.getState().applicationScroll?.busy).toBe(false);
  expect(call).toHaveBeenLastCalledWith('terminal.scroll', expect.objectContaining({ workspace_id: 'workspace', surface_id: 'surface', col: 78, row: 23 }), expect.any(Number));
  expect(call.mock.calls.some(([m]) => m === 'surface.focus' || m === 'surface.send_text')).toBe(false);
  session.dispose(); jest.useRealTimers();
});

it('drops queued gestures on a target switch and does not replay an uncertain failed scroll', async () => {
  const { session, call } = fixture();
  call.mockResolvedValue(application); await session.inspectScrollMode();
  let fail!: (error: Error) => void;
  call.mockImplementation(async (method) => method === 'terminal.scroll' ? new Promise((_, reject) => { fail = reject; }) : {});
  session.scrollApplication(5); session.scrollApplication(10);
  fail(new Error('connection lost')); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(session.getState().applicationScroll?.error).toContain('connection lost');
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(1);
  session.scrollApplication(20);
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(1);
  session.stopApplicationScroll(true);
  session.scrollApplication(3); session.scrollApplication(7);
  session.setTarget({ workspaceId: 'new', surfaceId: 'new' });
  fail(new Error('late failure')); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(session.getState().applicationScroll).toBeFalsy();
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(2);
  session.dispose();
});
