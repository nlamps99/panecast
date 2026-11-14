import { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform } from 'react-native';

export type TerminalWheelOptions = { enabled: boolean; lineHeight: number; pageHeight: number; move(pixels: number): void; end(): void };

/** The terminal's inverted list needs the opposite DOM scroll direction. */
export function bindTerminalWheel(element: HTMLElement, options: () => TerminalWheelOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wheel = (event: WheelEvent) => {
    const current = options();
    if (!current.enabled || event.ctrlKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? current.lineHeight : event.deltaMode === 2 ? current.pageHeight : 1;
    current.move(-event.deltaY * unit);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; options().end(); }, 160);
  };
  element.addEventListener('wheel', wheel, { passive: false });
  return () => { element.removeEventListener('wheel', wheel); if (timer) clearTimeout(timer); };
}

export function useTerminalWheel(list: { current: { getScrollableNode(): unknown } | null }, options: TerminalWheelOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = list.current?.getScrollableNode();
    if (node instanceof HTMLElement) return bindTerminalWheel(node, () => latest.current);
  }, [list, options.enabled, options.pageHeight]);
}
