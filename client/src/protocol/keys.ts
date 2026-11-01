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
  backspace: { name: 'backspace' },
  ctrlC: { name: 'c', modifiers: ['ctrl'] },
} as const satisfies Record<string, Key>;
