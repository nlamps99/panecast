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
