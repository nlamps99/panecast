import { itemRows, itemsOnScreen, recordRows, RECORD_WRITING_NOTICE, wrapCells } from '../recordHistory';
import type { AgentItem } from '../sourceStore';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import type { PushFrame } from '../../protocol/frames';
import { plainTerminalRows } from '../../terminal/textTools';

const reply = (n: number, text = `reply number ${n} with some words`): AgentItem => ({ id: `item-${n}`, type: 'agentMessage', text, sequence: n });
const plain = (rows: readonly string[]) => plainTerminalRows(rows);

it('wraps by terminal cells, counting wide characters twice and indenting continuations', () => {
  expect(wrapCells('⏺ 一二三四五六七八九十', 12, '  ')).toEqual(['⏺ 一二三四五', '  六七八九十']);
  expect(wrapCells('abcdefghij', 8, '  ')).toEqual(['abcdefgh', '  ij']);
});

it('draws items in the program\'s terminal style', () => {
  expect(plain(itemRows({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '修一下滚动' }] }, 80))).toEqual(['❯ 修一下滚动']);
  expect(plain(itemRows(reply(1, '## 结论\n**滚动**用 `record` 读取'), 80))).toEqual(['⏺ 结论', '  滚动用 record 读取']);
  const tool = plain(itemRows({ id: 't', type: 'toolExecution', tool: 'Bash', command: 'git status', aggregatedOutput: Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n') }, 80));
  expect(tool.slice(0, 3)).toEqual(['⏺ Bash(git status)', '  ⎿  line 0', '     line 1']);
  expect(tool.at(-1)).toBe('     … 还有 3 行');
  const change = itemRows({ id: 'f', type: 'fileChange', changes: [{ path: 'a.ts', diff: '--- a\n+++ b\n-old\n+new' }] }, 80);
  expect(plain(change)).toEqual(['⏺ Update(a.ts)', '     -old', '     +new']);
  expect(change[1]).toContain('\u001b[31m');
  expect(change[2]).toContain('\u001b[32m');
  expect(plain(recordRows([reply(1), reply(2)], 80))).toEqual(['⏺ reply number 1 with some words', '', '⏺ reply number 2 with some words']);
});

it('finds the newest items the screen already shows, in order from the bottom', () => {
  const items = [reply(1), reply(2), reply(3), reply(4)];
  const screen = ['  number 2 with some words', '', '⏺ reply number 3 with some words', '', '⏺ reply number 4 with some', '  words', '❯ ', '  status'];
  // Item 2 is cut off at the top, so it stays in the history; 3 and 4 are on screen.
  expect(itemsOnScreen(items, screen)).toBe(2);
  // The same phrase above the newest item does not hide an older item that is not on screen.
  const repeated = [reply(1, 'Done.'), reply(2, 'something else entirely'), reply(3, 'Done.')];
  expect(itemsOnScreen(repeated, ['⏺ Done.', '❯ '])).toBe(1);
  expect(itemsOnScreen([reply(1)], ['❯ ', 'nothing here'])).toBe(0);
});

const application = { render_grid: { active_screen: 'alternate', columns: 100, rows: 12, modes: [{ ansi: false, code: 1000, on: true }] } };
const page = (from: number, to: number, cursor: string | null, extra: Record<string, unknown> = {}) => ({ available: true, provider: 'claude', conversation_id: 'c', generation: 'g',
  revision: `r${to}`, active: false, items: Array.from({ length: to - from }, (_, i) => reply(from + i)), next_cursor: cursor, ...extra });

function fixture(answer: (params: Record<string, unknown>) => unknown) {
  let listener: (frame: PushFrame) => void = () => {};
  const call = jest.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.conversation') return answer(params ?? {});
    return {};
  });
  const channel: RpcChannel = { isOpen: true, call: call as RpcChannel['call'], onPush: (fn) => { listener = fn; return () => {}; }, onStatus: () => () => {} };
  const session = new TerminalSession(channel);
  session.setTarget({ workspaceId: 'w', surfaceId: 's' });
  const screen = (rows: string[]) => listener({ type: 'screen.full', surfaceId: 's', rev: 1, rows, cols: 100, rowsCount: rows.length, cursor: { x: 0, y: 0 } });
  screen(['⏺ reply number 98 with some words', '', '⏺ reply number 99 with some words', '❯ ', '  status']);
  return { session, call, screen };
}
const reads = (call: jest.Mock) => call.mock.calls.filter(([method]) => method === 'terminal.conversation').map(([, params]) => params);

