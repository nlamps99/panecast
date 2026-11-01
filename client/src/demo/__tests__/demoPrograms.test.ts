import { Keys } from '../../protocol/keys';
import { InboxStore } from '../../session/inboxStore';
import { TerminalSession } from '../../session/terminalSession';
import { DemoChannel } from '../demoChannel';
import { isNeedsInputEvent, Mirror, namesARealAgent, plain, rpc } from '../testing/demoHarness';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function openTerminal(channel: DemoChannel, workspaceId: string, surfaceId: string) {
  const session = new TerminalSession(channel);
  session.setTarget({ workspaceId, surfaceId });
  await jest.advanceTimersByTimeAsync(200);
  expect(session.getState().subscription).toBe('live');
  const screen = () => plain(session.getState().screen.rows);
  return { session, screen };
}

describe('demo notifications', () => {
  it('sends the two canned notifications and a needs-input one for the waiting choice prompt', async () => {
    const channel = new DemoChannel();
    const inbox = new InboxStore(channel);
    const mirror = new Mirror(channel);
    await rpc(channel, 'workspace.list', {}, 1_000);

    expect(inbox.getState().items.map((item) => item.id)).toEqual(['demo-input-1', 'demo-n-2', 'demo-n-1']);
    expect(inbox.getState().items[0]).toMatchObject({
      workspaceId: 'demo-ws-3',
      surfaceId: 'demo-sf-5',
      title: '发布助手在等你选择',
      subtitle: '天气服务 · 发布助手',
    });
    const [needsInput, ...others] = [...mirror.events].reverse();
    expect(isNeedsInputEvent(needsInput)).toBe(true);
    expect(namesARealAgent(needsInput)).toBe(false);
    expect(others.some(isNeedsInputEvent)).toBe(false);

    // Only once per demo.
    await rpc(channel, 'workspace.list', {}, 1_000);
    expect(inbox.getState().items).toHaveLength(3);
    inbox.dispose();
    mirror.dispose();
  });
});

describe('demo programs', () => {
  it('answers the release helper with ↑/↓ and ↵, then asks the next question with a new notification', async () => {
    const channel = new DemoChannel();
    const inbox = new InboxStore(channel);
    await rpc(channel, 'workspace.list', {}, 1_000);
    const { session, screen } = await openTerminal(channel, 'demo-ws-3', 'demo-sf-5');

    expect(screen().slice(-8, -2)).toEqual([
      '? 要把 v1.4.0 发布到哪个环境？',
      '› ● 测试环境',
      '  ○ 预发布环境',
      '  ○ 正式环境',
      '  ○ 先不发',
      '  ↑/↓ 选择，↵ 确认，Esc 跳过',
    ]);

    session.sendKey(Keys.down);
    session.sendKey(Keys.down);
    session.sendKey(Keys.up);
    await jest.advanceTimersByTimeAsync(400);
    expect(screen()).toContain('› ● 预发布环境');
    expect(screen()).toContain('  ○ 测试环境');

    session.sendKey(Keys.enter);
    await jest.advanceTimersByTimeAsync(300);
    expect(screen()).toContain('● 要把 v1.4.0 发布到哪个环境？ 预发布环境');
    expect(screen().some((row) => row.includes('正在发布到预发布环境'))).toBe(true);

    await jest.advanceTimersByTimeAsync(4_000);
    expect(screen()).toContain('  v1.4.0 已发布到预发布环境');
    expect(screen()).toContain('等待下一项任务…（Ctrl-C 退出）');

    await jest.advanceTimersByTimeAsync(9_000);
    expect(screen()).toContain('? 要通知订阅了更新的用户吗？');
    expect(inbox.getState().items[0]).toMatchObject({
      id: 'demo-input-2',
      surfaceId: 'demo-sf-5',
      body: '要通知订阅了更新的用户吗？回到终端用 ↑/↓ 选择，按 ↵ 确认。',
    });

    // Esc skips a question; Ctrl-C leaves the helper for the shell.
    session.sendKey(Keys.escape);
    await jest.advanceTimersByTimeAsync(300);
    expect(screen()).toContain('○ 要通知订阅了更新的用户吗？ 已跳过');
    session.sendKey(Keys.ctrlC);
    await jest.advanceTimersByTimeAsync(300);
    expect(screen()).toContain('等待下一项任务…（Ctrl-C 退出）^C');
    expect(screen()[screen().length - 3]).toBe('~/code/weather-service release/1.4 $');

    // Running it again starts over.
    session.submitLine('./scripts/release.sh');
    await jest.advanceTimersByTimeAsync(400);
    expect(screen()).toContain('? 要把 v1.4.0 发布到哪个环境？');
    session.dispose();
    inbox.dispose();
  });

  it('keeps the watch-mode check run changing while subscribed', async () => {
    const channel = new DemoChannel();
    const { session, screen } = await openTerminal(channel, 'demo-ws-1', 'demo-sf-2');
    const progress = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(500);
      progress.add(screen()[screen().length - 3]);
    }
    // A new progress row (spinner, bar, percentage) on almost every tick.
    expect(progress.size).toBeGreaterThan(10);
    expect(screen().some((row) => /^● src\/protocol\/pairing\.check\.ts 14 项 · \d+ ms$/.test(row))).toBe(true);

    // It finishes a round, waits, notices a change and starts the next.
    await jest.advanceTimersByTimeAsync(40_000);
    const rows = screen();
    expect(rows.some((row) => /^结果 {2}\d+ 项通过/.test(row))).toBe(true);
    expect(rows.some((row) => row.startsWith('检测到改动：'))).toBe(true);
    expect(rows.some((row) => row.startsWith('── 第 2 轮'))).toBe(true);
    session.dispose();
  });

  it('asks [Y/n] in the notes terminal and takes a typed answer', async () => {
    const channel = new DemoChannel();
    const { session, screen } = await openTerminal(channel, 'demo-ws-2', 'demo-sf-3');
    expect(screen()[screen().length - 3]).toBe('同步到备份文件夹吗？[Y/n]');

    session.submitLine('好吧');
    await jest.advanceTimersByTimeAsync(300);
    expect(screen().slice(-5, -2)).toEqual(['同步到备份文件夹吗？[Y/n] 好吧', '请输入 y 或 n。', '同步到备份文件夹吗？[Y/n]']);

    session.sendText('y');
    await jest.advanceTimersByTimeAsync(300);
    expect(screen()[screen().length - 3]).toBe('同步到备份文件夹吗？[Y/n] y');
    session.sendKey(Keys.enter);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(screen().slice(-5)).toEqual(['已同步 3 条笔记到 ~/备份/笔记', '', '~/notes $', '', '']);
    session.dispose();
  });
});
