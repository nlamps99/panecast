import { FLAG_BOLD, FLAG_INVERSE, FLAG_UNDERLINE, parseAnsiRow } from '../ansi';
import { buildInvertedLines, LayoutCache, layoutRow } from '../layout';
import { styleForAttr } from '../palette';

const plain = (row: string, columns: number) => layoutRow(row, columns).map((line) => line.plain);

describe('parseAnsiRow', () => {
  it('parses 16, 256 and truecolor SGR', () => {
    const cells = parseAnsiRow('\u001b[1;31mA\u001b[38;5;208mB\u001b[38;2;1;2;3;48;5;17mC\u001b[0mD');
    expect(cells.map((c) => c.text).join('')).toBe('ABCD');
    expect(cells[0].attr).toMatchObject({ fg: { kind: 'index', value: 1 }, flags: FLAG_BOLD });
    expect(cells[1].attr.fg).toEqual({ kind: 'index', value: 208 });
    expect(cells[2].attr.fg).toEqual({ kind: 'rgb', value: 0x010203 });
    expect(cells[2].attr.bg).toEqual({ kind: 'index', value: 17 });
    expect(cells[3].attr).toMatchObject({ fg: null, bg: null, flags: 0 });
  });

  it('parses colon sub-parameters and bright colors', () => {
    const cells = parseAnsiRow('\u001b[38:2::10:20:30mA\u001b[4:3;92mB\u001b[4:0mC');
    expect(cells[0].attr.fg).toEqual({ kind: 'rgb', value: 0x0a141e });
    expect(cells[1].attr).toMatchObject({ fg: { kind: 'index', value: 10 }, flags: FLAG_UNDERLINE });
    expect(cells[2].attr.flags & FLAG_UNDERLINE).toBe(0);
  });

  it('interns equal attributes', () => {
    const a = parseAnsiRow('\u001b[31mx');
    const b = parseAnsiRow('\u001b[0;31my');
    expect(a[0].attr).toBe(b[0].attr);
  });

  it('skips other escape sequences and control characters', () => {
    const text = 'a\u001b[2Kb\u001b]0;title\u0007c\u001b]8;;https://x\u001b\\d\u001b(Be\u0008f\u0000';
    expect(parseAnsiRow(text).map((c) => c.text).join('')).toBe('abcdef');
  });

  it('expands tabs to the next stop', () => {
    expect(parseAnsiRow('ab\tc').map((c) => c.text).join('')).toBe('ab      c');
  });

  it('measures wide and combining characters', () => {
    const cells = parseAnsiRow('a你é🚀👍🏽');
    expect(cells.map((c) => [c.text, c.width])).toEqual([
      ['a', 1],
      ['你', 2],
      ['é', 1],
      ['🚀', 2],
      ['👍🏽', 2],
    ]);
  });

  it('keeps ZWJ emoji sequences in one cell', () => {
    const cells = parseAnsiRow('👨‍👩‍👧x');
    expect(cells).toHaveLength(2);
    expect(cells[1].text).toBe('x');
  });
});

describe('layoutRow', () => {
  it('wraps at word boundaries', () => {
    expect(plain('the quick brown fox jumps', 10)).toEqual(['the quick ', 'brown fox ', 'jumps']);
  });

  it('drops the space that would start a continuation line', () => {
    expect(plain('aaaa bbbb', 4)).toEqual(['aaaa', 'bbbb']);
  });

  it('splits words longer than a line', () => {
    expect(plain('/usr/local/lib/node_modules', 10)).toEqual(['/usr/local', '/lib/node_', 'modules']);
    expect(plain('ab verylongword', 6)).toEqual(['ab ver', 'ylongw', 'ord']);
  });

  it('breaks between CJK characters and never splits a wide character', () => {
    expect(plain('你好世界你好', 5)).toEqual(['你好', '世界', '你好']);
    expect(plain('ab你好', 4)).toEqual(['ab你', '好']);
  });

  it('trims the trailing padding cmux adds to every row', () => {
    expect(plain(`$ ls${' '.repeat(140)}`, 40)).toEqual(['$ ls']);
    expect(layoutRow(' '.repeat(150), 40)).toHaveLength(1);
  });

  it('keeps trailing spaces that carry a background', () => {
    expect(plain(`a\u001b[7m   \u001b[0m${' '.repeat(10)}`, 40)).toEqual(['a   ']);
  });

  it('truncates rows made only of rule characters to the screen width', () => {
    expect(plain('─'.repeat(150), 40)).toEqual(['─'.repeat(40)]);
    expect(plain(`  ${'='.repeat(100)}`, 30)).toEqual([`  ${'='.repeat(28)}`]);
    expect(plain(`\u001b[2m${'━'.repeat(80)}\u001b[0m`, 20)).toEqual(['━'.repeat(20)]);
  });

  it('wraps rule-like rows that contain other text', () => {
    expect(plain(`── Title ${'─'.repeat(40)}`, 20)).toHaveLength(3);
  });

  it('merges cells into spans by attribute', () => {
    const [line] = layoutRow('ab\u001b[1mcd\u001b[0mef', 40);
    expect(line.spans.map((s) => [s.text, s.attr.flags])).toEqual([
      ['ab', 0],
      ['cd', FLAG_BOLD],
      ['ef', 0],
    ]);
  });

  it('asks for text presentation of emoji-prone symbols', () => {
    const [line] = layoutRow('⏺ done ✔', 40);
    expect(line.spans[0].text).toBe('●︎ done ✔︎');
    expect(line.plain).toBe('⏺ done ✔');
  });
});

describe('buildInvertedLines', () => {
  it('lists visual lines bottom-up and drops blank rows at the bottom', () => {
    const cache = new LayoutCache();
    const lines = buildInvertedLines(['one two three', '$ ', '   ', ''], 8, cache, { trimBottom: true });
    expect(lines.map((l) => l.plain)).toEqual(['$', 'three', 'one two ']);
  });

  it('reuses cached lines for unchanged rows', () => {
    const cache = new LayoutCache();
    const a = buildInvertedLines(['x', 'y'], 10, cache, { trimBottom: false });
    const b = buildInvertedLines(['x', 'z'], 10, cache, { trimBottom: false });
    expect(b[1]).toBe(a[1]);
  });
});

describe('styleForAttr', () => {
  it('returns null for default text and swaps colors for inverse', () => {
    expect(styleForAttr(parseAnsiRow('x')[0].attr)).toBeNull();
    const inverse = parseAnsiRow('\u001b[7mx')[0].attr;
    expect(inverse.flags).toBe(FLAG_INVERSE);
    expect(styleForAttr(inverse)).toEqual({ color: '#1a1b26', backgroundColor: '#f1f2f8' });
    expect(styleForAttr(parseAnsiRow('\u001b[38;2;255;0;0mx')[0].attr)).toEqual({ color: '#ff0000' });
  });
});
