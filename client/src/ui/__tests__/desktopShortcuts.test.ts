import { desktopCommand, menuCommand, menuShortcut } from '../desktopShell';

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

  it('leaves the terminal its own keys and the system its ⌘C / ⌘V / ⌘Q', () => {
    for (const plain of [key('t', { ctrlKey: true }), key('1'), key('c', { metaKey: true }), key('v', { metaKey: true }), key('q', { metaKey: true }), key('[', { metaKey: true })]) {
      expect(desktopCommand(plain, false)).toBeNull();
    }
  });

  it('leaves ⇧⌘W (关闭窗口) and other shifted letters to the Mac menu', () => {
    for (const letter of ['W', 'N', 'T', 'F', 'Z']) expect(desktopCommand(key(letter, { metaKey: true, shiftKey: true }), false)).toBeNull();
    expect(menuShortcut(key('W', { metaKey: true, shiftKey: true }))).toBe(true);
    // Windows has no menu bar; Ctrl+Shift is its modifier.
    expect(desktopCommand(key('N', { ctrlKey: true, shiftKey: true }), true)).toEqual({ kind: 'newWorkspace' });
  });

  it('maps ⌘N and ⌘W, which the Mac menu bar carries', () => {
    expect(desktopCommand(key('n', { metaKey: true }), false)).toEqual({ kind: 'newWorkspace' });
    expect(desktopCommand(key('w', { metaKey: true }), false)).toEqual({ kind: 'close' });
    expect(desktopCommand(key('W', { ctrlKey: true, shiftKey: true }), true)).toEqual({ kind: 'close' });
  });

  it('leaves the keys the Mac menu shows to the menu, and nothing else', () => {
    for (const owned of ['n', 't', 'w', 'f', ',', '=', '-', '0', 'T']) expect(menuShortcut(key(owned, { metaKey: true }))).toBe(true);
    // ⌘1–⌘9, ⌘⇧], ⌘⌥↓, ⌘L and ⌘+ have no menu item: the page keeps them.
    for (const page of [key('1', { metaKey: true, code: 'Digit1' }), key('}', { metaKey: true, shiftKey: true }), key('ArrowDown', { metaKey: true, altKey: true }),
      key('l', { metaKey: true }), key('+', { metaKey: true, shiftKey: true }), key('t', { ctrlKey: true }), key('t')]) {
      expect(menuShortcut(page)).toBe(false);
    }
  });

  it('runs the menu bar items as the shortcuts they show', () => {
    expect(menuCommand('new-workspace')).toEqual({ kind: 'newWorkspace' });
    expect(menuCommand('new-terminal')).toEqual({ kind: 'new' });
    expect(menuCommand('close-terminal')).toEqual({ kind: 'close' });
    expect(menuCommand('settings')).toEqual({ kind: 'settings' });
    expect(menuCommand('zoom-in')).toEqual({ kind: 'font', step: 1 });
    expect(menuCommand('zoom-out')).toEqual({ kind: 'font', step: -1 });
    expect(menuCommand('zoom-reset')).toEqual({ kind: 'font', step: 0 });
    expect(menuCommand('find')).toEqual({ kind: 'find' });
    expect(menuCommand('toggle-sidebar')).toEqual({ kind: 'sidebar' });
    for (const other of ['check-update', 'toString', '__proto__', 42, null]) expect(menuCommand(other)).toBeNull();
  });

  it('uses Ctrl+Shift on Windows so plain Ctrl keys still reach the terminal', () => {
    expect(desktopCommand(key('T', { ctrlKey: true, shiftKey: true }), true)).toEqual({ kind: 'new' });
    expect(desktopCommand(key('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }), true)).toEqual({ kind: 'terminal', index: 0 });
    expect(desktopCommand(key('t', { ctrlKey: true }), true)).toBeNull();
    expect(desktopCommand(key('c', { ctrlKey: true, shiftKey: true }), true)).toBeNull();
  });
});
