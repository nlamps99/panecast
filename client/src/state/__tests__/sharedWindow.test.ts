jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `uuid-${++n}` };
});
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '9.9.9' } } }));
jest.mock('expo-device', () => ({ deviceName: 'Test Mac', modelName: 'Mac' }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn(async () => ({ type: 'WIFI', isConnected: true })), addNetworkStateListener: jest.fn(() => ({ remove() {} })) }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

/* eslint-disable import/first */
import { brokerTarget } from '../../notifications/registration';
import { isShareKey, parseShareKey } from '../../protocol/shareKey';
import { canManage, listWorkspaces } from '../../session/surfaces';
import type { RpcChannel } from '../../session/terminalSession';
import { upsertComputer, type ComputerList, type StoredComputer } from '../computers';
import { localGatewayFor, PairingError, sharedWindow } from '../connect';

/** What `panecast share` prints: pcs1. and base64url JSON. */
function key(fields: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return 'pcs1.' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const valid = { v: 1, s: 'https://broker.example/cmux-remote', r: 'home-mac', d: 'guest-1', t: 'secret-token', n: '论文 · 第三章' };

describe('share keys', () => {
  it('parses a key with a Chinese name and surrounding whitespace', () => {
    expect(parseShareKey(`  ${key(valid)}\n`)).toEqual({ serverUrl: valid.s, relayId: 'home-mac', deviceId: 'guest-1', token: 'secret-token', name: '论文 · 第三章' });
    expect(isShareKey(key(valid))).toBe(true);
  });

  it('rejects pairing links and damaged keys', () => {
    for (const raw of ['cmux://pair?server=x&relay=y&code=z', 'pcs1.', 'pcs1.not base64!', key({ ...valid, v: 2 }), key({ ...valid, t: '' }), key({ ...valid, d: 3 })]) {
      expect(parseShareKey(raw)).toBeNull();
    }
  });
});

describe('a shared window', () => {
  it('becomes its own entry without registering anything', () => {
    const computer = sharedWindow(key(valid));
    expect(computer.share).toEqual({ name: '论文 · 第三章' });
    expect(computer.name).toBe('论文 · 第三章');
    expect(computer.broker).toMatchObject({ relayId: 'home-mac', deviceId: 'guest-1', token: 'secret-token' });
    expect(computer.lan).toBeUndefined();
  });

  it('needs an https broker', () => {
    expect(() => sharedWindow(key({ ...valid, s: 'http://broker.example' }))).toThrow(PairingError);
    expect(() => sharedWindow('pcs1.broken')).toThrow(PairingError);
  });

  it('never replaces the paired computer it lives on, and re-adding the same key updates it in place', () => {
    const paired: StoredComputer = { id: 'mine', name: 'MacBook', broker: { serverUrl: 'https://broker.example/cmux-remote', relayId: 'home-mac', deviceId: 'owner', token: 'owner-token' }, pairedAt: '' };
    const start: ComputerList = { version: 2, selectedId: 'mine', computers: [paired] };
    const first = upsertComputer(start, sharedWindow(key(valid)));
    expect(first.list.computers.map((c) => c.broker.deviceId)).toEqual(['owner', 'guest-1']);
    const again = upsertComputer(first.list, sharedWindow(key({ ...valid, t: 'rotated' })));
    expect(again.list.computers.map((c) => c.broker.token)).toEqual(['owner-token', 'rotated']);
    const repaired = upsertComputer(again.list, { ...paired, id: 'new', broker: { ...paired.broker, token: 'fresh' } });
    expect(repaired.list.computers.map((c) => c.broker.token)).toEqual(['fresh', 'rotated']);
  });

  it('stays a guest on the computer that shares it', () => {
    const gateway = { webSocketUrl: 'ws://127.0.0.1:4400/v1/ws', healthUrl: 'http://127.0.0.1:4400/v1/health', token: 'local', deviceId: 'local', relayId: 'home-mac', brokerUrl: 'https://broker.example/cmux-remote' };
    expect(localGatewayFor(sharedWindow(key(valid)), gateway)).toBeNull();
    expect(localGatewayFor({ broker: { serverUrl: 'https://broker.example/cmux-remote', relayId: 'home-mac', deviceId: 'owner', token: 't' } }, gateway)).toBe(gateway);
  });

  it('never registers for push', () => {
    expect(brokerTarget(sharedWindow(key(valid)))).toBeNull();
  });

  it('takes input but offers no workspace management', async () => {
    const channel = { call: jest.fn(async () => ({ workspaces: [{ id: 'w', title: 'paper', access: 'shared' }] })) } as unknown as RpcChannel;
    const [workspace] = await listWorkspaces(channel);
    expect(workspace.access).toBe('shared');
    expect(canManage(workspace)).toBe(false);
    expect(canManage({ access: 'read' })).toBe(false);
    expect(canManage({ access: 'control' })).toBe(true);
    expect(canManage({})).toBe(true);
  });
});
