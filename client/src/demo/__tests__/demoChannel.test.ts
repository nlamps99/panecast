import { pickDefaultTarget } from '../../session/surfaces';
import { TerminalSession } from '../../session/terminalSession';
import { DemoChannel } from '../demoChannel';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const plain = (rows: readonly string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());

describe('DemoChannel', () => {
  it('behaves like a relay: subscribe, matching checksums, input echo, history', async () => {
    const channel = new DemoChannel();
    const session = new TerminalSession(channel);
    const calls = jest.spyOn(channel, 'call');

    const targetPromise = pickDefaultTarget(channel);
    await jest.advanceTimersByTimeAsync(200);
    const target = await targetPromise;
    expect(target).toEqual({ workspaceId: 'demo-ws-1', surfaceId: 'demo-sf-1' });

    session.setTarget(target);
    await jest.advanceTimersByTimeAsync(200);
    expect(session.getState().subscription).toBe('live');
    expect(session.getState().screen.rows).toHaveLength(120);

    // Two checksum rounds: the session's hash agrees, so it never resubscribes.
    await jest.advanceTimersByTimeAsync(10_500);
    expect(calls.mock.calls.filter(([method]) => method === 'surface.unsubscribe')).toHaveLength(0);

    session.submitLine('ls');
    await jest.advanceTimersByTimeAsync(500);
    const rows = plain(session.getState().screen.rows);
    expect(rows).toContain('~/code/panecast main $ ls');
    expect(rows).toContain('（演示模式：命令不会真的执行）');

    session.startBrowsing();
    const load = session.loadOlder();
    await jest.advanceTimersByTimeAsync(200);
    await load;
    const browse = session.getState().browse!;
    expect(browse.error).toBeNull();
    // The demo scrollback fits one page: everything above the live window, oldest first.
    expect(plain(browse.olderRows)[0]).toBe('[build] 001 compiled src/module-1/index.ts in 17 ms');
    expect(browse.exhausted).toBe(true);
    session.dispose();
  });
});
