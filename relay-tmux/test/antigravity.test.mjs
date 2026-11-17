import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConversation, TerminalConversationReader } from '../src/hub/terminal-conversation.mjs';
import { AntigravityProcesses } from '../src/hub/antigravity.mjs';

const id = '6f1c2a44-8d1e-4f5a-9b7c-2e3d4f5a6b7c';
const surface = 'A1B2C3D4-0000-4000-8000-000000000001', workspace = 'A1B2C3D4-0000-4000-8000-0000000000aa';
const line = (step, type, fields = {}) => ({ step_index: step, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', created_at: '2026-11-17T07:00:00Z', ...fields });
const records = (values) => values.map((value, index) => ({ value, offset: index * 100 }));
const transcript = [
  line(0, 'SYSTEM_MESSAGE', { source: 'SYSTEM', content: 'You are Antigravity.' }),
  line(1, 'USER_INPUT', { content: '<USER_REQUEST>\n修一下滚动\n</USER_REQUEST>\n<ADDITIONAL_METADATA>cwd: /tmp</ADDITIONAL_METADATA>' }),
  line(2, 'PLANNER_RESPONSE', { status: 'RUNNING', content: '先看看' }),
  line(2, 'PLANNER_RESPONSE', { thinking: 'private', content: '先看看代码', tool_calls: [
    { name: 'run_command', args: { CommandLine: '"git status"', Cwd: '"/tmp"' } },
    { name: 'view_file', args: { AbsolutePath: '"/tmp/a.ts"' } }] }),
  line(3, 'GENERIC', { content: 'On branch main' }),
  line(4, 'GENERIC', { status: 'ERROR', error: 'not found', content: 'no such file' }),
  line(5, 'EPHEMERAL_MESSAGE', { source: 'SYSTEM', content: 'reminder' }),
  line(6, 'CHECKPOINT', { source: 'SYSTEM', content: 'summary of earlier turns' }),
  line(7, 'PLANNER_RESPONSE', { content: '已修好。' }),
];

test('Antigravity steps become prompts, replies and tool calls paired with their results in order', () => {
  const parsed = parseConversation(records(transcript), 'antigravity', id);
  assert.deepEqual(parsed.items.map((item) => item.type), ['userMessage', 'agentMessage', 'commandExecution', 'toolExecution', 'agentMessage']);
  const [prompt, reply, shell, view, last] = parsed.items;
  assert.equal(prompt.content[0].text, '修一下滚动');
  assert.equal(reply.text, '先看看代码');
  assert.equal(view.tool, 'view_file');
  assert.equal(view.aggregatedOutput, 'no such file');
  assert.equal(last.text, '已修好。');
  assert.equal(reply.phase, 'commentary');
  assert.equal(shell.command, 'git status');
  assert.equal(shell.aggregatedOutput, 'On branch main');
  assert.equal(shell.status, 'completed');
  assert.equal(view.status, 'failed');
  assert.equal(last.phase, 'final');
  assert.equal(parsed.active, false);
  assert.ok(!JSON.stringify(parsed.items).includes('private'), 'thinking stays on the computer');
  assert.ok(!JSON.stringify(parsed.items).includes('reminder'));
  // A turn whose reply is still running is active.
  assert.equal(parseConversation(records(transcript.slice(0, 3)), 'antigravity', id).active, true);
});

test('the reader finds a conversation by its folder and pages it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'panecast-agy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs');
  await mkdir(folder, { recursive: true });
  const many = Array.from({ length: 60 }, (_, i) => [line(i * 2, 'USER_INPUT', { content: `<USER_REQUEST>question ${i}</USER_REQUEST>` }), line(i * 2 + 1, 'PLANNER_RESPONSE', { content: `answer ${i}` })]).flat();
  await writeFile(join(folder, 'transcript.jsonl'), many.map((value) => JSON.stringify(value)).join('\n') + '\n');
  const reader = new TerminalConversationReader({ home });
  const binding = { kind: 'antigravity', checkpoint_id: id, execution_location: 'local' };
  const head = await reader.read(binding, { limit: 20 });
  assert.equal(head.available, true);
  assert.equal(head.name, 'Antigravity');
  assert.equal(head.items.at(-1).text, 'answer 59');
  const all = [...head.items]; let cursor = head.next_cursor;
  while (cursor) { const page = await reader.read(binding, { cursor, limit: 20 }); all.unshift(...page.items); cursor = page.next_cursor; }
  assert.equal(new Set(all.map((item) => item.id)).size, 120);
  assert.equal(reader.pages.size, 0, 'a transcript compaction may rewrite older lines, so pages are not cached');
  assert.equal((await reader.read({ ...binding, checkpoint_id: '00000000-0000-4000-8000-000000000000' })).available, false);
});

function fakeRun(processes) {
  return async (file, args) => {
    if (file === 'ps' && args[0] === '-axo') return { stdout: Object.entries(processes).map(([pid, p]) => `${pid} ${p.comm}`).join('\n') };
    const pid = args[args.indexOf('-p') + 1], p = processes[pid];
    if (!p) throw Object.assign(new Error('gone'), { stdout: '' });
    if (file === 'ps' && args[0] === 'ww') return { stdout: `${p.command}\n` };
    if (file === 'ps' && args[0] === 'eww') return { stdout: `${p.command} ${p.env}\n` };
    if (file === 'lsof') return { stdout: (p.files ?? []).map((path) => `n${path}`).join('\n') };
    throw new Error(`unexpected ${file}`);
  };
}

test('an agy process names its terminal and conversation by argument or presence lock', async () => {
  const env = `CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface} HOME=/Users/x`;
  const byArgument = new AntigravityProcesses(fakeRun({
    101: { comm: '/bin/zsh', command: '-zsh', env },
    202: { comm: '/Users/x/.local/bin/agy', command: `agy --conversation ${id.toUpperCase()}`, env },
  }));
  assert.deepEqual(await byArgument.binding(workspace.toLowerCase(), surface.toLowerCase()), { kind: 'antigravity', checkpoint_id: id, execution_location: 'local' });
  assert.equal(await byArgument.binding(workspace, 'A1B2C3D4-0000-4000-8000-0000000000ff'), null);
  const byLock = new AntigravityProcesses(fakeRun({
    303: { comm: 'agy', command: 'agy', env, files: ['/Users/x/.gemini/antigravity-cli/conversations/x.db', `/Users/x/.gemini/antigravity-cli/presence/${id}.lock`] },
  }));
  assert.equal((await byLock.binding(workspace, surface))?.checkpoint_id, id);
  const none = new AntigravityProcesses(fakeRun({ 404: { comm: 'node', command: 'node server.js', env } }));
  assert.equal(await none.binding(workspace, surface), null);
});
