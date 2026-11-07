import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { screenHash } from '../../protocol/screen';
import { parseHistoryPage, stitchFirstPage, TerminalSession, type RpcChannel } from '../terminalSession';
import { readingAnchor } from '../readingPosition';

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

class FakeChannel implements RpcChannel {
  isOpen = true;
  calls: Call[] = [];
  /** Auto-answer these methods with `{}` unless a test answers them itself. */
  autoReply = new Set(['surface.subscribe', 'surface.unsubscribe', 'surface.focus', 'surface.send_text', 'surface.send_key']);
  private pushListeners = new Set<(frame: PushFrame) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isOpen) return Promise.reject(new RpcCallError('not_connected', 'offline'));
    return new Promise<T>((resolve, reject) => {
      const call: Call = { method, params, resolve: resolve as (v: unknown) => void, reject };
      this.calls.push(call);
      if (this.autoReply.has(method)) queueMicrotask(() => resolve({} as T));
    });
  }
  onPush(listener: (frame: PushFrame) => void) {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }
  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  push(frame: PushFrame) {
    for (const listener of this.pushListeners) listener(frame);
  }
  status(status: ConnectionStatus) {
    this.isOpen = status.state === 'open';
    for (const listener of this.statusListeners) listener(status);
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}

const target = { workspaceId: 'w1', surfaceId: 's1' };

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function firstTick(rows: string[], rev = 1): PushFrame {
  return {
    type: 'screen.diff',
    surfaceId: 's1',
    rev,
    ops: [{ op: 'clear' }, ...rows.map((text, y) => ({ op: 'row' as const, y, text })), { op: 'cursor', x: 0, y: 0 }],
  };
}

describe('TerminalSession history prefetch', () => {
  it('shows the prepared first page immediately and shares an in-flight continuation', async () => {
    const channel = new FakeChannel(), session = new TerminalSession(channel);
    channel.autoReply.add('terminal.replay');
    session.setTarget(target); await flush(); channel.push(firstTick(['visible a', 'visible b']));
    await session.inspectScrollMode(); session.prepareHistory();
    const first = channel.calls.find(c => c.method === 'surface.history')!;
    first.resolve({ rows: ['older 2'], anchor_rows: ['visible a', 'visible b'], next_cursor: 'page-1' });
    await flush();
    const second = channel.calls.filter(c => c.method === 'surface.history')[1];
    expect(second.params.cursor).toBe('page-1');
    session.startBrowsing(); await session.loadOlder();
    expect(session.getState().browse?.olderRows).toEqual(['older 2']);
    const more = session.loadOlder();
    expect(channel.calls.filter(c => c.method === 'surface.history')).toHaveLength(2);
    second.resolve({ rows: ['older 1'], next_cursor: null }); await more;
    expect(session.getState().browse).toMatchObject({ olderRows: ['older 1', 'older 2'], exhausted: true });
    session.dispose();
  });

  it('discards prepared text that no longer joins the current screen', async () => {
    const channel = new FakeChannel(), session = new TerminalSession(channel);
    channel.autoReply.add('terminal.replay');
    session.setTarget(target); await flush(); channel.push(firstTick(['old a', 'old b']));
    await session.inspectScrollMode(); session.prepareHistory();
    channel.calls.find(c => c.method === 'surface.history')!.resolve({ rows: ['stale'], anchor_rows: ['old a', 'old b'], next_cursor: null });
    await flush(); channel.push(firstTick(['new a', 'new b'], 2));
    session.startBrowsing(); const loading = session.loadOlder(); await flush();
    const reads = channel.calls.filter(c => c.method === 'surface.history');
    expect(reads).toHaveLength(2);
    reads[1].resolve({ rows: ['current older'], anchor_rows: ['new a', 'new b'], next_cursor: null }); await loading;
    expect(session.getState().browse?.olderRows).toEqual(['current older']);
    session.dispose();
  });
});

