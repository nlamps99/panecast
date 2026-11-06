import { indentSelection } from '../composerEdits';

it('does not modify marked composition', () => {
  expect(indentSelection({ text: 'zhong', composing: true, selectionStart: 0, selectionEnd: 5 }, false)).toBeNull();
});
it('indents a multiline selection without including the next line at a trailing newline', () => {
  const edit = indentSelection({ text: 'first\nsecond\nthird', composing: false, selectionStart: 0, selectionEnd: 13 }, false)!;
  expect(edit.text).toBe('  first\n  second\nthird');
  expect(edit.text.slice(edit.selectionStart, edit.selectionEnd)).toBe('first\n  second\n');
});
it('outdents tabs and spaces while preserving a CJK and emoji selection', () => {
  const text = '  中文🙂\n\t第二行';
  const edit = indentSelection({ text, composing: false, selectionStart: 2, selectionEnd: text.length }, true)!;
  expect(edit.text).toBe('中文🙂\n第二行');
  expect(edit.selectionStart).toBe(0); expect(edit.selectionEnd).toBe(edit.text.length);
});
it('handles an empty first line, a caret inside indentation, and a final empty line', () => {
  expect(indentSelection({ text: '\nnext', composing: false, selectionStart: 0, selectionEnd: 0 }, false)).toEqual({ text: '  \nnext', selectionStart: 2, selectionEnd: 2 });
  expect(indentSelection({ text: '  code', composing: false, selectionStart: 1, selectionEnd: 1 }, true)).toEqual({ text: 'code', selectionStart: 0, selectionEnd: 0 });
  expect(indentSelection({ text: 'a\n', composing: false, selectionStart: 2, selectionEnd: 2 }, false)).toEqual({ text: 'a\n  ', selectionStart: 4, selectionEnd: 4 });
});
