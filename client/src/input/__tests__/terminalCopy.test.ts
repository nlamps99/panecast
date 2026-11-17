import { JSDOM } from 'jsdom';
import { terminalSelectionText } from '../terminalCopy';

const dom = new JSDOM('<!doctype html><body></body>');
const document = dom.window.document;
const window = dom.window;

/** An inverted list: the newest line comes first in the document but is drawn lowest. */
function terminal(lines: string[]) {
  const container = document.createElement('div');
  const elements = [...lines].reverse().map((text, index) => {
    const line = document.createElement('span');
    line.setAttribute('data-terminal-line', '1');
    line.textContent = text;
    const top = (lines.length - 1 - index) * 20;
    line.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, height: 20, width: 100, x: 0, y: top, toJSON: () => null });
    container.appendChild(line);
    return line;
  });
  document.body.appendChild(container);
  return { container, byText: (text: string) => elements.find((element) => element.textContent === text)!.firstChild! };
}

it('copies a drag from the second word of the top line to the middle of the third line in reading order', () => {
  const { container, byText } = terminal(['first line', 'second line   ', 'third line']);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(byText('first line'), 6, byText('third line'), 5);
  expect(terminalSelectionText(container, selection)).toBe('line\nsecond line\nthird');
  // Dragging upward selects the same text.
  selection.setBaseAndExtent(byText('third line'), 5, byText('first line'), 6);
  expect(terminalSelectionText(container, selection)).toBe('line\nsecond line\nthird');
});

it('leaves single-line and outside selections to the browser', () => {
  const { container, byText } = terminal(['only line', 'next']);
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(byText('only line'), 0, byText('only line'), 4);
  expect(terminalSelectionText(container, selection)).toBeNull();
  const outside = document.createElement('p'); outside.textContent = 'elsewhere'; document.body.appendChild(outside);
  selection.setBaseAndExtent(outside.firstChild!, 0, byText('next'), 2);
  expect(terminalSelectionText(container, selection)).toBeNull();
});
