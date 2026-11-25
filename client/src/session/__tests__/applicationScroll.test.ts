import { TerminalSession, type RpcChannel } from '../terminalSession';

function fixture() {
  const call = jest.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
  const channel: RpcChannel = { isOpen: true, call: call as RpcChannel['call'], onPush: () => () => {}, onStatus: () => () => {} };
  const session = new TerminalSession(channel);
  session.setTarget({ workspaceId: 'workspace', surfaceId: 'surface' });
  return { session, call, channel };
}
const application = { render_grid: { active_screen: 'alternate', columns: 156, rows: 47,
  modes: [{ ansi: false, code: 1000, on: true }, { ansi: false, code: 1006, on: true }] } };

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

it('sends a touch drag one wheel unit per request and drops what the network cannot keep up with', async () => {
  jest.useFakeTimers();
  const { session, call } = fixture();
  call.mockResolvedValue(application); await session.inspectScrollMode();
  const finishes: (() => void)[] = [];
  call.mockImplementation(async (method) => method === 'terminal.scroll' ? new Promise<void>((resolve) => { finishes.push(resolve); }) : {});
  const deltas = () => call.mock.calls.filter(([m]) => m === 'terminal.scroll').map(([, p]) => p?.delta_lines);
  for (let i = 0; i < 20; i++) session.scrollApplication(1, { batch: 1, maxQueued: 6 });
  await jest.advanceTimersByTimeAsync(200);
  // Four in flight, at most six waiting: the rest of the fast drag is dropped.
  expect(deltas()).toEqual([1, 1, 1, 1]);
  for (const finish of finishes.splice(0)) finish();
  await jest.advanceTimersByTimeAsync(400);
  for (const finish of finishes.splice(0)) finish();
  await jest.advanceTimersByTimeAsync(400);
  expect(deltas().every((delta) => delta === 1)).toBe(true);
  expect(deltas().length).toBeLessThanOrEqual(10);
  session.dispose(); jest.useRealTimers();
});

it('subscribes again on retry after the terminal could not be opened', async () => {
  const { session, call } = fixture();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  (session as unknown as { update(patch: object): void }).update({ subscription: 'error', subscriptionError: 'timeout' });
  call.mockClear();
  session.retrySubscription();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(call.mock.calls.filter(([m]) => m === 'surface.subscribe')).toHaveLength(1);
  expect(session.getState().subscription).toBe('live');
  session.retrySubscription();
  expect(call.mock.calls.filter(([m]) => m === 'surface.subscribe')).toHaveLength(1);
  session.dispose();
});
