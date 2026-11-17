import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mobileItem } from '../src/hub/codex-history.mjs';
import { parseConversation } from '../src/hub/terminal-conversation.mjs';

const fixtures = JSON.parse(await readFile(new URL('../../docs/specs/fixtures/conversation-visibility.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(`conversation visibility: ${fixture.name}`, () => {
  const content = [{ type: 'text', text: fixture.input }];
  const mobile = mobileItem({ id: 'user', type: 'userMessage', content });
  assert.equal(mobile?.content?.[0]?.text ?? null, fixture.expected);
  const parsed = parseConversation([{ offset: 1, value: { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'main', item: { id: 'user', type: 'UserMessage', content } } } }], 'codex', 'main');
  assert.equal(parsed.items[0]?.content?.[0]?.text ?? null, fixture.expected);
});
test('foreign child turns cannot change main conversation format or activity', () => {
  const values = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'main prompt' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', thread_id: 'main' } },
    { type: 'event_msg', payload: { type: 'item_completed', threadId: 'child', item: { id: 'child', type: 'UserMessage', content: [{ type: 'text', text: 'delegated input' }] } } },
  ];
  const parsed = parseConversation(values.map((value, offset) => ({ value, offset })), 'codex', 'main');
  assert.deepEqual(parsed.items.map(i => i.content?.[0]?.text), ['main prompt']);
  assert.equal(parsed.active, false);
});
test('structured internal provenance is removed before canonical records discard it', () => {
  const values = [
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'internal', content: [{ type: 'input_text', text: 'delegated input without markup' }], internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: 'subagent' } }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'internal', content: [{ type: 'text', text: 'delegated input without markup' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'answer', phase: 'final_answer', content: [{ type: 'text', text: 'public answer' }] } } },
  ];
  const result = parseConversation(values.map((value, offset) => ({ value, offset })), 'codex', 'main');
  assert.deepEqual(result.items.map(i => i.type), ['agentMessage']); assert.equal(result.active, false);
});
