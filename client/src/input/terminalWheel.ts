import { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform } from 'react-native';

export type TerminalWheelOptions = { enabled: boolean; lineHeight: number; pageHeight: number; move(pixels: number): void; end(): void };

/**
 * The terminal list's wheel, bound in the capture phase on an element around
 * the list so it is the only handler. react-native-web inverts the list with
 * `scaleY(-1)`, which makes the browser's own vertical wheel scrolling run
 * backwards, and the inverted list adds a listener of its own that cancels
 * every wheel event, sideways ones too.
 *
 * Vertical travel therefore stays here (`move`, positive toward older
 * output). The rest keeps the browser's own scrolling, never cancelled:
 * horizontal and Shift-wheel travel scrolls a wide unwrapped terminal
 * sideways, and Ctrl (a trackpad pinch) is left to WebKit.
 */
export function bindTerminalWheel(element: HTMLElement, options: () => TerminalWheelOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.stopImmediatePropagation();
      return;
    }
    const current = options();
    // Tools cover the terminal: the list's own handler scrolls it, as before.
    if (!current.enabled) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const unit = event.deltaMode === 1 ? current.lineHeight : event.deltaMode === 2 ? current.pageHeight : 1;
    current.move(-event.deltaY * unit);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; options().end(); }, WHEEL_END_MS);
  };
  element.addEventListener('wheel', wheel, { passive: false, capture: true });
  return () => { element.removeEventListener('wheel', wheel, { capture: true }); if (timer) clearTimeout(timer); };
}

/** A pause this long ends a wheel gesture. */
export const WHEEL_END_MS = 160;

export function useTerminalWheel(list: { current: { getScrollableNode(): unknown } | null }, options: TerminalWheelOptions) {
  const latest = useRef(options);
  const bound = useRef<{ element: HTMLElement; unbind: () => void } | null>(null);
  useLayoutEffect(() => { latest.current = options; });
  // After every commit: the list mounts a new scroll node when wrapping is
  // switched (it moves in or out of the sideways scroll view), and the
  // listener has to follow it.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = list.current?.getScrollableNode();
    // On the list's parent, so its capture runs before the list's own handler even when the list itself is the target.
    const element = node instanceof HTMLElement ? node.parentElement ?? node : null;
    if (bound.current?.element === element) return;
    bound.current?.unbind();
    bound.current = element ? { element, unbind: bindTerminalWheel(element, () => latest.current) } : null;
  });
  useEffect(() => () => { bound.current?.unbind(); bound.current = null; }, []);
}
