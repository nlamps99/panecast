import { layoutRow } from '../terminal/layout';

/** GeistMono advances 0.6 em per cell. */
const MONO_ADVANCE_EM = 0.6;
/** Rule and box-drawing characters, plus spaces: the rows `layoutRow` fits instead of wrapping. */
const RULE_LIKE = /^[\s─-╿=-]+$/;

/** How many monospace cells fit across `width` points of text. */
export function outputColumns(width: number, fontSize: number): number {
  return Math.max(10, Math.floor((width - 1) / (fontSize * MONO_ADVANCE_EM)));
}

/**
 * Terminal output for a text block: rules drawn for the computer's wider pane
 * are cut to the phone's width, as in the terminal view, instead of wrapping
 * into several lines of dashes. Other lines are left for the text to wrap.
 */
export function fitOutputRules(output: string, columns: number): string {
  if (columns <= 0) return output;
  return output.split('\n').map(line => RULE_LIKE.test(line) && line.trim()
    ? layoutRow(line, columns).map(visual => visual.plain).join('\n')
    : line).join('\n');
}
