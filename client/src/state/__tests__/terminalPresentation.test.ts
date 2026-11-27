import { MAX_REMEMBERED_TERMINALS, parsePresentations, presentationKey, TerminalPresentationStore } from '../terminalPresentation';

function memory(initial: string | null = null) {
  let saved = initial;
  return { getItem: jest.fn(async () => saved), setItem: jest.fn(async (_key: string, value: string) => { saved = value; }), get saved() { return saved; } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('TerminalPresentationStore', () => {
  it('switches one terminal without touching the others', async () => {
    const store = new TerminalPresentationStore(memory());
    await store.load();
    store.choose('mac', 'a', 'chat');
    expect(store.choice('mac', 'a')).toBe('chat');
    expect(store.choice('mac', 'b')).toBeNull();
    expect(store.choice('air', 'a')).toBeNull();
  });

  it('keeps choices across restarts, the newest when one is made while reading', async () => {
    const storage = memory();
    const first = new TerminalPresentationStore(storage);
    await first.load();
    first.choose('mac', 'a', 'chat'); first.choose('mac', 'b', 'chat'); first.choose('mac', 'b', 'terminal');
    await flush();
    const second = new TerminalPresentationStore(storage);
    second.choose('mac', 'a', 'terminal');
    await second.load();
    expect(second.choice('mac', 'a')).toBe('terminal');
    expect(second.choice('mac', 'b')).toBe('terminal');
  });

  it('forgets the least recently chosen terminal past the limit', async () => {
    const store = new TerminalPresentationStore(memory());
    await store.load();
    for (let index = 0; index <= MAX_REMEMBERED_TERMINALS; index++) store.choose('mac', `s${index}`, 'chat');
    expect(store.choice('mac', 's0')).toBeNull();
    expect(store.choice('mac', `s${MAX_REMEMBERED_TERMINALS}`)).toBe('chat');
  });

  it('notifies on a change only', async () => {
    const store = new TerminalPresentationStore(memory());
    await store.load();
    const listener = jest.fn();
    store.subscribe(listener);
    store.choose('mac', 'a', 'chat'); store.choose('mac', 'a', 'chat');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives unreadable storage', async () => {
    const store = new TerminalPresentationStore({ getItem: async () => '{not json', setItem: async () => {} });
    await store.load();
    expect(store.choice('mac', 'a')).toBeNull();
  });
});

describe('parsePresentations', () => {
  it('keeps only well-formed entries', () => {
    expect(parsePresentations({ version: 1, entries: [[presentationKey('mac', 'a'), 'chat'], ['x', 'other'], [1, 'chat'], 'bad'] }))
      .toEqual([[presentationKey('mac', 'a'), 'chat']]);
    expect(parsePresentations({ version: 2, entries: [] })).toEqual([]);
    expect(parsePresentations(null)).toEqual([]);
  });
});