describe('TerminalSession subscription', () => {
  it('requests a fresh screen when a non-snapshot diff skips a revision', async () => {
    const channel = new FakeChannel(), session = new TerminalSession(channel);
    session.setTarget(target); await flush(); channel.push(firstTick(['first', 'second'], 1));
    channel.push({ type: 'screen.diff', surfaceId: 's1', rev: 3, ops: [{ op: 'row', y: 1, text: 'new second' }] });
    await flush();
    expect(channel.methods().filter((method) => method === 'surface.subscribe')).toHaveLength(2);
    expect(session.getState().screen.rows).toEqual(['first', 'second']);
    channel.push(firstTick(['new first', 'new second'], 10));
    expect(session.getState().screen.rows).toEqual(['new first', 'new second']);
    session.dispose();
  });
  it('restores an older reading position from history without storing terminal content', async () => {
    const channel = new FakeChannel();
    const rows = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const position = { anchor: readingAnchor(rows, 4), rowFromBottom: 15, segmentFromBottom: 0, horizontalColumns: 8 };
    const session = new TerminalSession(channel, { readingForTarget: () => position });
    session.setTarget(target); await flush();
    channel.push(firstTick(rows.slice(-5)));
    const call = channel.calls.find((c) => c.method === 'surface.history')!;
    expect(call).toBeDefined();
    call.resolve({ rows: rows.slice(0, -5), anchor_rows: rows.slice(-5), next_cursor: null });
    await flush();
    expect(session.getState()).toMatchObject({ restoringReading: false, restoredReading: position });
    session.dispose();
  });
  it('cancels in-flight reading recovery when the user returns to live output', async () => {
    const channel = new FakeChannel(), saveReading = jest.fn();
    const session = new TerminalSession(channel, { readingForTarget: () => ({ anchor: 'a'.repeat(64), rowFromBottom: 100, segmentFromBottom: 0, horizontalColumns: 0 }), saveReading });
    session.setTarget(target); await flush(); channel.push(firstTick(['latest']));
    const call = channel.calls.find((c) => c.method === 'surface.history')!;
    session.resumeLive();
    call.resolve({ rows: ['old'], anchor_rows: ['latest'], next_cursor: null }); await flush();
    expect(session.getState()).toMatchObject({ browse: null, restoredReading: null, restoringReading: false });
    expect(saveReading).toHaveBeenCalledWith(target, null);
    session.dispose();
  });
  it('subscribes to the target and applies diffs for it only', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    expect(channel.calls[0]).toMatchObject({
      method: 'surface.subscribe',
      params: { workspace_id: 'w1', surface_id: 's1', lines: 120 },
    });
    await flush();
    expect(session.getState().subscription).toBe('live');

    channel.push(firstTick(['$ ls', 'a.txt']));
    channel.push({ ...(firstTick(['other']) as object), surfaceId: 'other' } as PushFrame);
    expect(session.getState().screen.rows).toEqual(['$ ls', 'a.txt']);
  });

  it('retries a subscribe that overtakes the session attach', async () => {
    jest.useFakeTimers();
    try {
      const channel = new FakeChannel();
      channel.autoReply.delete('surface.subscribe');
      const session = new TerminalSession(channel);
      session.setTarget(target);
      channel.calls[0].reject(new RpcCallError('session_not_attached', 'hello required'));
      await jest.advanceTimersByTimeAsync(150);
      expect(channel.methods()).toEqual(['surface.subscribe', 'surface.subscribe']);
      channel.calls[1].resolve({});
      await jest.advanceTimersByTimeAsync(0);
      expect(session.getState().subscription).toBe('live');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resubscribes after a reconnect', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.status({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
    expect(session.getState().subscription).toBe('none');
    channel.status({ state: 'open' });
    await flush();
    expect(channel.methods().filter((m) => m === 'surface.subscribe')).toHaveLength(2);
    expect(session.getState().subscription).toBe('live');
  });

  it('unsubscribes the previous surface when the target changes', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['old']));
    session.setTarget({ workspaceId: 'w1', surfaceId: 's2' });
    expect(channel.calls.slice(1, 3).map((c) => [c.method, c.params.surface_id])).toEqual([
      ['surface.unsubscribe', 's1'],
      ['surface.subscribe', 's2'],
    ]);
    expect(session.getState().screen.rows).toEqual([]);
  });
});

