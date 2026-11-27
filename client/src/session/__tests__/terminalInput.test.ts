import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { INPUT_ERROR_HOLD_MS, INPUT_STALL_MS, inputBatches, pastePieces, sourceOf, TerminalSession, type RpcChannel } from '../terminalSession';

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A hub with `surface.input`; `answer` decides each call (undefined: left pending). */
class Hub implements RpcChannel {
  isOpen = true;
  calls: Call[] = [];
  answer: (call: Call) => unknown = () => ({});
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private pushListeners = new Set<(frame: PushFrame) => void>();
  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isOpen) return Promise.reject(new RpcCallError('not_connected', 'offline'));
    return new Promise<T>((resolve, reject) => {
      const call: Call = { method, params, resolve: resolve as (v: unknown) => void, reject };
      this.calls.push(call);
      if (['surface.subscribe', 'surface.unsubscribe'].includes(method)) { queueMicrotask(() => resolve({} as T)); return; }
      queueMicrotask(() => {
        try {
          const value = this.answer(call);
          if (value !== undefined) resolve(value as T);
        } catch (error) { reject(error); }
      });
    });
  }
  onPush(listener: (frame: PushFrame) => void) { this.pushListeners.add(listener); return () => this.pushListeners.delete(listener); }
  /** A whole new screen for the terminal. */
  show(rows: string[], rev: number) {
    const frame: PushFrame = { type: 'screen.diff', surfaceId: 'cmux~s1', rev, ops: [{ op: 'clear' }, ...rows.map((text, y) => ({ op: 'row' as const, y, text })), { op: 'cursor', x: 0, y: 0 }] };
    for (const listener of this.pushListeners) listener(frame);
  }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  status(status: ConnectionStatus) { this.isOpen = status.state === 'open'; for (const listener of this.statusListeners) listener(status); }
  sent(method: string) { return this.calls.filter((call) => call.method === method); }
}

const target = { workspaceId: 'w1', surfaceId: 'cmux~s1' };
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const refuse = (code: string) => () => { throw new RpcCallError(code, code); };

async function open(hub = new Hub()) {
  const session = new TerminalSession(hub);
  session.setTarget(target);
  await flush();
  return { hub, session };
}

