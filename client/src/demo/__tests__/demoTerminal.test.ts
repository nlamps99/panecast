import { CheckRun, NotesSync } from '../demoPrograms';
import { DemoTerminal, normalizeKey, type ShellProfile } from '../demoTerminal';
import { PANE_COLS, visibleWidth } from '../demoText';
import { plain } from '../testing/demoHarness';

const PROFILE: ShellProfile = {
  cwd: '~/code/demo',
  branch: 'main',
  listing: ['src/', 'README.md'],
  files: { 'README.md': ['# 示例项目', '一行说明'] },
  programs: [
    { command: './check', description: '跑一遍检查', start: (ctx) => new CheckRun(ctx, false) },
    { command: './sync.sh', description: '同步', start: (ctx) => new NotesSync(ctx) },
  ],
};

function shell() {
  const terminal = new DemoTerminal('t1', 'p1', 'surface:1', 'pane:1', 'zsh', PROFILE, { needsInput: () => {} });
  const screen = (lines = 6) => plain(terminal.screen(lines));
  /** The prompt (or a job's last live row): the row above the two blank rows at the bottom. */
  const promptLine = () => plain(terminal.screen(3))[0];
  return { terminal, screen, promptLine };
}

describe('DemoTerminal', () => {
  it('echoes Chinese text and deletes a whole character per backspace', () => {
    const { terminal, screen, promptLine } = shell();
    terminal.sendText('echo 你好');
    terminal.sendText('🙂');
    terminal.sendKey('backspace');
    terminal.sendKey('backspace');
    expect(promptLine()).toBe('~/code/demo main $ echo 你');
    terminal.sendText('们好');
    terminal.sendKey('enter');
    expect(screen(5).slice(0, 3)).toEqual(['~/code/demo main $ echo 你们好', '你们好', '~/code/demo main $']);
    // Padded to the pane width, with CJK counted as two cells.
    for (const row of terminal.snapshot()) expect(visibleWidth(row)).toBe(PANE_COLS);
  });

  it('treats CR, ^C, DEL and arrow escapes in send_text as keys', () => {
    const { terminal, screen } = shell();
    terminal.sendText('pwd\r');
    terminal.sendText('abc\u007f\u007fx\u0003');
    terminal.sendText('\u001b[A');
    expect(screen(6).slice(0, 4)).toEqual(['~/code/demo main $ pwd', '/Users/demo/code/demo', '~/code/demo main $ ax^C', '~/code/demo main $ pwd']);
  });

  it('recalls history with ↑/↓ and runs the canned builtins', () => {
    const { terminal, screen, promptLine } = shell();
    terminal.run('ls');
    terminal.run('cat README.md');
    terminal.sendKey('up');
    expect(promptLine()).toBe('~/code/demo main $ cat README.md');
    terminal.sendKey('up');
    terminal.sendKey('up');
    expect(promptLine()).toBe('~/code/demo main $ ls');
    terminal.sendKey('down');
    expect(promptLine()).toBe('~/code/demo main $ cat README.md');
    terminal.sendKey('down');
    expect(promptLine()).toBe('~/code/demo main $');

    expect(plain(terminal.snapshot()).slice(0, 5)).toEqual([
      '~/code/demo main $ ls',
      'src  README.md',
      '~/code/demo main $ cat README.md',
      '# 示例项目',
      '一行说明',
    ]);
    terminal.run('cat nope.txt');
    terminal.run('make deploy');
    expect(screen(7).slice(0, 4)).toEqual([
      '~/code/demo main $ cat nope.txt',
      'cat: nope.txt: 没有那个文件或目录',
      '~/code/demo main $ make deploy',
      '（演示模式：命令不会真的执行）',
    ]);
    terminal.run('help');
    expect(plain(terminal.snapshot()).some((row) => row.startsWith('  ./sync.sh') && row.endsWith('同步'))).toBe(true);

    terminal.sendText('draft');
    terminal.sendKey('ctrl-l');
    expect(plain(terminal.snapshot())).toEqual(['~/code/demo main $ draft', '', '']);
    terminal.sendKey('ctrl-u');
    terminal.run('clear');
    expect(plain(terminal.snapshot())).toEqual(['~/code/demo main $', '', '']);
  });

  it('gives the screen to a job until it finishes, and Ctrl-C stops it', () => {
    const { terminal, screen } = shell();
    terminal.run('./check');
    expect(terminal.busy).toBe(true);
    expect(screen(4)[0]).toMatch(/^. 检查 src\/protocol\/pairing\.check\.ts$/);
    terminal.sendText('typed while busy');
    for (let i = 0; i < 60 && terminal.busy; i++) terminal.tick();
    expect(terminal.busy).toBe(false);
    expect(plain(terminal.snapshot()).some((row) => row.startsWith('结果  137 项通过，共 137 项'))).toBe(true);
    expect(screen(3)[0]).toBe('~/code/demo main $');

    terminal.run('./check');
    terminal.tick();
    terminal.sendKey('ctrl-c');
    expect(terminal.busy).toBe(false);
    const rows = screen(6);
    expect(rows[2]).toMatch(/^ {2}.+% {2}\d\/7 个文件\^C$/);
    expect(rows[3]).toBe('~/code/demo main $');
  });

  it('takes a typed answer at a [Y/n] prompt', () => {
    const { terminal, screen } = shell();
    terminal.run('./sync.sh');
    terminal.sendText('n');
    expect(screen(3)[0]).toBe('同步到备份文件夹吗？[Y/n] n');
    terminal.sendKey('enter');
    expect(terminal.busy).toBe(false);
    expect(screen(5).slice(0, 3)).toEqual(['已取消，笔记没有同步。', '', '~/code/demo main $']);
  });

  it('keeps no more than its scrollback limit', () => {
    const { terminal } = shell();
    for (let i = 0; i < 2_000; i++) terminal.print(`line ${i}`);
    const rows = plain(terminal.snapshot());
    expect(rows).toHaveLength(1_503);
    expect(rows[0]).toBe('line 500');
  });

  it('normalizes cmux key names', () => {
    expect(normalizeKey('Ctrl+C')).toBe('ctrl-c');
    expect(normalizeKey('ESC')).toBe('escape');
    expect(normalizeKey('return')).toBe('enter');
    expect(normalizeKey('up')).toBe('up');
  });
});

describe('CheckRun in watch mode', () => {
  it('starts the next round at once on ↵ while it waits', () => {
    const rows: string[] = [];
    const run = new CheckRun({ print: (...r) => rows.push(...r), needsInput: () => {} }, true, 1);
    expect(run.key('enter')).toBe(false);
    for (let i = 0; i < 100 && plain(run.live())[0] !== '等待文件变化…'; i++) run.tick();
    expect(plain(run.live())).toEqual(['等待文件变化…']);
    expect(run.key('enter')).toBe(true);
    expect(plain(rows).slice(-2)).toEqual(['手动重新检查', expect.stringMatching(/^── 第 2 轮 · \d\d:\d\d:\d\d ──$/)]);
    expect(plain(run.live())[0]).toMatch(/检查 src\/protocol\/pairing\.check\.ts$/);
    expect(run.done).toBe(false);
  });
});
