import { screenRepainted } from '../screenSwitch';

const shell = Array.from({ length: 40 }, (_, i) => `$ output line ${i}`);

describe('screenRepainted', () => {
  it('sees a full-screen program starting and quitting', () => {
    const vim = Array.from({ length: 40 }, (_, i) => (i < 30 ? `~` : `vim text ${i}`));
    expect(screenRepainted(shell, vim)).toBe(true);
    expect(screenRepainted(vim, shell)).toBe(true);
  });

  it('ignores output that scrolls, even when every row changed', () => {
    expect(screenRepainted(shell, [...shell.slice(1), 'next'])).toBe(false);
    expect(screenRepainted(shell, [...shell.slice(5), 'a', 'b', 'c', 'd', 'e'])).toBe(false);
  });

  it('ignores edits to a few rows and the first frame', () => {
    const edited = [...shell];
    edited[39] = '$ typing a command';
    edited[38] = '$ another';
    expect(screenRepainted(shell, edited)).toBe(false);
    expect(screenRepainted([], shell)).toBe(false);
    expect(screenRepainted(shell, shell)).toBe(false);
  });
});