describe('pasting', () => {
  it('pastes multi-line text whole, without pressing Enter', async () => {
    const { hub, session } = await open();
    await expect(session.pasteText('echo one\r\necho two', [{ kind: 'text', text: 'never' }])).resolves.toMatchObject({ status: 'sent' });
    expect(hub.sent('terminal.paste').map((call) => call.params)).toEqual([{ workspace_id: 'w1', surface_id: 'cmux~s1', text: 'echo one\necho two' }]);
    expect(hub.sent('surface.input')).toHaveLength(0);
  });

  it('types the fallback where the hub refuses a paste without a submit key, and remembers that for the source', async () => {
    const { hub, session } = await open();
    hub.answer = (call) => call.method === 'terminal.paste' && call.params.submit_key !== 'return' ? refuse('invalid_params')() : {};
    await expect(session.pasteText('\n', [{ kind: 'key', key: { name: 'enter', modifiers: ['shift'] } }])).resolves.toMatchObject({ status: 'sent' });
    expect(hub.sent('surface.input').map((call) => call.params.items)).toEqual([[{ key: 'shift-enter' }]]);
    await session.pasteText('\n', [{ kind: 'key', key: { name: 'enter', modifiers: ['shift'] } }]);
    expect(hub.sent('terminal.paste')).toHaveLength(1);
    // The refusal was for that shape only: a submitted multi-line line still pastes.
    await expect(session.submitLine('a\nb')).resolves.toMatchObject({ status: 'sent' });
    expect(hub.sent('terminal.paste').at(-1)?.params).toMatchObject({ text: 'a\nb', submit_key: 'return' });
  });

  it('falls back for every paste of a source without the method (tmux), and asks again after reconnecting', async () => {
    const { hub, session } = await open();
    hub.answer = (call) => call.method === 'terminal.paste' ? refuse('method_not_found')() : {};
    await session.submitLine('a\nb');
    await session.pasteText('c\nd', [{ kind: 'text', text: 'c' }]);
    expect(hub.sent('terminal.paste')).toHaveLength(1);
    expect(hub.sent('surface.input').map((call) => call.params.items)).toEqual([[{ text: 'a\nb' }, { key: 'enter' }], [{ text: 'c' }]]);
    hub.status({ state: 'connecting', attempt: 1 });
    hub.status({ state: 'open' });
    await flush();
    await session.pasteText('e\nf', null);
    expect(hub.sent('terminal.paste')).toHaveLength(2);
  });

  it('does not send a paste that has no fallback where the computer cannot paste', async () => {
    const { hub, session } = await open();
    hub.answer = (call) => call.method === 'terminal.paste' ? refuse('invalid_params')() : {};
    await expect(session.pasteText('a\nb', null)).resolves.toMatchObject({ status: 'not_sent' });
    await expect(session.submitLine('x\ny', { paste: true })).resolves.toMatchObject({ status: 'not_sent' });
    expect(hub.sent('surface.input')).toHaveLength(0);
  });

  it('splits long text into pastes in order, and only the last submits', async () => {
    const { hub, session } = await open();
    const text = `${'a'.repeat(59_990)}\n${'b'.repeat(70_000)}`;
    await session.submitLine(text);
    const pastes = hub.sent('terminal.paste').map((call) => call.params);
    expect(pastes.map((params) => (params.text as string).length)).toEqual([59_991, 60_000, 10_000]);
    expect(pastes.map((params) => params.submit_key)).toEqual([undefined, undefined, 'return']);
    expect(pastes.map((params) => params.text).join('')).toBe(text);
  });

  it('reports a paste whose Enter did not go, and a hub that submitted a paste it was not asked to', async () => {
    const { hub, session } = await open();
    hub.answer = (call) => call.method === 'terminal.paste' ? { submitted: call.params.submit_key !== 'return' ? true : false } : {};
    await expect(session.submitLine('a\nb')).resolves.toEqual({ status: 'sent', message: '已粘贴到终端，但回车没有按下，请在终端里按一次回车' });
    await expect(session.pasteText('c\nd', [{ kind: 'text', text: 'cd' }])).resolves.toMatchObject({ status: 'unknown' });
    expect(session.getState().input.error).toContain('按下了回车');
    // Not trusted with a paste again: the next one is typed.
    await session.pasteText('e\nf', [{ kind: 'text', text: 'ef' }]);
    expect(hub.sent('terminal.paste')).toHaveLength(2);
    expect(hub.sent('surface.input').at(-1)?.params.items).toEqual([{ text: 'ef' }]);
  });

  it('keeps a single-line command on surface.input', async () => {
    const { hub, session } = await open();
    await session.submitLine('git status');
    expect(hub.sent('terminal.paste')).toHaveLength(0);
    expect(hub.sent('surface.input')[0].params.items).toEqual([{ text: 'git status' }, { key: 'enter' }]);
  });
});

