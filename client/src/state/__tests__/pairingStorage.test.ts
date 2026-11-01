const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `uuid-${++n}` };
});

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// Imported after the mocks.
// eslint-disable-next-line import/first
import { loadComputers, saveComputers } from '../pairingStorage';

beforeEach(() => mockStore.clear());

describe('pairing storage', () => {
  it('migrates the v1 single pairing into the computer list, once', async () => {
    mockStore.set(
      'panecast.pairing.v1',
      JSON.stringify({
        version: 1,
        serverUrl: 'https://example.com/cmux-remote',
        relayId: 'mac-1',
        deviceId: 'dev-1',
        token: 'secret',
        pairedAt: '2026-10-31T00:00:00.000Z',
      }),
    );
    const list = await loadComputers();
    expect(list.computers).toHaveLength(1);
    const [computer] = list.computers;
    expect(list.selectedId).toBe(computer.id);
    expect(computer).toMatchObject({
      name: 'mac-1',
      broker: { serverUrl: 'https://example.com/cmux-remote', relayId: 'mac-1', deviceId: 'dev-1', token: 'secret' },
      pairedAt: '2026-10-31T00:00:00.000Z',
    });
    expect(mockStore.has('panecast.pairing.v1')).toBe(false);
    expect(await loadComputers()).toEqual(list);
  });

  it('round-trips the list and drops malformed entries', async () => {
    const good = {
      id: 'a',
      name: 'Mac',
      broker: { serverUrl: 'https://s', relayId: 'r', deviceId: 'd', token: 't' },
      pairedAt: '2026-10-31T00:00:00.000Z',
    };
    await saveComputers({ version: 2, selectedId: 'a', computers: [good] });
    expect(await loadComputers()).toEqual({ version: 2, selectedId: 'a', computers: [good], transport: undefined });

    mockStore.set('panecast.computers.v2', JSON.stringify({ version: 2, selectedId: 'a', computers: [good, { id: 'b' }] }));
    expect((await loadComputers()).computers.map((c) => c.id)).toEqual(['a']);
  });

  it('starts empty with nothing stored or with garbage', async () => {
    expect(await loadComputers()).toEqual({ version: 2, selectedId: null, computers: [] });
    mockStore.set('panecast.computers.v2', 'not json');
    expect((await loadComputers()).computers).toEqual([]);
  });
});
