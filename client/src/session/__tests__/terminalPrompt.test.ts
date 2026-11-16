import { terminalDecision } from '../terminalPrompt';

const question = ['Which environment should I use?', '› 1. Staging (Recommended)', '  2. Production', '  3. Type something else', 'Enter to select · Esc to cancel'];
it('recognizes a live Codex question with its selected choice', () => {
  expect(terminalDecision(question)).toMatchObject({ title: 'Which environment should I use?', selectedIndex: 0,
    options: [{ label: 'Staging (Recommended)' }, { label: 'Production' }, { label: 'Type something else' }], multiSelect: false });
});
it('does not mistake an assistant numbered list or a quoted old prompt for an active decision', () => {
  expect(terminalDecision(['Suggested approach:', '1. Read files', '2. Run tests', 'Done.'])).toBeNull();
  expect(terminalDecision([...question, 'The question has been answered.', '› Write your next message', '? for shortcuts'])).toBeNull();
});
it('recognizes approvals and multiple-choice controls without inventing a selected option', () => {
  expect(terminalDecision(['Would you like to run the following command?', '$ npm test', '1. Yes, proceed', '2. No, and tell the agent', 'Press enter to confirm or esc to cancel'])).toMatchObject({ selectedIndex: null });
  expect(terminalDecision(['Choose checks:', '❯ 1. [x] Types', '  2. [ ] Tests', 'Space to select · Enter to submit'])).toMatchObject({ selectedIndex: 0, multiSelect: true });
});
it('keeps wrapped option descriptions with their option and gives changed questions different identities', () => {
  const first = terminalDecision(['Choose environment:', '› 1. Staging', '       Isolated test deployment', '  2. Production', 'Enter to select · Esc to cancel']);
  expect(first?.options[0].label).toContain('Isolated test deployment');
  expect(first?.id).not.toEqual(terminalDecision(question)?.id);
});