describe('TerminalSession checksum', () => {
  it('does nothing when the checksum matches', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['a', 'b']));
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 1, hash: screenHash(['a', 'b'], { x: 0, y: 0 }) });
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe']);
  });

  it('resubscribes on a mismatch, unsubscribing first', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['a', 'b']));
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 1, hash: 'deadbeefdeadbeef' });
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe', 'surface.unsubscribe', 'surface.subscribe']);
  });

  it('ignores a checksum for another rev', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['a']));
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 2, hash: 'deadbeefdeadbeef' });
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe']);
  });

  it('rate-limits resyncs', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['a']));
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 1, hash: 'bad' });
    await flush();
    channel.push(firstTick(['a']));
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 1, hash: 'bad' });
    await flush();
    expect(channel.methods().filter((m) => m === 'surface.unsubscribe')).toHaveLength(1);
  });
});

describe('TerminalSession history', () => {
  async function browsing(rows: string[]) {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { historyPageLines: 2 });
    session.setTarget(target);
    await flush();
    channel.push(firstTick(rows));
    session.startBrowsing();
    return { channel, session };
  }

  it('freezes the live rows while browsing', async () => {
    const { channel, session } = await browsing(['p1', 'p2']);
    channel.push({ type: 'screen.diff', surfaceId: 's1', rev: 2, ops: [{ op: 'row', y: 1, text: 'changed' }] });
    const browse = session.getState().browse!;
    expect(browse.frozenRows).toEqual(['p1', 'p2']);
    expect(browse.liveChanged).toBe(true);
    expect(session.getState().screen.rows).toEqual(['p1', 'changed']);
    session.resumeLive();
    expect(session.getState().browse).toBeNull();
  });

  it('pages history with the cursor and stops at the start', async () => {
    const { channel, session } = await browsing(['p1', 'p2']);
    const first = session.loadOlder();
    const call = channel.calls[channel.calls.length - 1];
    expect(call).toMatchObject({
      method: 'surface.history',
      params: { workspace_id: 'w1', surface_id: 's1', limit: 2, tail_lines: 2 },
    });
    call.resolve({ rows: ['h3', 'h4'], anchor_rows: ['p1', 'p2'], next_cursor: 'snap.2' });
    await first;
    expect(session.getState().browse).toMatchObject({ olderRows: ['h3', 'h4'], cursor: 'snap.2', exhausted: false });

    const second = session.loadOlder();
    const next = channel.calls[channel.calls.length - 1];
    expect(next.params).toEqual({ workspace_id: 'w1', surface_id: 's1', limit: 2, cursor: 'snap.2' });
    next.resolve({ rows: ['h1', 'h2'], next_cursor: null });
    await second;
    expect(session.getState().browse).toMatchObject({ olderRows: ['h1', 'h2', 'h3', 'h4'], exhausted: true });

    await session.loadOlder();
    expect(channel.methods().filter((m) => m === 'surface.history')).toHaveLength(2);
  });

  it('reports an expired cursor and waits for an explicit retry', async () => {
    const { channel, session } = await browsing(['p1']);
    const load = session.loadOlder();
    channel.calls[channel.calls.length - 1].reject(
      new RpcCallError('history_unavailable', 'terminal history cursor expired'),
    );
    await load;
    expect(session.getState().browse?.error).toMatch(/过期/);
    await session.loadOlder();
    expect(channel.methods().filter((m) => m === 'surface.history')).toHaveLength(1);
  });

  it('restarts from a new snapshot when retrying an expired cursor', async () => {
    const { channel, session } = await browsing(['live']);
    let request = session.loadOlder();
    channel.calls.at(-1)!.resolve({ rows: ['old'], anchor_rows: ['live'], next_cursor: 'expired.1' }); await request;
    request = session.loadOlder(); channel.calls.at(-1)!.reject(new RpcCallError('history_unavailable', 'terminal history cursor expired')); await request;
    request = session.loadOlder({ retry: true });
    expect(channel.calls.at(-1)!.params.cursor).toBeUndefined();
    channel.calls.at(-1)!.resolve({ rows: ['old'], anchor_rows: ['live'], next_cursor: 'fresh.1' }); await request;
    expect(session.getState().browse).toMatchObject({ olderRows: ['old'], cursor: 'fresh.1', error: null });
    session.dispose();
  });

  it('rejects a cursor that repeats instead of duplicating the same history page', async () => {
    const { channel, session } = await browsing(['live']);
    let request = session.loadOlder(); channel.calls.at(-1)!.resolve({ rows: ['old'], anchor_rows: ['live'], next_cursor: 'snapshot.1' }); await request;
    request = session.loadOlder(); channel.calls.at(-1)!.resolve({ rows: ['old'], next_cursor: 'snapshot.1' }); await request;
    expect(session.getState().browse?.olderRows).toEqual(['old']);
    expect(session.getState().browse?.error).toMatch(/前进|重复/);
    session.dispose();
  });

  it('does not mistake a malformed cursor field for the beginning of history', () => {
    expect(() => parseHistoryPage({ rows: ['older'] })).toThrow();
    expect(() => parseHistoryPage({ rows: ['older'], next_cursor: 3 })).toThrow();
  });

  it('keeps legitimate repeated lines instead of guessing an ambiguous frozen-screen seam', async () => {
    const { channel, session } = await browsing(['same', 'same']);
    const request = session.loadOlder();
    channel.calls.at(-1)!.resolve({ rows: ['old', 'same', 'same'], anchor_rows: ['same', 'same'], next_cursor: 'snap.1' }); await request;
    expect(session.getState().browse).toMatchObject({ olderRows: ['old', 'same', 'same'], frozenRows: ['same', 'same'] });
    expect(session.getState().readingNotice).toMatch(/快照/);
    expect(channel.methods().filter((m) => m === 'surface.history')).toHaveLength(1);
    session.dispose();
  });

  it('preserves the frozen output if the terminal was cleared, until an explicit reload', async () => {
    const { channel, session } = await browsing(['important result', 'old prompt']);
    let request = session.loadOlder();
    channel.calls.at(-1)!.resolve({ rows: ['different history'], anchor_rows: ['new prompt'], next_cursor: null }); await request;
    expect(session.getState().browse).toMatchObject({ frozenRows: ['important result', 'old prompt'], olderRows: [], exhausted: false, restartRequired: true });
    channel.push(firstTick(['new prompt'], 2));
    request = session.loadOlder({ retry: true });
    channel.calls.at(-1)!.resolve({ rows: ['different history'], anchor_rows: ['new prompt'], next_cursor: null }); await request;
    expect(session.getState().browse).toMatchObject({ frozenRows: ['new prompt'], olderRows: ['different history'], exhausted: true, error: null });
    session.dispose();
  });

  it('rejects a cursor cycle across pages without corrupting the rows already loaded', async () => {
    const { channel, session } = await browsing(['live']);
    let request = session.loadOlder(); channel.calls.at(-1)!.resolve({ rows: ['p2'], anchor_rows: ['live'], next_cursor: 'snap.2' }); await request;
    request = session.loadOlder(); channel.calls.at(-1)!.resolve({ rows: ['p1'], next_cursor: 'snap.1' }); await request;
    request = session.loadOlder(); channel.calls.at(-1)!.resolve({ rows: ['p2'], next_cursor: 'snap.2' }); await request;
    expect(session.getState().browse).toMatchObject({ olderRows: ['p1', 'p2'], restartRequired: true, exhausted: false });
    session.dispose();
  });

  it('returns the exact chronological transcript across many pages while the snapshot is far ahead', async () => {
    const snapshot = Array.from({ length: 1400 }, (_, i) => `line ${i}`), frozen = snapshot.slice(780, 800);
    class PagedChannel extends FakeChannel {
      pages = 0;
      override call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method !== 'surface.history') return super.call<T>(method, params);
        this.pages++;
        const end = params.cursor ? Number(String(params.cursor).split('.')[1]) : snapshot.length - Number(params.tail_lines);
        const start = Math.max(0, end - Number(params.limit));
        return Promise.resolve({ rows: snapshot.slice(start, end), next_cursor: start ? `snap.${start}` : null, ...(!params.cursor ? { anchor_rows: snapshot.slice(end) } : {}) } as T);
      }
    }
    const channel = new PagedChannel(), session = new TerminalSession(channel, { historyPageLines: 50 });
    session.setTarget(target); await flush(); channel.push(firstTick(frozen)); session.startBrowsing();
    for (let i = 0; i < 40 && !session.getState().browse?.exhausted; i++) await session.loadOlder();
    const browse = session.getState().browse!;
    expect(browse.error).toBeNull(); expect(browse.exhausted).toBe(true);
    expect([...browse.olderRows, ...browse.frozenRows]).toEqual(snapshot.slice(0, 800));
    expect(channel.pages).toBeGreaterThan(10);
    session.dispose();
  });

  it('can join a prewarmed snapshot that is older than the frozen live screen', async () => {
    const { channel, session } = await browsing(['c', 'd', 'e', 'f']);
    const request = session.loadOlder();
    channel.calls.at(-1)!.resolve({ rows: ['old1', 'old2'], anchor_rows: ['a', 'b', 'c', 'd'], next_cursor: null }); await request;
    expect(session.getState().browse).toMatchObject({ olderRows: ['old1', 'old2', 'a', 'b'], frozenRows: ['c', 'd', 'e', 'f'], exhausted: true });
    session.dispose();
  });

  it('walks past newer output until it can attach history to the frozen screen', async () => {
    const { channel, session } = await browsing(['f1', 'f2']);
    const request = session.loadOlder();
    channel.calls.at(-1)!.resolve({ rows: ['new1', 'new2'], anchor_rows: ['new3', 'new4'], next_cursor: 'snapshot.4' });
    await flush();
    expect(session.getState().browse?.olderRows).toEqual([]);
    expect(channel.calls.at(-1)!.params.cursor).toBe('snapshot.4');
    channel.calls.at(-1)!.resolve({ rows: ['f1', 'f2'], next_cursor: 'snapshot.2' }); await flush();
    // The found prefix has no older rows yet, so fetch the preceding page too.
    expect(channel.calls.at(-1)!.params.cursor).toBe('snapshot.2');
    channel.calls.at(-1)!.resolve({ rows: ['old1', 'old2'], next_cursor: null });
    await request;
    expect(session.getState().browse).toMatchObject({ olderRows: ['old1', 'old2'], frozenRows: ['f1', 'f2'], exhausted: true });
    session.dispose();
  });

  it('discards a page that arrives after returning to live', async () => {
    const { channel, session } = await browsing(['p1']);
    const load = session.loadOlder();
    session.resumeLive();
    channel.calls[channel.calls.length - 1].resolve({ rows: ['h'], anchor_rows: ['p1'], next_cursor: null });
    await load;
    expect(session.getState().browse).toBeNull();
  });
});

