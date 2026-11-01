import { ctrl, encodeKey, Keys, symbolAction, withModifiers } from '../keys';

describe('encodeKey', () => {
  it('uses the names SharedKit sends', () => {
    expect([Keys.pageUp, Keys.pageDown, Keys.home, Keys.end, Keys.delete].map(encodeKey)).toEqual([
      'pgup',
      'pgdn',
      'home',
      'end',
      'delete',
    ]);
    expect(encodeKey(Keys.ctrlC)).toBe('ctrl-c');
  });
});

describe('withModifiers', () => {
  it('adds modifiers in canonical order without duplicates', () => {
    expect(encodeKey(withModifiers({ name: 'left', modifiers: ['shift'] }, ['ctrl']))).toBe('ctrl-shift-left');
    expect(withModifiers(Keys.ctrlC, ['ctrl'])).toEqual({ name: 'c', modifiers: ['ctrl'] });
    expect(withModifiers(Keys.up, [])).toEqual({ name: 'up' });
  });
});

describe('ctrl', () => {
  it('chords a letter in lowercase', () => {
    expect(['r', 'd', 'l', 'z', 'R'].map((c) => encodeKey(ctrl(c)))).toEqual(['ctrl-r', 'ctrl-d', 'ctrl-l', 'ctrl-z', 'ctrl-r']);
  });

  it('chords a named key', () => {
    expect(encodeKey(ctrl(Keys.left))).toBe('ctrl-left');
    expect(encodeKey(ctrl(Keys.pageDown))).toBe('ctrl-pgdn');
  });
});

describe('symbolAction', () => {
  it('types the symbol as text without Ctrl', () => {
    expect(symbolAction('/', false)).toEqual({ kind: 'text', text: '/' });
    expect(symbolAction('`', false)).toEqual({ kind: 'text', text: '`' });
  });

  it('sends a Ctrl key with Ctrl, as the native client does', () => {
    expect(symbolAction('/', true)).toEqual({ kind: 'key', key: { name: '/', modifiers: ['ctrl'] } });
    const action = symbolAction('_', true);
    expect(action.kind === 'key' && encodeKey(action.key)).toBe('ctrl-_');
  });
});
