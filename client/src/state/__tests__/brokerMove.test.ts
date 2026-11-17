import { moveComputers, movedBroker } from '../brokerMove';
import type { ComputerList, StoredComputer } from '../computers';

const computer = (id: string, serverUrl: string, share?: { name: string }): StoredComputer => ({
  id, name: id, broker: { serverUrl, relayId: 'r', deviceId: `d-${id}`, token: `t-${id}` }, pairedAt: '', ...(share ? { share } : {}),
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('broker moves', () => {
  it('follows the address the broker reports once the new address confirms it', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return reply({ ok: true, server_url: 'https://panecast.drinklake.com/cmux-remote' });
    }) as unknown as typeof fetch;
    expect(await movedBroker('https://ningzx.cn/cmux-remote/', fetchImpl)).toBe('https://panecast.drinklake.com/cmux-remote');
    expect(calls).toEqual(['https://ningzx.cn/cmux-remote/v1/health', 'https://panecast.drinklake.com/cmux-remote/v1/health']);
  });

  it('stays put when nothing moved or the new address does not confirm', async () => {
    const same = (async () => reply({ ok: true, server_url: 'https://ningzx.cn/cmux-remote' })) as unknown as typeof fetch;
    expect(await movedBroker('https://ningzx.cn/cmux-remote', same)).toBeNull();
    expect(await movedBroker('https://ningzx.cn/cmux-remote', (async () => reply({ ok: true })) as unknown as typeof fetch)).toBeNull();
    const insecure = (async () => reply({ ok: true, server_url: 'http://evil.example' })) as unknown as typeof fetch;
    expect(await movedBroker('https://ningzx.cn/cmux-remote', insecure)).toBeNull();
    let n = 0;
    const unconfirmed = (async () => (++n === 1 ? reply({ ok: true, server_url: 'https://new.example/x' }) : reply({ error: 'x' }, 404))) as unknown as typeof fetch;
    expect(await movedBroker('https://ningzx.cn/cmux-remote', unconfirmed)).toBeNull();
    expect(await movedBroker('https://ningzx.cn/cmux-remote', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('moves every computer and shared window on the old address, keeping credentials', () => {
    const list: ComputerList = { version: 2, selectedId: 'a', computers: [
      computer('a', 'https://ningzx.cn/cmux-remote'), computer('b', 'https://ningzx.cn/cmux-remote-air'), computer('c', 'https://ningzx.cn/cmux-remote/', { name: '论文' }),
    ] };
    const moved = moveComputers(list, 'https://ningzx.cn/cmux-remote', 'https://panecast.drinklake.com/cmux-remote');
    expect(moved.computers.map((c) => c.broker.serverUrl)).toEqual(['https://panecast.drinklake.com/cmux-remote', 'https://ningzx.cn/cmux-remote-air', 'https://panecast.drinklake.com/cmux-remote']);
    expect(moved.computers[0].broker.token).toBe('t-a');
    expect(moved.selectedId).toBe('a');
    expect(moveComputers(list, 'https://other.example', 'https://x.example')).toBe(list);
  });
});