describe('stitchFirstPage', () => {
  it('matches the visible lines when ANSI or terminal-width padding changed', () => {
    expect(stitchFirstPage(['\u001b[31ma\u001b[0m   ', 'b   ', 'c   '], ['old1', 'old2', 'a', 'b'], ['c', 'new1', 'new2'])).toEqual(['old1', 'old2']);
  });
  it('keeps everything above the frozen rows when nothing changed', () => {
    expect(stitchFirstPage(['a', 'b'], ['h1', 'h2'], ['a', 'b'])).toEqual(['h1', 'h2']);
  });

  it('drops output that arrived after the freeze', () => {
    // Scrollback h0 h1 a b c, live window [a, b, c] frozen. Before the snapshot,
    // d and e scrolled in, so the relay's 3-row anchor is [c, d, e].
    expect(stitchFirstPage(['a', 'b', 'c'], ['h0', 'h1', 'a', 'b'], ['c', 'd', 'e'])).toEqual(['h0', 'h1']);
  });

  it('falls back to the snapshot split when the frozen rows are not found', () => {
    expect(stitchFirstPage(['zz'], ['h1', 'h2'], ['a'])).toEqual(['h1', 'h2']);
  });

  it('still lines up when the bottom row was rewritten and output scrolled meanwhile', () => {
    // Frozen [a, b, c, spin1]; then the spinner row became `done` and `next`
    // was printed, so the snapshot ends a b c done next. A whole-window match
    // fails; matching the top must not repeat a, b, c above the frozen rows.
    expect(stitchFirstPage(['a', 'b', 'c', 'spin1'], ['h0', 'h1', 'a', 'b'], ['c', 'done', 'next'])).toEqual(['h0', 'h1']);
  });

  it('does not place a page on a single matching row', () => {
    expect(stitchFirstPage(['x', 'y', 'z', 'w'], ['h0', 'x'], ['q', 'r'])).toEqual(['h0', 'x']);
  });
});

