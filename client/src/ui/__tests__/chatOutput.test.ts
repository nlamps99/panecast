import { fitOutputRules, outputColumns } from '../chatOutput';

it('cuts rules drawn for a wide pane to the card instead of wrapping them', () => {
  const columns = outputColumns(300, 12);
  expect(columns).toBe(41);
  const output = ['$ make', '-'.repeat(150), '─'.repeat(150), `╭${'─'.repeat(148)}╮`, 'build ok'].join('\n');
  const lines = fitOutputRules(output, columns).split('\n');
  expect(lines).toHaveLength(5);
  expect(lines[1]).toBe('-'.repeat(columns));
  expect(lines[2]).toBe('─'.repeat(columns));
  expect(lines[3].endsWith('╮')).toBe(true);
  expect(lines[3]).toHaveLength(columns);
  expect(lines[0]).toBe('$ make'); expect(lines[4]).toBe('build ok');
});

it('leaves ordinary long lines for the text to wrap, and everything alone before the card is measured', () => {
  const long = `error: ${'x'.repeat(120)} -- see log`;
  expect(fitOutputRules(long, 40)).toBe(long);
  expect(fitOutputRules('-'.repeat(150), 0)).toBe('-'.repeat(150));
});