it('shows a page read ahead at once, confirms it by revision, then pages older items', async () => {
  const { session, call } = fixture((params) => params.cursor === 'p1' ? page(0, 20, null) : params.revision === 'r100' ? { ...page(20, 100, 'p1'), items: [], unchanged: true } : page(20, 100, 'p1'));
  await session.inspectScrollMode();
  session.prepareHistory();
  await session.prepareRecord();
  session.startApplicationHistory();
  // Shown before any read for this browse: items 98 and 99 are on screen.
  const first = plain(session.getState().browse!.olderRows).filter(Boolean);
  expect(first.at(-1)).toBe('⏺ reply number 97 with some words');
  expect(first).toHaveLength(78);
  await session.loadOlder();
  expect(reads(call).at(-1)).toMatchObject({ revision: 'r100', limit: 80 });
  expect(plain(session.getState().browse!.olderRows).filter(Boolean)).toEqual(first);
  await session.loadOlder();
  expect(reads(call).at(-1)).toMatchObject({ cursor: 'p1' });
  const all = plain(session.getState().browse!.olderRows).filter(Boolean);
  expect(all).toHaveLength(98);
  expect(all[0]).toBe('⏺ reply number 0 with some words');
  expect(session.getState().browse).toMatchObject({ exhausted: true, error: null, loading: false });
  expect(call.mock.calls.some(([method]) => method === 'terminal.scroll')).toBe(false);
  session.resumeLive();
  expect(call.mock.calls.some(([method]) => method === 'terminal.scroll')).toBe(false);
  session.dispose();
});

it('replaces a stale page read ahead with what the record holds when browsing starts', async () => {
  let latest = 90;
  const { session, screen } = fixture(() => page(0, latest, null));
  await session.inspectScrollMode();
  await session.prepareRecord();
  latest = 100;
  screen(['⏺ reply number 98 with some words', '', '⏺ reply number 99 with some words', '❯ ', '  status']);
  session.startApplicationHistory();
  // Read ahead at 90 items: nothing on screen matches, so all 90 are shown for now.
  expect(plain(session.getState().browse!.olderRows).filter(Boolean)).toHaveLength(90);
  await session.loadOlder();
  const rows = plain(session.getState().browse!.olderRows).filter(Boolean);
  expect(rows).toHaveLength(98);
  expect(rows.at(-1)).toBe('⏺ reply number 97 with some words');
  session.dispose();
});

it('reads ahead past newest pages that hold only internal entries', async () => {
  const { session, call } = fixture((params) => params.cursor === 'p1' ? page(0, 40, null) : page(40, 40, 'p1'));
  await session.inspectScrollMode();
  await session.prepareRecord();
  session.startApplicationHistory();
  expect(plain(session.getState().browse!.olderRows).filter(Boolean)).toHaveLength(40);
  expect(reads(call).map((params) => params.cursor ?? null)).toEqual([null, 'p1']);
  session.dispose();
});

it('notes a reply still being written when the screen shows none of the record', async () => {
  const { session, screen } = fixture(() => page(0, 10, null, { active: true }));
  screen(['  the middle of a long reply', '  still streaming', '❯ ']);
  await session.inspectScrollMode();
  session.startApplicationHistory();
  await session.loadOlder();
  expect(session.getState().browse!.olderRows.at(-1)).toBe(RECORD_WRITING_NOTICE);
  session.dispose();
});

it('gives the wheel back to a program without a record', async () => {
  const { session, call } = fixture(() => ({ available: false, provider: 'terminal' }));
  await session.inspectScrollMode();
  await session.prepareRecord();
  expect(session.getState().applicationScroll?.record).toBe(false);
  session.startApplicationHistory();
  expect(session.getState().browse).toBeNull();
  session.scrollApplication(2);
  expect(call.mock.calls.filter(([method]) => method === 'terminal.scroll').map(([, params]) => params?.delta_lines)).toEqual([2]);
  session.dispose();
});

it('ends browsing when the record turns out to be missing, and reports read failures for retry', async () => {
  let answer: unknown = { available: false };
  const { session } = fixture(() => { if (answer instanceof Error) throw answer; return answer; });
  await session.inspectScrollMode();
  session.startApplicationHistory();
  await session.loadOlder();
  expect(session.getState().browse).toBeNull();
  expect(session.getState().applicationScroll?.record).toBe(false);

  const second = fixture(() => { if (answer instanceof Error) throw answer; return answer; });
  answer = new Error('broker timeout');
  await second.session.inspectScrollMode();
  second.session.startApplicationHistory();
  await second.session.loadOlder();
  expect(second.session.getState().browse?.error).toBe('暂时读不到会话记录');
  answer = page(0, 10, null);
  await second.session.loadOlder({ retry: true });
  expect(second.session.getState().browse).toMatchObject({ error: null, exhausted: true });
  session.dispose(); second.session.dispose();
});