describe('TerminalSession live lines', () => {
  const subscribedLines = (channel: FakeChannel) =>
    channel.calls.filter((c) => c.method === 'surface.subscribe').map((c) => c.params.lines);

  it('uses the new value for the next subscribe without any call before a target', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setLiveLines(200);
    expect(channel.calls).toHaveLength(0);
    session.setTarget(target);
    await flush();
    expect(subscribedLines(channel)).toEqual([200]);
  });

  it('replaces a live subscription, unsubscribing first', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    session.setLiveLines(240);
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe', 'surface.unsubscribe', 'surface.subscribe']);
    expect(subscribedLines(channel)).toEqual([120, 240]);
    expect(session.getState().subscription).toBe('live');
  });

  it('does nothing for the same value or a nonsense one', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    session.setLiveLines(120);
    session.setLiveLines(Number.NaN);
    session.setLiveLines(0);
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe']);
  });

  it('runs one replacement at a time and ends on the latest value', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.unsubscribe');
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    session.setLiveLines(140);
    session.setLiveLines(160);
    session.setLiveLines(180);
    const unsubscribes = () => channel.calls.filter((c) => c.method === 'surface.unsubscribe');
    expect(unsubscribes()).toHaveLength(1);
    unsubscribes()[0].resolve({});
    await flush();
    // The first cycle subscribed with the latest value, so no second cycle is needed.
    expect(subscribedLines(channel)).toEqual([120, 180]);
    expect(unsubscribes()).toHaveLength(1);
  });

  it('catches up with a change made while a replacement is subscribing', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.subscribe');
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    channel.calls[0].resolve({});
    await flush();
    session.setLiveLines(200);
    await flush();
    const subscribes = () => channel.calls.filter((c) => c.method === 'surface.subscribe');
    expect(subscribes().map((c) => c.params.lines)).toEqual([120, 200]);
    session.setLiveLines(300);
    subscribes()[1].resolve({});
    await flush();
    expect(subscribes().map((c) => c.params.lines)).toEqual([120, 200, 300]);
    expect(channel.methods().filter((m) => m === 'surface.unsubscribe')).toHaveLength(2);
    subscribes()[2].resolve({});
    await flush();
    expect(session.getState().subscription).toBe('live');
  });

  it('catches up with a change made during the first subscribe', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.subscribe');
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    session.setLiveLines(200);
    expect(channel.methods()).toEqual(['surface.subscribe']);
    channel.calls[0].resolve({});
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe', 'surface.unsubscribe', 'surface.subscribe']);
    expect(channel.calls[2].params.lines).toBe(200);
  });

  it('waits for the reconnect while offline', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    channel.status({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
    session.setLiveLines(260);
    channel.status({ state: 'open' });
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe', 'surface.subscribe']);
    expect(subscribedLines(channel)).toEqual([120, 260]);
  });

  it('holds off a checksum resync while a replacement is in flight', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.unsubscribe');
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    channel.push(firstTick(['a']));
    session.setLiveLines(200);
    channel.push({ type: 'screen.checksum', surfaceId: 's1', rev: 1, hash: 'bad' });
    expect(channel.methods().filter((m) => m === 'surface.unsubscribe')).toHaveLength(1);
  });

  it('sends nothing after dispose', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.unsubscribe');
    const session = new TerminalSession(channel, { liveLines: 120 });
    session.setTarget(target);
    await flush();
    session.setLiveLines(200);
    session.dispose();
    channel.calls.find((c) => c.method === 'surface.unsubscribe')!.resolve({});
    await flush();
    expect(channel.methods()).toEqual(['surface.subscribe', 'surface.unsubscribe']);
  });
});

