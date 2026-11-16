/** Keep explicit terminal decisions visible even when execution details are folded. */
export type TerminalDecision = { id: string; title: string; text: string; options: { number: number; label: string }[]; selectedIndex: number | null; multiSelect: boolean; multipleQuestions: boolean };

/** A decision must have both numbered choices and a current keyboard hint. */
export function terminalDecision(rows: readonly string[]): TerminalDecision | null {
  const lines = rows.slice(-50).map(row => row.trimEnd());
  const hint = /(?:enter|return|回车).*(?:select|confirm|submit|continue|选择|确认|提交)|(?:esc|escape).*(?:cancel|dismiss|取消)|space to (?:select|toggle)/i;
  const footer = lines.findLastIndex(line => hint.test(line));
  if (footer < 0 || lines.slice(footer + 1).some(line => line.trim() && !/^[\s─━═│└┘┌┐┬┴┤├┼╰╯╭╮]+$/.test(line))) return null;
  const choices: TerminalDecision['options'] = [];
  let first = -1, selectedIndex: number | null = null;
  for (let index = Math.max(0, footer - 35); index < footer; index++) {
    const match = /^\s*([›❯>→●])?\s*(\d{1,2})[.)]\s+(.+)$/.exec(lines[index]);
    if (match) {
      if (first < 0) first = index;
      if (match[1]) selectedIndex = choices.length;
      choices.push({ number: Number(match[2]), label: match[3] });
    } else if (choices.length && /^\s{3,}\S/.test(lines[index]) && !hint.test(lines[index])) choices.at(-1)!.label += `\n${lines[index].trim()}`;
  }
  if (choices.length < 2 || choices.length > 12 || choices.some((choice, i) => i > 0 && choice.number !== choices[i - 1].number + 1)) return null;
  const heading = lines.slice(Math.max(0, first - 6), first).filter(line => line.trim() && !/^[\s─━═│└┘┌┐┬┴┤├┼╰╯╭╮]+$/.test(line));
  const title = heading.at(-1)?.trim() ?? '请选择';
  const text = [...heading, ...lines.slice(first, footer + 1)].join('\n').slice(-4000);
  return { id: JSON.stringify([heading, choices]), title, text, options: choices, selectedIndex,
    multiSelect: /space.*(?:select|toggle)|空格.*(?:选择|勾选)/i.test(lines[footer]),
    multipleQuestions: lines.slice(Math.max(0, first - 6), footer + 1).some(line => /(?:tab|←|→|left|right).*(?:question|问题)|question \d+.*\d+/i.test(line)) };
}

export function terminalPrompt(rows: readonly string[]): string | null {
  const tail = rows.slice(-36).join('\n').trim();
  const question = /(?:would you like to (?:run|allow|proceed)|do you want to (?:proceed|allow)|allow (?:this|once)|需要你的(?:确认|批准)|是否(?:允许|继续|执行))/i;
  const choices = /(?:\b(?:yes|no|approve|reject|esc to cancel)\b|\[y\/n\]|允许一次|拒绝|同意)/i;
  const lines = tail.split('\n');
  const index = lines.findLastIndex(line => question.test(line));
  if (index < 0) return null;
  const prompt = lines.slice(Math.max(0, index - 2)).join('\n');
  return choices.test(prompt) ? prompt.slice(-3000) : null;
}
