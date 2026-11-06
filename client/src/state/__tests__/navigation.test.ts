import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import type { Machine } from '../appStore';

let mockMachine: Machine;
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));
jest.mock('../appStore', () => ({ appStore: { getState: () => ({ machine: mockMachine }) } }));
jest.mock('../../session/surfaces', () => ({ listSurfaces: jest.fn() }));
// eslint-disable-next-line import/first
import { listSurfaces } from '../../session/surfaces';
// eslint-disable-next-line import/first
import { openRecentSurface, openSurface } from '../navigation';

function deferred() { let resolve!: (items: Awaited<ReturnType<typeof listSurfaces>>) => void; const promise = new Promise<Awaited<ReturnType<typeof listSurfaces>>>((done) => { resolve = done; }); return { resolve, promise }; }
const entry = (id: string) => ({ workspaceId: 'w', surfaceId: id, title: id, workspaceTitle: 'w', windowId: null, at: 0 });
const surface = (id: string) => ({ id, title: id, type: 'terminal', index: 0, focused: false });
beforeEach(() => {
  jest.clearAllMocks();
  const channel: RpcChannel = { isOpen: true, call: async <T>() => ({} as T), onPush: () => () => {}, onStatus: () => () => {} };
  mockMachine = { mode: 'demo', computer: null, channel, session: new TerminalSession(channel), workspaces: { selectWindow: async () => {} }, inbox: { markWorkspaceRead: () => {} } } as unknown as Machine;
});
afterEach(() => mockMachine.session.dispose());
it('the newer recent click wins even if the earlier lookup resolves first', async () => {
  const a = deferred(), b = deferred();
  jest.mocked(listSurfaces).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = openRecentSurface(mockMachine, entry('a')), second = openRecentSurface(mockMachine, entry('b'));
  a.resolve([surface('a')]); await first;
  expect(mockMachine.session.getState().target).toBeNull();
  b.resolve([surface('b')]); await second;
  expect(mockMachine.session.getState().target?.surfaceId).toBe('b');
});
it('a pending recent lookup cannot override a later direct terminal selection', async () => {
  const pending = deferred(); jest.mocked(listSurfaces).mockReturnValueOnce(pending.promise);
  const first = openRecentSurface(mockMachine, entry('a'));
  openSurface(mockMachine, 'w', 'b');
  pending.resolve([surface('a')]); await first;
  expect(mockMachine.session.getState().target?.surfaceId).toBe('b');
});