describe('TerminalSession input', () => {
  it('does not send a key when focusing its target fails', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.focus');
    const session = new TerminalSession(channel); session.setTarget(target); await flush();
    session.sendKey({ name: 'up', modifiers: ['ctrl'] });
    channel.calls.find((c) => c.method === 'surface.focus')!.reject(new RpcCallError('not_found', 'closed pane'));
    await flush();
    expect(channel.calls.some((c) => c.method === 'surface.send_key')).toBe(false);
    expect(session.getState().input.error).not.toBeNull();
  });
  it('reports uncertain delivery without replaying a timed-out command', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.autoReply.delete('surface.send_key');
    const receipt = session.submitLine('deploy');
    await flush();
    channel.calls.find((c) => c.method === 'surface.send_key')!.reject(new RpcCallError('timeout', 'timeout'));
    await expect(receipt).resolves.toMatchObject({ status: 'unknown' });
    expect(channel.calls.filter((c) => c.method === 'surface.send_text')).toHaveLength(1);
  });
  it('does not finish a submitted command in a different terminal after switching', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    channel.autoReply.delete('surface.send_text');
    const receipt = session.submitLine('deploy');
    session.setTarget({ workspaceId: 'w2', surfaceId: 's2' });
    channel.calls.find((c) => c.method === 'surface.send_text')!.resolve({});
    await expect(receipt).resolves.toMatchObject({ status: 'unknown' });
    expect(channel.calls.some((c) => c.method === 'surface.send_key')).toBe(false);
  });
  it('sends input in order, one request at a time, coalescing text', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.send_text');
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    session.sendText('a');
    session.sendText('b');
    session.sendText('c');
    session.sendKey({ name: 'enter' });
    const sends = () => channel.calls.filter((c) => c.method.startsWith('surface.send') || c.method === 'surface.focus');
    expect(sends().map((c) => [c.method, c.params.text ?? c.params.key])).toEqual([['surface.send_text', 'a']]);
    sends()[0].resolve({});
    await flush();
    expect(sends()[1]).toMatchObject({ method: 'surface.send_text', params: { text: 'bc' } });
    sends()[1].resolve({});
    await flush();
    expect(sends().slice(2).map((c) => c.method)).toEqual(['surface.focus', 'surface.send_key']);
    expect(sends()[3].params).toEqual({ workspace_id: 'w1', surface_id: 's1', key: 'enter' });
    await flush();
    expect(session.getState().input).toEqual({ busy: false, error: null });
  });

  it('submits a line as text then Enter, and an empty line as Enter only', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    session.submitLine('ls -la');
    await flush();
    session.submitLine('');
    await flush();
    const keys = channel.calls
      .filter((c) => c.method === 'surface.send_text' || c.method === 'surface.send_key')
      .map((c) => c.params.text ?? c.params.key);
    expect(keys).toEqual(['ls -la', 'enter', 'enter']);
  });

  it('encodes modifier keys the way cmux expects', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    session.sendKey({ name: 'c', modifiers: ['ctrl'] });
    await flush();
    expect(channel.calls.find((c) => c.method === 'surface.send_key')?.params.key).toBe('ctrl-c');
  });

  it('cancels a saved reading restoration when Ctrl + Up is sent before the first screen arrives', async () => {
    const channel = new FakeChannel();
    const session = new TerminalSession(channel, { readingForTarget: () => ({ anchor: 'a'.repeat(64), rowFromBottom: 100, segmentFromBottom: 0, horizontalColumns: 0 }) });
    session.setTarget(target); await flush();
    session.sendKey({ name: 'up', modifiers: ['ctrl'] }); await flush();
    channel.push(firstTick(['prompt changed by Ctrl + Up'])); await flush();
    expect(session.getState()).toMatchObject({ browse: null, restoringReading: false, inputRevision: 1 });
    expect(channel.methods()).not.toContain('surface.history');
    session.dispose();
  });

  it('keeps the reading position when an offline shortcut cannot be delivered', async () => {
    const channel = new FakeChannel(), session = new TerminalSession(channel);
    session.setTarget(target); await flush(); channel.push(firstTick(['saved output']));
    session.startBrowsing(); channel.status({ state: 'idle' });
    session.sendKey({ name: 'up', modifiers: ['ctrl'] }); await flush();
    expect(session.getState().browse?.frozenRows).toEqual(['saved output']);
    expect(session.getState().inputRevision ?? 0).toBe(0);
    session.dispose();
  });

  it('drops queued input and reports the error when a send fails', async () => {
    const channel = new FakeChannel();
    channel.autoReply.delete('surface.send_text');
    const session = new TerminalSession(channel);
    session.setTarget(target);
    await flush();
    session.sendText('a');
    session.sendKey({ name: 'enter' });
    channel.calls.find((c) => c.method === 'surface.send_text')!.reject(new RpcCallError('closed', 'gone'));
    await flush();
    expect(channel.methods()).not.toContain('surface.send_key');
    expect(session.getState().input).toEqual({ busy: false, error: '没有连上电脑' });
  });
});
