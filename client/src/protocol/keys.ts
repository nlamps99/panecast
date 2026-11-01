/**
 * Key names for `surface.send_key`. Mirrors `KeyEncoder` in SharedKit.
 *
 * cmux's control socket uses hyphen-joined names (`ctrl-c`), not `ctrl+c`. The
 * plus form is accepted by the RPC but does nothing.
 */
export type NamedKey =
  | 'enter'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pgup'
  | 'pgdn'
  | 'backspace'
  | 'delete';

export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'cmd';

const MODIFIER_ORDER: readonly KeyModifier[] = ['ctrl', 'alt', 'shift', 'cmd'];

export type Key = { name: NamedKey | string; modifiers?: readonly KeyModifier[] };

export function encodeKey(key: Key): string {
  const mods = MODIFIER_ORDER.filter((m) => key.modifiers?.includes(m));
  return mods.length === 0 ? key.name : `${mods.join('-')}-${key.name}`;
}

export const Keys = {
  enter: { name: 'enter' },
  tab: { name: 'tab' },
  escape: { name: 'escape' },
  up: { name: 'up' },
  down: { name: 'down' },
  left: { name: 'left' },
  right: { name: 'right' },
  home: { name: 'home' },
  end: { name: 'end' },
  pageUp: { name: 'pgup' },
  pageDown: { name: 'pgdn' },
  backspace: { name: 'backspace' },
  delete: { name: 'delete' },
  ctrlC: { name: 'c', modifiers: ['ctrl'] },
} as const satisfies Record<string, Key>;

/** `key` with `modifiers` added to the ones it already has. */
export function withModifiers(key: Key, modifiers: readonly KeyModifier[]): Key {
  const merged = MODIFIER_ORDER.filter((m) => key.modifiers?.includes(m) || modifiers.includes(m));
  return merged.length === 0 ? { name: key.name } : { name: key.name, modifiers: merged };
}

/**
 * Ctrl plus a key, or plus a single character: `ctrl({ name: 'left' })`,
 * `ctrl('r')`. Characters are lowercased: Ctrl-R and Ctrl-r are the same
 * control code, and cmux names letter keys in lowercase.
 */
export function ctrl(key: Key | string): Key {
  return withModifiers(typeof key === 'string' ? { name: key.toLowerCase() } : key, ['ctrl']);
}

/** One input for the terminal: text for `surface.send_text`, or a key for `surface.send_key`. */
export type KeyAction = { kind: 'text'; text: string } | { kind: 'key'; key: Key };

/**
 * A symbol key such as `/` or `~`. Plain, it is typed as text, which reaches
 * the terminal exactly as the user sees it. With Ctrl it has to be a key
 * event (`ctrl-/`), the way the native client's `sendSymbol` does it.
 */
export function symbolAction(symbol: string, withCtrl: boolean): KeyAction {
  return withCtrl ? { kind: 'key', key: ctrl(symbol) } : { kind: 'text', text: symbol };
}
