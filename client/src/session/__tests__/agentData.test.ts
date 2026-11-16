import { agentItem, agentThread, agentTurns } from '../agentData';
import { itemText } from '../sourceStore';

test('incomplete history items cannot crash a message view', () => {
  const turns = agentTurns([null, { id: 'turn', items: null }, { id: 'tools', items: [null, { id: 'bad', type: 'userMessage', content: {} }, { id: 'change', type: 'fileChange', changes: [null, { path: {} }] }] }]);
  expect(turns).toHaveLength(2);
  expect(turns[0].items).toEqual([]);
  expect(() => turns.flatMap((turn) => turn.items.map(itemText))).not.toThrow();
  expect(agentThread({ id: 't', name: { invalid: true }, cwd: null })?.name).toBe('Codex 会话');
});

test('older relays cannot make the phone retain an unbounded command output', () => {
  const item = agentItem({ id: 'command', type: 'commandExecution', aggregatedOutput: 'x'.repeat(1_000_000) });
  expect(item?.aggregatedOutput).toHaveLength(6000); expect(item?.truncated).toBe(true);
});

test('multiple text parts share one preview budget', () => {
  const item = agentItem({ id: 'user', type: 'userMessage', content: Array.from({ length: 8 }, () => ({ type: 'text', text: 'x'.repeat(16_000) })) });
  expect(itemText(item!)).toHaveLength(16_000); expect(item?.truncated).toBe(true);
});

test('occupied conversations retain verified navigation to their original terminal', () => {
  const thread = agentThread({ id: 'thread', writerState: 'other_process', originalTerminal: { workspaceId: 'cmux~ws', surfaceId: 'cmux~sf', sourceName: 'cmux' } });
  expect(thread?.writerState).toBe('other_process');
  expect(thread?.originalTerminal?.surfaceId).toBe('cmux~sf');
});
