import { terminalHardwareKey } from '../hardwareKeys';

const key = (key: string, modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) =>
  ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, altGraphKey: false, ...modifiers });

describe('terminalHardwareKey on Windows', () => {
  const windows = { windows: true };

  it('leaves paste and copy shortcuts to the system', () => {
    for (const event of [key('v', { ctrlKey: true }), key('V', { ctrlKey: true, shiftKey: true }),
      key('C', { ctrlKey: true, shiftKey: true }), key('F4', { altKey: true })]) {
      expect(terminalHardwareKey(event, windows)).toBeNull();
    }
  });

  it('interrupts with Ctrl+C unless terminal text is selected', () => {
    expect(terminalHardwareKey(key('c', { ctrlKey: true }), windows)).toEqual({ name: 'c', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('c', { ctrlKey: true }), { windows: true, selection: true })).toBeNull();
  });

  it('keeps other control keys and named keys for the terminal', () => {
    expect(terminalHardwareKey(key('r', { ctrlKey: true }), windows)).toEqual({ name: 'r', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('a', { ctrlKey: true }), windows)).toEqual({ name: 'a', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('F4'), windows)).toEqual({ name: 'f4' });
    expect(terminalHardwareKey(key('F4', { ctrlKey: true, altKey: true }), windows)).toEqual({ name: 'f4', modifiers: ['ctrl', 'alt'] });
    expect(terminalHardwareKey(key('Tab'), windows)).toEqual({ name: 'tab' });
  });

  it('keeps the Mac mapping unchanged', () => {
    expect(terminalHardwareKey(key('v', { ctrlKey: true }))).toEqual({ name: 'v', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('c', { ctrlKey: true }), { selection: true })).toEqual({ name: 'c', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('v', { metaKey: true }))).toBeNull();
  });
});

describe('terminalHardwareKey on a Mac', () => {
  it('sends the line-editing shortcuts Terminal.app and iTerm2 send', () => {
    expect(terminalHardwareKey(key('ArrowLeft', { metaKey: true }))).toEqual({ name: 'a', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('ArrowRight', { metaKey: true }))).toEqual({ name: 'e', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('Backspace', { metaKey: true }))).toEqual({ name: 'u', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('k', { metaKey: true }))).toEqual({ name: 'l', modifiers: ['ctrl'] });
    expect(terminalHardwareKey(key('ArrowLeft', { altKey: true }))).toEqual({ name: 'b', modifiers: ['alt'] });
    expect(terminalHardwareKey(key('ArrowRight', { altKey: true }))).toEqual({ name: 'f', modifiers: ['alt'] });
    expect(terminalHardwareKey(key('Backspace', { altKey: true }))).toEqual({ name: 'w', modifiers: ['ctrl'] });
    // Option reported as AltGraph still moves by word.
    expect(terminalHardwareKey({ ...key('ArrowLeft'), altGraphKey: true })).toEqual({ name: 'b', modifiers: ['alt'] });
  });

  it('leaves other Command shortcuts and shifted selections to macOS', () => {
    for (const event of [key('c', { metaKey: true }), key('K', { metaKey: true, shiftKey: true }), key('ArrowLeft', { metaKey: true, shiftKey: true }),
      key('ArrowLeft', { metaKey: true, altKey: true }), key('ArrowUp', { metaKey: true })]) {
      expect(terminalHardwareKey(event)).toBeNull();
    }
    expect(terminalHardwareKey(key('ArrowLeft', { altKey: true, shiftKey: true }))).toEqual({ name: 'left', modifiers: ['alt', 'shift'] });
  });

  it("uses cmux's names for the paging keys", () => {
    expect(terminalHardwareKey(key('PageUp'))).toEqual({ name: 'pageup' });
    expect(terminalHardwareKey(key('PageDown', { ctrlKey: true }))).toEqual({ name: 'pagedown', modifiers: ['ctrl'] });
  });

  it('keeps Alt+arrows as they are on Windows', () => {
    expect(terminalHardwareKey(key('ArrowLeft', { altKey: true }), { windows: true })).toEqual({ name: 'left', modifiers: ['alt'] });
    expect(terminalHardwareKey(key('ArrowLeft', { metaKey: true }), { windows: true })).toBeNull();
  });
});
