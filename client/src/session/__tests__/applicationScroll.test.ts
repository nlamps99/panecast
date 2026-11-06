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

it('coalesces remote wheel requests, keeps them ordered and never pins another pane focus', async () => {
  const { session, call } = fixture();
  call.mockResolvedValue(application); await session.inspectScrollMode();
  let finish!: () => void;
  call.mockImplementation(async (method) => method === 'terminal.scroll' ? new Promise<void>((resolve) => { finish = resolve; }) : {});
  session.scrollApplication(4); session.scrollApplication(5); session.scrollApplication(6);
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(1);
  finish(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll').map(([, p]) => p?.delta_lines)).toEqual([4, 11]);
  expect(call).toHaveBeenLastCalledWith('terminal.scroll', expect.objectContaining({ workspace_id: 'workspace', surface_id: 'surface', col: 78, row: 23 }), expect.any(Number));
  expect(call.mock.calls.some(([m]) => m === 'surface.focus' || m === 'surface.send_text')).toBe(false);
  finish(); session.dispose();
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
  session.scrollApplication(3); session.scrollApplication(7);
  session.setTarget({ workspaceId: 'new', surfaceId: 'new' });
  fail(new Error('late failure')); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(session.getState().applicationScroll).toBeFalsy();
  expect(call.mock.calls.filter(([m]) => m === 'terminal.scroll')).toHaveLength(2);
  session.dispose();
});