describe('queue', () => {
  it('drops what was typed after a batch that failed, and says so for a while', async () => {
    const { hub, session } = await open();
    let first = true;
    hub.answer = (call) => {
      if (call.method !== 'surface.input') return {};
      if (first) { first = false; return undefined; }
      return {};
    };
    session.sendText('ls');
    await flush();
    session.sendText(' -la');
    session.sendKey({ name: 'enter' });
    hub.sent('surface.input')[0].reject(new RpcCallError('timeout', 'surface.input 超时'));
    await flush();
    // Never resent, and the Enter behind it never runs a line that may be missing `ls`.
    expect(hub.sent('surface.input').map((call) => call.params.items)).toEqual([[{ text: 'ls' }]]);
    expect(session.getState().input).toEqual({ busy: false, error: '输入没有确认送达：电脑没有响应，请稍后再试，之后的输入已取消。请先查看终端，需要时再输入一次' });
    // New typing goes; the message stays a while, then a new round starts clean.
    session.sendText('x');
    await flush();
    expect(hub.sent('surface.input').at(-1)?.params.items).toEqual([{ text: 'x' }]);
    expect(session.getState().input.error).not.toBeNull();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + INPUT_ERROR_HOLD_MS);
    try {
      session.sendText('y');
      await flush();
      expect(session.getState().input.error).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it('splits a huge burst into requests the hub accepts', async () => {
    const { hub, session } = await open();
    let first = true;
    hub.answer = (call) => {
      if (call.method === 'surface.input' && first) { first = false; return undefined; }
      return {};
    };
    session.sendText('first');
    await flush();
    for (let line = 0; line < 400; line++) { session.sendText(`line ${line}`); session.sendKey({ name: 'enter' }); }
    hub.sent('surface.input')[0].resolve({});
    await flush();
    const batches = hub.sent('surface.input').slice(1).map((call) => call.params.items as unknown[]);
    expect(batches.map((items) => items.length)).toEqual([500, 300]);
  });

  it('shows a send that takes long, and nothing for one that answers quickly', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    try {
      const { hub, session } = await open();
      hub.answer = (call) => call.method === 'surface.input' ? undefined : {};
      session.sendText('a');
      await flush();
      jest.advanceTimersByTime(INPUT_STALL_MS - 1);
      expect(session.getState().input.busy).toBe(false);
      jest.advanceTimersByTime(1);
      expect(session.getState().input.busy).toBe(true);
      hub.sent('surface.input')[0].resolve({});
      await flush();
      expect(session.getState().input).toEqual({ busy: false, error: null });
    } finally { jest.useRealTimers(); }
  });

  it('queues question keys pressed in quick succession, in order, while the highlight moves', async () => {
    const { hub, session } = await open();
    const question = (selected: number) => ['Do you want to proceed?', ...['Yes', 'No', 'Maybe'].map((label, index) => `${index === selected ? '❯' : ' '} ${index + 1}. ${label}`), 'Enter to select · Esc to cancel'];
    hub.show(question(0), 1);
    hub.answer = (call) => call.method === 'surface.input' ? undefined : {};
    const seen = session.getState().screen;
    const receipts = [session.sendPromptKeys([{ name: 'down' }], seen), session.sendPromptKeys([{ name: 'down' }], seen), session.sendPromptKeys([{ name: 'enter' }], seen)];
    await flush();
    hub.sent('surface.input')[0].resolve({});
    hub.show(question(1), 2);
    await flush();
    hub.sent('surface.input')[1].resolve({});
    await flush();
    hub.sent('surface.input')[2].resolve({});
    await expect(Promise.all(receipts)).resolves.toMatchObject([{ status: 'sent' }, { status: 'sent' }, { status: 'sent' }]);
    expect(hub.sent('surface.input').map((call) => call.params.items)).toEqual([[{ key: 'down' }], [{ key: 'down' }], [{ key: 'enter' }]]);
  });

  it('does not send a queued question key once the terminal asks something else', async () => {
    const { hub, session } = await open();
    hub.show(['Pick one', '❯ 1. Red', '  2. Blue', 'Enter to select'], 1);
    hub.answer = (call) => call.method === 'surface.input' ? undefined : {};
    const seen = session.getState().screen;
    const first = session.sendPromptKeys([{ name: 'enter' }], seen), second = session.sendPromptKeys([{ name: 'enter' }], seen);
    await flush();
    hub.show(['Delete everything?', '❯ 1. Yes', '  2. No', 'Enter to confirm'], 2);
    hub.sent('surface.input')[0].resolve({});
    await expect(first).resolves.toMatchObject({ status: 'sent' });
    await expect(second).resolves.toMatchObject({ status: 'not_sent' });
    expect(hub.sent('surface.input')).toHaveLength(1);
  });

  it('redraws for a burst of typing at most once a second, not on every key', async () => {
    const { hub, session } = await open();
    hub.answer = () => ({});
    let updates = 0;
    session.subscribe(() => updates++);
    for (const char of 'hello') { session.sendText(char); await flush(); }
    expect(hub.sent('surface.input')).toHaveLength(5);
    expect(session.getState().inputRevision).toBe(1);
    expect(updates).toBe(1);
  });
});

describe('request shapes', () => {
  it('cuts pastes after a line break in the second half, and never inside a surrogate pair', () => {
    expect(pastePieces('', 10)).toEqual(['']);
    expect(pastePieces('abc\ndefghijkl', 10)).toEqual(['abc\ndefghi', 'jkl']);
    expect(pastePieces('abcdefg\nhijkl', 10)).toEqual(['abcdefg\n', 'hijkl']);
    expect(pastePieces('abcdefghi😀z', 10)).toEqual(['abcdefghi', '😀z']);
  });

  it('keeps surface.input requests within the item and text limits', () => {
    expect(inputBatches([{ text: 'abcdef' }, { key: 'enter' }, { text: 'gh' }], 2, 4)).toEqual([[{ text: 'abcd' }], [{ text: 'ef' }, { key: 'enter' }], [{ text: 'gh' }]]);
    expect(inputBatches([{ text: 'ab😀' }], 10, 3)).toEqual([[{ text: 'ab' }], [{ text: '😀' }]]);
    expect(inputBatches([{ text: 'abcde' }], 10, 100, 2)).toEqual([[{ text: 'ab' }, { text: 'cd' }, { text: 'e' }]]);
  });

  it('reads the source from a hub surface id', () => {
    expect(sourceOf('cmux~ABC')).toBe('cmux');
    expect(sourceOf('5F0C-UUID')).toBe('');
  });
});
