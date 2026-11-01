import {
  computerAddress,
  EMPTY_COMPUTER_LIST,
  normalizeComputerName,
  removeComputer,
  renameComputer,
  selectedComputer,
  upsertComputer,
  type ComputerList,
  type StoredComputer,
} from '../computers';

function computer(id: string, relayId = `relay-${id}`, serverUrl = 'https://broker.example/cmux-remote'): StoredComputer {
  return {
    id,
    name: relayId,
    broker: { serverUrl, relayId, deviceId: `dev-${id}`, token: `token-${id}` },
    pairedAt: '2026-10-31T00:00:00.000Z',
  };
}

function list(computers: StoredComputer[], selectedId: string | null = computers[0]?.id ?? null, transport?: ComputerList['transport']): ComputerList {
  return { version: 2, selectedId, computers, transport };
}

describe('upsertComputer', () => {
  it('appends a new computer and selects it', () => {
    const a = computer('a');
    const b = computer('b');
    const { list: next, computer: added } = upsertComputer(list([a]), b);
    expect(added).toBe(b);
    expect(next.computers.map((c) => c.id)).toEqual(['a', 'b']);
    expect(next.selectedId).toBe('b');
  });

  it('re-pairing the same relay keeps id, name, position and transport but takes the new credentials', () => {
    const a = { ...computer('a', 'mac-1'), name: '书房 Mac' };
    const b = computer('b');
    const fresh = { ...computer('new-id', 'mac-1'), broker: { ...computer('x', 'mac-1').broker, token: 'fresh-token' } };
    const { list: next, computer: kept } = upsertComputer(list([a, b], 'b', { a: 'broker' }), fresh);
    expect(kept).toMatchObject({ id: 'a', name: '书房 Mac', broker: { token: 'fresh-token' } });
    expect(next.computers.map((c) => c.id)).toEqual(['a', 'b']);
    expect(next.computers[0]).toBe(kept);
    expect(next.selectedId).toBe('a');
    expect(next.transport).toEqual({ a: 'broker' });
  });

  it('treats the same relay id on another broker as another computer', () => {
    const a = computer('a', 'mac-1');
    const other = computer('b', 'mac-1', 'https://other.example');
    expect(upsertComputer(list([a]), other).list.computers.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('collapses leftover duplicates of the re-paired relay', () => {
    const a = computer('a', 'mac-1');
    const dup = computer('dup', 'mac-1');
    const { list: next } = upsertComputer(list([a, computer('b'), dup]), computer('new', 'mac-1'));
    expect(next.computers.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('removeComputer', () => {
  it('keeps the selection when another computer is removed', () => {
    const next = removeComputer(list([computer('a'), computer('b')], 'b'), 'a');
    expect(next.computers.map((c) => c.id)).toEqual(['b']);
    expect(next.selectedId).toBe('b');
  });

  it('selects the first remaining computer when the selected one is removed', () => {
    const next = removeComputer(list([computer('a'), computer('b'), computer('c')], 'b'), 'b');
    expect(next.selectedId).toBe('a');
    expect(selectedComputer(next)?.id).toBe('a');
  });

  it('leaves nothing selected when the last computer is removed', () => {
    const next = removeComputer(list([computer('a')]), 'a');
    expect(next).toMatchObject({ selectedId: EMPTY_COMPUTER_LIST.selectedId, computers: [] });
    expect(selectedComputer(next)).toBeNull();
  });

  it('drops the transport preference of the removed computer only', () => {
    const next = removeComputer(list([computer('a'), computer('b')], 'a', { a: 'lan', b: 'broker' }), 'a');
    expect(next.transport).toEqual({ b: 'broker' });
  });

  it('returns the same list when the id is unknown', () => {
    const before = list([computer('a')]);
    expect(removeComputer(before, 'zzz')).toBe(before);
  });

  it('does not move the effective selection when the stored one was stale', () => {
    // selectedId points nowhere, so `a` (the first) is effectively selected.
    const next = removeComputer(list([computer('a'), computer('b')], 'gone'), 'b');
    expect(next.selectedId).toBe('a');
  });
});

describe('renameComputer', () => {
  it('trims the name and falls back to the relay id when blank', () => {
    const before = list([computer('a', 'mac-1'), computer('b')]);
    expect(renameComputer(before, 'a', '  办公室 Mac  ').computers[0].name).toBe('办公室 Mac');
    expect(renameComputer(before, 'a', '   ').computers[0].name).toBe('mac-1');
    expect(renameComputer(before, 'a', 'x').computers[1]).toBe(before.computers[1]);
  });

  it('normalizeComputerName matches what rename stores', () => {
    const c = computer('a', 'mac-1');
    expect(normalizeComputerName(c, ' 新名字 ')).toBe('新名字');
    expect(normalizeComputerName(c, '')).toBe('mac-1');
  });
});

it('computerAddress drops the scheme', () => {
  expect(computerAddress(computer('a'))).toBe('broker.example/cmux-remote');
});
