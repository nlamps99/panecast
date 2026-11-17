import { itemRows, itemsOnScreen, recordLayout, recordRows, RECORD_WRITING_NOTICE, seamOverlap, wrapCells } from '../recordHistory';
import type { AgentItem } from '../sourceStore';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import type { PushFrame } from '../../protocol/frames';
import { plainTerminalRows } from '../../terminal/textTools';
import { makeReadingPosition, type PositionedLine } from '../readingPosition';

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
  expect(tool.at(-1)).toBe('     … 还有 3 行，点按展开');
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

it('marks shortened output rows for expansion and draws them in full once expanded', () => {
  const tool: AgentItem = { id: 't', type: 'toolExecution', tool: 'Bash', command: 'ls', aggregatedOutput: Array.from({ length: 15 }, (_, i) => `file ${i}`).join('\n') };
  const shortened = recordLayout([reply(1), tool], 80);
  expect([...shortened.expandable]).toEqual([[shortened.rows.length - 1, 't']]);
  const full = recordLayout([reply(1), tool], 80, new Set(['t']));
  expect(full.expandable.size).toBe(0);
  expect(plain(full.rows).at(-1)).toBe('     file 14');
});

it('trims only an exact run of rows the screen repeats at its top', () => {
  const history = ['⏺ Bash(ls)', '  ⎿  file 1', '     file 2', ''];
  expect(seamOverlap(history, ['  ⎿  file 1', '     file 2', '', '⏺ next'])).toBe(3);
  expect(seamOverlap(history, ['     file 2', '⏺ next'])).toBe(2);
  // A line that merely appears somewhere on screen is not a seam.
  expect(seamOverlap(history, ['⏺ next', '  ⎿  file 1', '     file 2'])).toBe(0);
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

it('expands a tool output in place and reads the whole record for search', async () => {
  const tool = { id: 'tool', type: 'toolExecution', tool: 'Bash', command: 'ls', aggregatedOutput: Array.from({ length: 20 }, (_, i) => `file ${i}`).join('\n'), sequence: 50 };
  const { session, call } = fixture((params) => params.cursor === 'p2' ? page(0, 30, null) : params.cursor === 'p1' ? page(30, 60, 'p2')
    : { ...page(60, 100, 'p1'), items: [...page(60, 100, null).items.slice(0, 10), tool, ...page(60, 100, null).items.slice(10)] });
  await session.inspectScrollMode();
  session.startApplicationHistory();
  await session.loadOlder();
  const browse = session.getState().browse!;
  const [[index, id]] = [...browse.expandable!];
  expect(id).toBe('tool');
  expect(plain([browse.olderRows[index]])[0]).toBe('     … 还有 8 行，点按展开');
  const before = browse.olderRows.length;
  session.expandRecordItem('tool');
  expect(session.getState().browse!.olderRows.length).toBe(before + 7);
  expect(session.getState().browse!.expandable!.size).toBe(0);
  expect(await session.loadWholeRecord()).toBe(true);
  const all = plain(session.getState().browse!.olderRows).filter(Boolean);
  expect(all[0]).toBe('⏺ reply number 0 with some words');
  expect(all).toContain('     file 19');
  expect(session.getState().browse).toMatchObject({ exhausted: true, loading: false });
  expect(reads(call).map((params) => params.cursor ?? null)).toEqual([null, 'p1', 'p2']);
  session.dispose();
});

it('finds a saved reading place again in the record when coming back to the window', async () => {
  let listener: (frame: PushFrame) => void = () => {};
  const saved: unknown[] = [];
  const call = jest.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.conversation') return params?.cursor === 'p1' ? page(0, 20, null) : page(20, 100, 'p1');
    return {};
  });
  const channel: RpcChannel = { isOpen: true, call: call as RpcChannel['call'], onPush: (fn) => { listener = fn; return () => {}; }, onStatus: () => () => {} };
  // The place as the view saved it: the rows the record history showed, plus the screen.
  const frozen = ['⏺ reply number 99 with some words', '❯ '];
  const shownRows = [...recordRows(Array.from({ length: 99 }, (_, i) => reply(i)), 100), ...frozen];
  const at = shownRows.indexOf(recordRows([reply(5)], 100)[0]);
  const position = makeReadingPosition(shownRows, { rowFromBottom: shownRows.length - at - 1, segmentFromBottom: 0 } as PositionedLine);
  const session = new TerminalSession(channel, { readingForTarget: () => position, saveReading: (_target, value) => { saved.push(value); } });
  session.setTarget({ workspaceId: 'w', surfaceId: 's' });
  expect(session.getState().restoringReading).toBe(true);
  listener({ type: 'screen.full', surfaceId: 's', rev: 1, rows: frozen, cols: 100, rowsCount: 2, cursor: { x: 0, y: 0 } });
  for (let i = 0; i < 50 && session.getState().restoringReading; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const state = session.getState();
  expect(state).toMatchObject({ restoringReading: false, readingNotice: null });
  expect(state.browse?.kind).toBe('application');
  const rows = [...state.browse!.olderRows, ...state.browse!.frozenRows];
  expect(plain([rows[rows.length - 1 - state.restoredReading!.rowFromBottom]])[0]).toBe('⏺ reply number 5 with some words');
  expect(call.mock.calls.some(([method]) => method === 'terminal.scroll')).toBe(false);
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
