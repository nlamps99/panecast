import { parseInbound, type ScreenDiffFrame } from '../frames';
import { applyDiff, applyFull, applyOps, EMPTY_SCREEN, screenHash } from '../screen';
import { sha256, toHex, utf8Encode } from '../sha256';

function diff(rev: number, ops: ScreenDiffFrame['ops']): ScreenDiffFrame {
  return { type: 'screen.diff', surfaceId: 's', rev, ops };
}

describe('sha256', () => {
  it('matches known digests', () => {
    expect(toHex(sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(sha256(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // 56 bytes: the length no longer fits in the first block.
    expect(toHex(sha256(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('encodes UTF-8 like Swift, replacing lone surrogates', () => {
    expect(Array.from(utf8Encode('é你🚀'))).toEqual([0xc3, 0xa9, 0xe4, 0xbd, 0xa0, 0xf0, 0x9f, 0x9a, 0x80]);
    expect(Array.from(utf8Encode('\ud800x'))).toEqual([0xef, 0xbf, 0xbd, 0x78]);
  });
});

describe('screenHash', () => {
  // Reference values from SharedKit's ScreenHasher, computed with CryptoKit.
  it.each([
    ['empty', [], { x: 0, y: 0 }, '35d00b1d70cd91cb'],
    ['one', ['hello'], { x: 0, y: 0 }, '6718693c74207983'],
    ['cjk', ['$ ls', '你好，世界 ⏺ émoji 🚀', ''], { x: 0, y: 0 }, '4fa112dfe2cb86ff'],
    ['cursor', ['a', 'b'], { x: 3, y: 1 }, 'fe5112a62ea2e35d'],
    ['negative cursor', ['x'], { x: -1, y: -1 }, '0488e194d680a50b'],
    ['ansi', ['\u001b[31mred\u001b[0m', '   '], { x: 0, y: 0 }, '562a02bb8bad1637'],
  ])('matches ScreenHasher for %s', (_name, rows, cursor, expected) => {
    expect(screenHash(rows, cursor)).toBe(expected);
  });

  it('matches ScreenHasher across many blocks', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `row ${i} ${'─'.repeat(150)}`);
    expect(screenHash(rows, { x: 0, y: 0 })).toBe('3e2ea8abec2e3ba3');
  });
});

describe('screen diffs', () => {
  it('applies the relay first tick (clear, every row, cursor) to an empty screen', () => {
    const state = applyDiff(
      EMPTY_SCREEN,
      diff(1, [
        { op: 'clear' },
        { op: 'row', y: 0, text: 'a' },
        { op: 'row', y: 1, text: 'b' },
        { op: 'cursor', x: 0, y: 0 },
      ]),
    );
    expect(state).toEqual({ rev: 1, rows: ['a', 'b'], cursor: { x: 0, y: 0 } });
  });

  it('replaces changed rows and keeps the others', () => {
    const base = { rev: 4, rows: ['a', 'b', 'c'], cursor: { x: 0, y: 0 } };
    const next = applyDiff(base, diff(5, [{ op: 'row', y: 1, text: 'B' }]));
    expect(next.rows).toEqual(['a', 'B', 'c']);
    expect(next.rev).toBe(5);
    expect(base.rows).toEqual(['a', 'b', 'c']);
  });

  it('shrinks the screen on clear so the checksum matches the relay', () => {
    const base = { rev: 7, rows: ['1', '2', '3'], cursor: { x: 0, y: 0 } };
    const next = applyDiff(base, diff(8, [{ op: 'clear' }, { op: 'row', y: 0, text: 'only' }]));
    expect(next.rows).toEqual(['only']);
    expect(screenHash(next.rows, next.cursor)).toBe(screenHash(['only'], { x: 0, y: 0 }));
  });

  it('pads with empty rows when a row lands past the end', () => {
    expect(applyOps(EMPTY_SCREEN, [{ op: 'row', y: 2, text: 'z' }]).rows).toEqual(['', '', 'z']);
  });

  it('drops stale diffs but always applies a reset', () => {
    const base = { rev: 9, rows: ['x'], cursor: { x: 0, y: 0 } };
    expect(applyDiff(base, diff(9, [{ op: 'row', y: 0, text: 'old' }]))).toBe(base);
    expect(applyDiff(base, diff(3, [{ op: 'row', y: 0, text: 'old' }]))).toBe(base);
    // A resubscribe restarts rev at 1 with a full snapshot.
    const reset = applyDiff(base, diff(1, [{ op: 'clear' }, { op: 'row', y: 0, text: 'new' }]));
    expect(reset).toEqual({ rev: 1, rows: ['new'], cursor: { x: 0, y: 0 } });
  });

  it('applies screen.full', () => {
    const parsed = parseInbound(
      JSON.stringify({ type: 'screen.full', surface_id: 's', rev: 3, rows: ['a'], cols: 80, rowsCount: 1, cursor: { x: 1, y: 0 } }),
    );
    expect(parsed?.kind).toBe('push');
    if (parsed?.kind !== 'push' || parsed.frame.type !== 'screen.full') throw new Error('bad parse');
    expect(applyFull(parsed.frame)).toEqual({ rev: 3, rows: ['a'], cursor: { x: 1, y: 0 } });
  });
});

describe('parseInbound', () => {
  it('distinguishes responses from push frames', () => {
    expect(parseInbound('{"id":"1","ok":true,"result":{"a":1}}')).toEqual({
      kind: 'response',
      response: { id: '1', ok: true, result: { a: 1 } },
    });
    // cmux omits `ok` on success.
    expect(parseInbound('{"id":"2","result":[]}')).toEqual({
      kind: 'response',
      response: { id: '2', ok: true, result: [] },
    });
    expect(parseInbound('{"id":"3","ok":false,"error":{"code":"invalid_params","message":"nope"}}')).toEqual({
      kind: 'response',
      response: { id: '3', ok: false, error: { code: 'invalid_params', message: 'nope', data: undefined } },
    });
  });

  it('parses snake_case push frames', () => {
    expect(
      parseInbound('{"type":"screen.diff","surface_id":"s","rev":2,"ops":[{"op":"row","y":0,"text":"t"},{"op":"cursor","x":1,"y":2},{"op":"clear"},{"op":"wat"}]}'),
    ).toEqual({
      kind: 'push',
      frame: {
        type: 'screen.diff',
        surfaceId: 's',
        rev: 2,
        ops: [{ op: 'row', y: 0, text: 't' }, { op: 'cursor', x: 1, y: 2 }, { op: 'clear' }],
      },
    });
    expect(parseInbound('{"type":"screen.checksum","surface_id":"s","rev":2,"hash":"abc"}')).toEqual({
      kind: 'push',
      frame: { type: 'screen.checksum', surfaceId: 's', rev: 2, hash: 'abc' },
    });
    expect(parseInbound('{"type":"event","category":"system","name":"cmux.reset","payload":null}')).toEqual({
      kind: 'push',
      frame: { type: 'event', category: 'system', name: 'cmux.reset', payload: null },
    });
    expect(parseInbound('{"type":"ping","ts":42}')).toEqual({ kind: 'push', frame: { type: 'ping', ts: 42 } });
  });

  it('ignores junk', () => {
    for (const text of ['not json', '[]', '{"type":"nope"}', '{"type":"screen.diff","surface_id":"s"}', 'null']) {
      expect(parseInbound(text)).toBeNull();
    }
  });
});
