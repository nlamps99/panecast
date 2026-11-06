import { currentAgentTurn } from '../agentInput';

test('an unfinished history row is never reused after the latest turn has completed', () => {
  const turns = [{ id: 'old', status: 'inProgress', items: [] }, { id: 'latest', status: 'completed', items: [] }];
  expect(currentAgentTurn({ id: 't', name: 'Task', cwd: '/', live: true, status: { type: 'idle' } }, turns, undefined)).toBeNull();
  expect(currentAgentTurn({ id: 't', name: 'Task', cwd: '/', live: true, status: { type: 'active' } }, turns, undefined)).toBeNull();
  expect(currentAgentTurn({ id: 't', name: 'Task', cwd: '/', live: true }, turns, 'real-current')).toBe('real-current');
});
