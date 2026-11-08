const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
  },
}));

const KEY = 'panecast.prefs.v1';

/** A fresh copy of the module: it keeps its state at module level and loads once. */
async function freshPrefs(): Promise<typeof import('../prefs')> {
  jest.resetModules();
  return jest.requireActual('../prefs');
}

beforeEach(() => mockStorage.clear());

describe('clampHistoryLines', () => {
  it('keeps 60–400 on the 20-line grid', async () => {
    const { clampHistoryLines } = await freshPrefs();
    expect([60, 120, 400].map(clampHistoryLines)).toEqual([60, 120, 400]);
    expect([0, 59, 401, 10_000].map(clampHistoryLines)).toEqual([60, 60, 400, 400]);
    expect([129, 131, 75].map(clampHistoryLines)).toEqual([120, 140, 80]);
    expect(clampHistoryLines(Number.NaN)).toBe(120);
  });
});

describe('sanitizePrefs', () => {
  it('fills in defaults for the new settings', async () => {
    const { sanitizePrefs } = await freshPrefs();
    expect(sanitizePrefs({ fontSize: 15, inputMode: 'live' })).toEqual({
      fontSize: 15,
      inputMode: 'live',
      historyLines: 120,
      keyHaptics: true,
      extraKeyRow: false,
      terminalWrap: true,
      terminalPresentation: 'terminal',
      tabletSidebar: true,
    });
  });

  it('rejects malformed values field by field', async () => {
    const { sanitizePrefs, DEFAULT_PREFS } = await freshPrefs();
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ historyLines: '200', keyHaptics: 'no', extraKeyRow: 1, fontSize: 99 })).toEqual({
      ...DEFAULT_PREFS,
      fontSize: 20,
    });
    expect(sanitizePrefs({ historyLines: 333, keyHaptics: false, extraKeyRow: true })).toMatchObject({
      historyLines: 340,
      keyHaptics: false,
      extraKeyRow: true,
    });
  });
});

describe('loadPrefs / setPrefs', () => {
  it('reads prefs saved before the new settings existed', async () => {
    mockStorage.set(KEY, JSON.stringify({ fontSize: 16, inputMode: 'live' }));
    const prefs = await freshPrefs();
    await prefs.loadPrefs();
    expect(prefs.getPrefs()).toEqual({ ...prefs.DEFAULT_PREFS, fontSize: 16, inputMode: 'live' });
  });

  it('clamps, saves, and skips no-op updates', async () => {
    const prefs = await freshPrefs();
    await prefs.loadPrefs();
    prefs.setPrefs({ historyLines: 1_000, extraKeyRow: true });
    await Promise.resolve();
    expect(prefs.getPrefs()).toMatchObject({ historyLines: 400, extraKeyRow: true });
    expect(JSON.parse(mockStorage.get(KEY)!)).toMatchObject({ historyLines: 400, extraKeyRow: true, keyHaptics: true });

    const before = prefs.getPrefs();
    prefs.setPrefs({ historyLines: 400, keyHaptics: true });
    expect(prefs.getPrefs()).toBe(before);
  });

  it('falls back to defaults on unreadable storage', async () => {
    mockStorage.set(KEY, '{not json');
    const prefs = await freshPrefs();
    await prefs.loadPrefs();
    expect(prefs.getPrefs()).toEqual(prefs.DEFAULT_PREFS);
  });
});
