import { desktopCommand } from '../desktopShell';

const key = (key: string, extra: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, code: undefined, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

describe('desktop shortcuts', () => {
  it('maps the Mac ⌘ shortcuts', () => {
    expect(desktopCommand(key('1', { metaKey: true, code: 'Digit1' }), false)).toEqual({ kind: 'terminal', index: 0 });
    expect(desktopCommand(key('9', { metaKey: true, code: 'Digit9' }), false)).toEqual({ kind: 'terminal', index: -1 });
    expect(desktopCommand(key('}', { metaKey: true, shiftKey: true, code: 'BracketRight' }), false)).toEqual({ kind: 'cycle', step: 1 });
    expect(desktopCommand(key('{', { metaKey: true, shiftKey: true, code: 'BracketLeft' }), false)).toEqual({ kind: 'cycle', step: -1 });
    expect(desktopCommand(key('ArrowDown', { metaKey: true, altKey: true }), false)).toEqual({ kind: 'workspace', step: 1 });
    expect(desktopCommand(key('t', { metaKey: true }), false)).toEqual({ kind: 'new' });
    expect(desktopCommand(key('f', { metaKey: true }), false)).toEqual({ kind: 'find' });
    expect(desktopCommand(key('=', { metaKey: true }), false)).toEqual({ kind: 'font', step: 1 });
    expect(desktopCommand(key('-', { metaKey: true }), false)).toEqual({ kind: 'font', step: -1 });
    expect(desktopCommand(key('0', { metaKey: true, code: 'Digit0' }), false)).toEqual({ kind: 'font', step: 0 });
    expect(desktopCommand(key(',', { metaKey: true }), false)).toEqual({ kind: 'settings' });
  });

  it('leaves the terminal its own keys and the system its ⌘C / ⌘V / ⌘W / ⌘Q', () => {
    for (const plain of [key('t', { ctrlKey: true }), key('1'), key('c', { metaKey: true }), key('v', { metaKey: true }), key('w', { metaKey: true }), key('q', { metaKey: true }), key('[', { metaKey: true })]) {
      expect(desktopCommand(plain, false)).toBeNull();
    }
  });

  it('uses Ctrl+Shift on Windows so plain Ctrl keys still reach the terminal', () => {
    expect(desktopCommand(key('T', { ctrlKey: true, shiftKey: true }), true)).toEqual({ kind: 'new' });
    expect(desktopCommand(key('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }), true)).toEqual({ kind: 'terminal', index: 0 });
    expect(desktopCommand(key('t', { ctrlKey: true }), true)).toBeNull();
    expect(desktopCommand(key('c', { ctrlKey: true, shiftKey: true }), true)).toBeNull();
  });
});
