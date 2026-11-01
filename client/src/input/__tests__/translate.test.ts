import { translateCommitted } from '../translate';

describe('translateCommitted', () => {
  it('sends plain and composed text as is', () => {
    expect(translateCommitted('ls')).toEqual([{ kind: 'text', text: 'ls' }]);
    expect(translateCommitted('你好')).toEqual([{ kind: 'text', text: '你好' }]);
  });

  it('turns line breaks into Enter', () => {
    const enter = { kind: 'key', key: { name: 'enter' } };
    expect(translateCommitted('\n')).toEqual([enter]);
    expect(translateCommitted('a\r\nb\rc\n')).toEqual([
      { kind: 'text', text: 'a' },
      enter,
      { kind: 'text', text: 'b' },
      enter,
      { kind: 'text', text: 'c' },
      enter,
    ]);
  });

  it('ignores empty input', () => {
    expect(translateCommitted('')).toEqual([]);
  });
});
