import fixtures from '../../../../docs/specs/fixtures/conversation-visibility.json';
import { agentItem } from '../agentData';
import { itemText } from '../sourceStore';

test.each(fixtures)('client filters old relay records: $name', ({ input, expected }) => {
  const item = agentItem({ id: 'user', type: 'userMessage', content: [{ type: 'text', text: input }] });
  expect(item ? itemText(item) : null).toBe(expected);
});
test('preserves the real message alongside a typed environment block', () => {
  const item = agentItem({ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'private context' }, { type: 'text', text: 'real question' }],
    internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: 'harness' } }, { provenance: { type: 'user' } }] } });
  expect(item && itemText(item)).toBe('real question');
});
