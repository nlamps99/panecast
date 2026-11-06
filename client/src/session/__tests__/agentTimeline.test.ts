import { agentTimeline, type AgentToolGroup, type AgentTimelineRow } from '../agentTimeline';
import type { AgentItem, AgentTurn } from '../sourceStore';

const item = (id: string, type = 'commandExecution'): AgentItem => ({ id, type, text: id, command: `command ${id}` });
const turn = (items: AgentItem[], extra: Partial<AgentTurn> = {}): AgentTurn => ({ id: 'turn', status: 'completed', items, ...extra });
const messages = (rows: AgentTimelineRow[]) => rows.flatMap((row) => row.kind === 'item' ? [row.item.id] : []);
const groups = (rows: AgentTimelineRow[]) => rows.filter((row): row is AgentToolGroup => row.kind === 'tools');

it('keeps the conversation readable while collapsing consecutive tools in place', () => {
  const history = [turn([item('user', 'userMessage'), item('cmd'), item('change', 'fileChange'), item('answer', 'agentMessage'), item('external', 'mcpToolCall'), item('final', 'agentMessage')])];
  const rows = agentTimeline(history);
  expect(messages(rows)).toEqual(['user', 'answer', 'final']);
  expect(rows.map((row) => row.kind)).toEqual(['item', 'tools', 'item', 'tools', 'item']);
  expect(groups(rows).map((group) => group.items.map((tool) => tool.id))).toEqual([['cmd', 'change'], ['external']]);
  expect(history[0].items).toHaveLength(6);
});

it('expands one group as individual list rows and restores the same order when collapsed', () => {
  const history = [turn([item('cmd'), item('answer', 'agentMessage'), item('change', 'fileChange')])];
  const collapsed = agentTimeline(history), selected = groups(collapsed)[0].key;
  const expanded = agentTimeline(history, new Set([selected]));
  expect(messages(expanded)).toEqual(['cmd', 'answer']);
  expect(groups(expanded).map((group) => group.expanded)).toEqual([true, false]);
  expect(agentTimeline(history)).toEqual(collapsed);
});

it('preserves an expanded live group when tools arrive or older tools leave the retention window', () => {
  const user = item('user', 'userMessage');
  const key = groups(agentTimeline([turn([user, item('old'), item('current')])]))[0].key;
  const live = agentTimeline([turn([user, item('current'), item('new')], { status: 'inProgress' })], new Set([key]), 'turn');
  expect(messages(live)).toEqual(['user', 'current', 'new']);
  expect(groups(live)[0]).toMatchObject({ key, expanded: true });
  expect(live.at(-1)).toMatchObject({ kind: 'status', turnId: 'turn' });
});

it('uses separate groups across turns and preserves plans as readable messages', () => {
  const history = [turn([item('same')]), turn([item('plan', 'plan'), item('same')], { id: 'other' })];
  const collapsed = agentTimeline(history);
  const keys = groups(collapsed).map((group) => group.key);
  expect(new Set(keys).size).toBe(2);
  expect(messages(agentTimeline(history, new Set([keys[0]])))).toEqual(['same', 'plan']);
});

it('keeps failure and unavailable-history notices visible with tools collapsed', () => {
  const failed = { ...item('failed'), status: 'failed' };
  const rows = agentTimeline([turn([failed], { error: { message: '测试失败，需要修复' }, omittedItems: 50 })]);
  expect(messages(rows)).toEqual([]);
  expect(groups(rows)[0].items[0].status).toBe('failed');
  expect(rows.at(-1)).toMatchObject({ kind: 'status', error: '测试失败，需要修复', omitted: 50 });
});

it('does not show stale running history as a live task or create empty status rows', () => {
  expect(agentTimeline([turn([], { status: 'inProgress' })])).toEqual([]);
  expect(agentTimeline([turn([], { status: 'inProgress' })], new Set(), 'turn')).toHaveLength(1);
});

it('reduces a tool-heavy history to one group per turn without dropping user messages or answers', () => {
  const history = Array.from({ length: 20 }, (_, n) => turn([item(`user-${n}`, 'userMessage'), ...Array.from({ length: 80 }, (_, i) => item(`tool-${n}-${i}`)), item(`answer-${n}`, 'agentMessage')], { id: `turn-${n}` }));
  const rows = agentTimeline(history);
  expect(rows).toHaveLength(60);
  expect(messages(rows)).toHaveLength(40);
  expect(groups(rows).every((group) => group.items.length === 80 && !group.expanded)).toBe(true);
});
