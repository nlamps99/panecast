import cases from '../../../../docs/specs/fixtures/notification-signals.json';
import { lifecycleNotificationId, notificationSignal } from '../notificationSignal';
import { isInboxEvent } from '../inboxRecord';

it.each(cases)('$label', ({ event, expected }) => {
  expect(notificationSignal(event)).toBe(expected);
  expect(isInboxEvent({ ...event, type: 'event' })).toBe(expected !== null);
});

it('keeps repeated turn callbacks stable and separates attention from completion', () => {
  const event = { category: 'agent', name: 'turn/completed', payload: { source_id: 's', threadId: 'th', turn: { id: 't', status: 'completed' } } };
  expect(lifecycleNotificationId(event)).toBe('task-event:s:th:t:completed');
  expect(lifecycleNotificationId({ ...event, payload: { ...event.payload, turn: { id: 't', status: 'failed' } } })).toBe('task-event:s:th:t:attention');
});
