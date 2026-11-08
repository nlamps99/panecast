/** Keep explicit terminal decisions visible even when execution details are folded. */
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
