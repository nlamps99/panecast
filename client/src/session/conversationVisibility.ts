const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const INTERNAL_ORIGINS = new Set(['agent', 'subagent', 'sub_agent', 'harness', 'system', 'developer', 'tool', 'agents_md']);
const ENVELOPE = /^\s*<(?:subagent_notification|agent_notification|agent_message|inter_agent_message|teammate-message|task_notification)(?:\s|>)/i;
const CONTEXT = /^\s*<(environment_context|system-reminder|permissions|user_instructions|turn_aborted|context|instructions)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i;

/** Match protocol envelopes only. Mentions and quoted examples remain user text. */
export function visibleUserText(value: string): string | null {
  let text = value;
  if (ENVELOPE.test(text) || /^\s*Message Type:\s*(?:MESSAGE|FINAL_ANSWER)\s*\nTask name:/i.test(text)) return null;
  if (/^\s*# AGENTS\.md instructions/.test(text)) return null;
  let stripped;
  while ((stripped = text.replace(CONTEXT, '')) !== text) text = stripped;
  if (/^\s*<(?:environment_context|permissions instructions|system-reminder|local-command-caveat)(?:\s|>)/i.test(text)) return null;
  const reply = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (reply) {
    try {
      const answers: unknown = JSON.parse(reply[1]);
      if (Array.isArray(answers)) text = answers.slice(0, 20).map(record).filter(a => typeof a.answer === 'string')
        .map(a => [typeof a.question === 'string' ? a.question : '', a.answer].filter(Boolean).join('\n')).join('\n\n');
    } catch { return null; }
  }
  return text.trim() ? text : null;
}

/** Typed provenance is checked before preview truncation loses its envelope. */
export function conversationUserText(value: unknown): string | null {
  const item = record(value), source = record(item.source), provenance = record(item.provenance);
  if (item.isMeta || item.isSidechain || item.isCompactSummary || source.subagent || source.subAgent
    || INTERNAL_ORIGINS.has(String(source.type ?? item.source ?? provenance.type))) return null;
  let metadata = item.internal_chat_message_metadata_passthrough;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
  const meta = record(metadata);
  const origins = Array.isArray(meta.content_item_metadata) ? meta.content_item_metadata : [];
  const kinds = Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : [];
  const parts = Array.isArray(item.content) ? item.content : typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : [];
  const text = parts.flatMap((part, index) => {
    const p = record(part), origin = record(record(origins[index]).provenance).type;
    if (INTERNAL_ORIGINS.has(String(origin)) || (typeof kinds[index] === 'string' && /^(?:agents_md|environments|harness|subagent)\./.test(kinds[index]))) return [];
    if (['image', 'localImage', 'input_image'].includes(String(p.type))) return ['[图片]'];
    if (!['text', 'input_text', 'output_text'].includes(String(p.type)) || typeof p.text !== 'string') return [];
    const visible = visibleUserText(p.text);
    return visible === null ? [] : [visible];
  }).join('\n');
  return text.trim() ? text : null;
}
