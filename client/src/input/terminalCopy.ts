import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Marks one terminal line for `terminalSelectionText` (rendered as `data-terminal-line`). */
export const TERMINAL_LINE_DATA = { dataSet: { terminalLine: '1' } } as object;

type LineGeometry = { element: Element; top: number };

function lineOf(node: Node | null, container: Element): Element | null {
  let current: Node | null = node;
  while (current && current !== container) {
    if (current.nodeType === 1 && (current as Element).hasAttribute('data-terminal-line')) return current as Element;
    current = current.parentNode;
  }
  return null;
}

function offsetIn(line: Element, node: Node, offset: number): number {
  const range = line.ownerDocument.createRange();
  range.setStart(line, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * The text a mouse selection covers, in reading order. The terminal is an
 * inverted list (newest line first in the document), so the browser's own
 * copy reverses the lines and takes the wrong ends of the first and last
 * one. This follows where the drag started and ended on screen instead.
 * Returns null when the browser's copy is already right (one line) or the
 * selection is not in the terminal.
 */
export function terminalSelectionText(container: Element, selection: Selection): string | null {
  if (selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  const anchor = lineOf(selection.anchorNode, container), focus = lineOf(selection.focusNode, container);
  if (!anchor || !focus || anchor === focus) return null;
  const geometry = (element: Element): LineGeometry => ({ element, top: element.getBoundingClientRect().top });
  const lines = Array.from(container.querySelectorAll('[data-terminal-line]')).map(geometry).sort((a, b) => a.top - b.top);
  const start = geometry(anchor), end = geometry(focus);
  const [first, firstOffset, last, lastOffset] = start.top <= end.top
    ? [anchor, offsetIn(anchor, selection.anchorNode, selection.anchorOffset), focus, offsetIn(focus, selection.focusNode, selection.focusOffset)]
    : [focus, offsetIn(focus, selection.focusNode, selection.focusOffset), anchor, offsetIn(anchor, selection.anchorNode, selection.anchorOffset)];
  const top = Math.min(start.top, end.top), bottom = Math.max(start.top, end.top);
  const text = (element: Element) => element.textContent ?? '';
  const pieces = [text(first).slice(firstOffset)];
  for (const line of lines) if (line.top > top && line.top < bottom) pieces.push(text(line.element));
  pieces.push(text(last).slice(0, lastOffset));
  return pieces.map((piece) => piece.replace(/\s+$/, '')).join('\n');
}

/** Puts a multi-line terminal selection on the clipboard in reading order (web and desktop). */
export function useTerminalCopy(list: { current: { getScrollableNode(): unknown } | null }, enabled: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled || typeof document === 'undefined' || typeof Element === 'undefined') return;
    const node = list.current?.getScrollableNode();
    if (!(node instanceof Element)) return;
    const copy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      const text = selection ? terminalSelectionText(node, selection) : null;
      if (text === null || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    };
    document.addEventListener('copy', copy);
    return () => document.removeEventListener('copy', copy);
  }, [list, enabled]);
}
