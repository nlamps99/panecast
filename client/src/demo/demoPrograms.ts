import type { DemoJob, JobContext } from './demoTerminal';
import { bold, clockTime, color256, cyan, dim, green, logTime, pick, red, rgb, seededRandom, yellow } from './demoText';

/**
 * The foreground programs of the demo terminals. Each advances one step per
 * demo tick (500 ms) and redraws its bottom rows, so a subscribed screen gets
 * a `screen.diff` every tick. All are invented; none imitates a real tool.
 */

/** Spinner frames; GeistMono has the block elements, not braille. */
const SPINNER = ['▁', '▃', '▅', '▇', '█', '▇', '▅', '▃'];

function progressBar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return color256(39, '█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

const spinner = (frame: number) => rgb(255, 170, 60, SPINNER[frame % SPINNER.length]);

// MARK: ./scripts/check

const CHECK_FILES: readonly { path: string; checks: number }[] = [
  { path: 'src/protocol/pairing.check.ts', checks: 14 },
  { path: 'src/protocol/connection.check.ts', checks: 31 },
  { path: 'src/protocol/screen.check.ts', checks: 18 },
  { path: 'src/session/terminalSession.check.ts', checks: 27 },
  { path: 'src/terminal/layout.check.ts', checks: 22 },
  { path: 'src/terminal/ansi.check.ts', checks: 16 },
  { path: 'src/input/translate.check.ts', checks: 9 },
];

export const CHECK_TOTAL = CHECK_FILES.reduce((sum, file) => sum + file.checks, 0);

/** Ticks of quiet between rounds in watch mode. */
const CHECK_IDLE_TICKS = 12;

function checkFileRow(file: { path: string; checks: number }, ms: number, skipped: number): string {
  return skipped > 0
    ? `${yellow('○')} ${file.path} ${dim(`${file.checks - skipped} 项通过，${skipped} 项跳过 · ${ms} ms`)}`
    : `${green('●')} ${file.path} ${dim(`${file.checks} 项 · ${ms} ms`)}`;
}

function checkSummaryRow(passed: number, skipped: number, ms: number): string {
  const skippedText = skipped > 0 ? `，${yellow(`${skipped} 项跳过`)}` : '';
  return `${bold('结果')}  ${green(`${passed} 项通过`)}${skippedText}，共 ${CHECK_TOTAL} 项 · ${(ms / 1000).toFixed(2)} s`;
}

/** A finished one-off `./scripts/check`, for canned scrollback: every check passes. */
export function finishedCheckRows(): string[] {
  const random = seededRandom(7);
  let total = 0;
  const rows = CHECK_FILES.map((file) => {
    const ms = 120 + Math.floor(random() * 380);
    total += ms;
    return checkFileRow(file, ms, 0);
  });
  return [...rows, checkSummaryRow(CHECK_TOTAL, 0, total)];
}

/**
 * `./scripts/check`: checks one file after another under a spinner and a
 * progress bar. With `--watch` it waits after each round and starts again,
 * as if a file had been saved; ↵ starts the next round at once.
 */
export class CheckRun implements DemoJob {
  done = false;
  private readonly random: () => number;
  private round = 0;
  private fileIndex = 0;
  private fileTick = 0;
  private fileTicks = 1;
  private elapsedMs = 0;
  private passed = 0;
  private skipped = 0;
  private frame = 0;
  /** Ticks left before the next round; 0 while a round runs. */
  private waiting = 0;

  constructor(
    private readonly ctx: JobContext,
    private readonly watch: boolean,
    seed = 11,
  ) {
    this.random = seededRandom(seed);
    if (watch) ctx.print(dim('监视模式：保存文件会自动重新检查。按 ↵ 立即重新检查，Ctrl-C 退出。'), '');
    this.startRound();
  }

  live(): string[] {
    if (this.waiting > 0) return [dim('等待文件变化…')];
    const file = CHECK_FILES[this.fileIndex];
    const progress = (this.fileIndex + this.fileTick / this.fileTicks) / CHECK_FILES.length;
    const percent = String(Math.floor(progress * 100)).padStart(3);
    return [
      `${spinner(this.frame)} ${dim('检查')} ${file.path}`,
      `  ${progressBar(progress, 24)} ${percent}%  ${dim(`${this.fileIndex}/${CHECK_FILES.length} 个文件`)}`,
    ];
  }

  tick(): void {
    this.frame++;
    if (this.waiting > 0) {
      this.waiting--;
      if (this.waiting === 0) {
        this.ctx.print(dim(`检测到改动：${pick(this.random, CHECK_FILES).path.replace('.check', '')}`));
        this.startRound();
      }
      return;
    }
    this.fileTick++;
    if (this.fileTick >= this.fileTicks) this.finishFile();
  }

  key(name: string): boolean {
    if (name !== 'enter' || this.waiting === 0) return false;
    this.waiting = 0;
    this.ctx.print(dim('手动重新检查'));
    this.startRound();
    return true;
  }

  private startRound(): void {
    this.round++;
    this.fileIndex = 0;
    this.elapsedMs = 0;
    this.passed = 0;
    this.skipped = 0;
    if (this.watch) this.ctx.print(dim(`── 第 ${this.round} 轮 · ${clockTime(Date.now())} ──`));
    this.nextFile();
  }

  private nextFile(): void {
    this.fileTick = 0;
    this.fileTicks = 2 + Math.floor(this.random() * 5);
  }

  private finishFile(): void {
    const file = CHECK_FILES[this.fileIndex];
    const ms = this.fileTicks * 90 + Math.floor(this.random() * 120);
    // The first round is all green; later ones skip a check now and then.
    const skipped = this.watch && this.round > 1 && this.random() < 0.12 ? 1 : 0;
    this.elapsedMs += ms;
    this.passed += file.checks - skipped;
    this.skipped += skipped;
    this.ctx.print(checkFileRow(file, ms, skipped));
    this.fileIndex++;
    if (this.fileIndex < CHECK_FILES.length) {
      this.nextFile();
      return;
    }
    this.ctx.print(checkSummaryRow(this.passed, this.skipped, this.elapsedMs), '');
    if (this.watch) this.waiting = CHECK_IDLE_TICKS;
    else this.done = true;
  }
}

// MARK: tail -f logs/server.log

const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '重庆', '厦门', '哈尔滨'];
const PROVINCES = ['广东', '浙江', '四川', '湖北', '福建', '黑龙江'];

/** Average spacing of the backlog lines, so their timestamps end about now. */
const LOG_SPACING_MS = 1_700;

/** One line of the pretend weather service's log. */
function logLine(random: () => number, at: number): string {
  const time = dim(logTime(at));
  const roll = random();
  if (roll < 0.03) return `${time} ${red('ERROR')} 推送通道连接超时，5 秒后重试（第 ${1 + Math.floor(random() * 3)} 次）`;
  if (roll < 0.1) {
    return `${time} ${yellow('WARN ')} 上游气象数据晚到 ${(1.2 + random() * 3).toFixed(1)} s，先用缓存（${pick(random, CITIES)}）`;
  }
  if (roll < 0.18) return `${time} ${cyan('INFO ')} 刷新缓存：${pick(random, CITIES)} 未来 7 天预报`;
  const routes = [
    () => `GET  /v1/now?city=${pick(random, CITIES)}`,
    () => `GET  /v1/forecast?city=${pick(random, CITIES)}&days=7`,
    () => `GET  /v1/air?city=${pick(random, CITIES)}`,
    () => `GET  /v1/alerts?province=${pick(random, PROVINCES)}`,
    () => 'POST /v1/subscriptions',
  ];
  const route = pick(random, routes)();
  const status = route.startsWith('POST') ? green('201') : random() < 0.2 ? dim('304') : green('200');
  return `${time} ${cyan('INFO ')} ${route} ${status} ${dim(`${4 + Math.floor(random() * 80)} ms`)}`;
}

/** `tail -f`: prints a backlog, then a new line every one to two seconds. */
export class LogTail implements DemoJob {
  done = false;
  private readonly random: () => number;
  private wait: number;

  constructor(
    private readonly ctx: JobContext,
    options: { backlog: number; banner?: boolean },
    seed = 3,
  ) {
    this.random = seededRandom(seed);
    const now = Date.now();
    const rows: string[] = [];
    if (options.banner) {
      const at = now - (options.backlog + 30) * LOG_SPACING_MS;
      rows.push(`${dim(logTime(at))} ${cyan('INFO ')} weather-service v1.3.2 启动，监听 0.0.0.0:8080`);
    }
    for (let i = options.backlog; i > 0; i--) rows.push(logLine(this.random, now - i * LOG_SPACING_MS));
    ctx.print(...rows);
    this.wait = this.nextWait();
  }

  live(): string[] {
    return [];
  }

  tick(): void {
    this.wait--;
    if (this.wait > 0) return;
    this.ctx.print(logLine(this.random, Date.now()));
    this.wait = this.nextWait();
  }

  private nextWait(): number {
    return 2 + Math.floor(this.random() * 3);
  }
}

// MARK: ./scripts/release.sh

type ReleaseStep = {
  title(version: string): string;
  options: readonly string[];
  initial: number;
  /** What picking `choice` sets off; null when there is nothing to do. */
  outcome(choice: number, version: string): { doing: string; done: string } | null;
};

const ENVIRONMENTS = ['测试环境', '预发布环境', '正式环境'];

const RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    title: (version) => `要把 ${version} 发布到哪个环境？`,
    options: [...ENVIRONMENTS, '先不发'],
    initial: 0,
    outcome: (choice, version) =>
      choice < ENVIRONMENTS.length
        ? { doing: `正在发布到${ENVIRONMENTS[choice]}`, done: `${version} 已发布到${ENVIRONMENTS[choice]}` }
        : null,
  },
  {
    title: () => '要通知订阅了更新的用户吗？',
    options: ['发送更新说明', '只通知团队', '不通知'],
    initial: 1,
    outcome: (choice) =>
      choice === 2 ? null : { doing: '正在发送通知', done: choice === 0 ? '已向 1,284 位订阅用户发送更新说明' : '已在团队频道贴出更新说明' },
  },
  {
    title: () => '还有 2 个旧版本实例在运行，要停掉吗？',
    options: ['现在停掉', '24 小时后停掉', '先不处理'],
    initial: 1,
    outcome: (choice) =>
      choice === 2
        ? null
        : choice === 0
          ? { doing: '正在停止旧版本实例', done: '旧版本实例已停止' }
          : { doing: '正在设置定时任务', done: '旧版本实例会在 24 小时后停止' },
  },
];

const RELEASE_WORK_TICKS = 6;
/** Ticks between finishing one question and asking the next. */
const RELEASE_IDLE_TICKS = 16;

const RELEASE_SOURCE = 'release-helper';

/**
 * `./scripts/release.sh`: an interactive helper that asks one multiple-choice
 * question at a time (↑/↓ to move, ↵ to pick, Esc to skip), does a few
 * seconds of work, rests, and asks the next. Each question raises a "needs
 * input" notification, like an agent waiting for an answer.
 */
export class ReleaseHelper implements DemoJob {
  done = false;
  private step = 0;
  private patch = 0;
  private selected = 0;
  private phase: 'asking' | 'working' | 'idle' = 'asking';
  private progress = 0;
  private wait = 0;
  private doing = '';
  private result = '';

  constructor(private readonly ctx: JobContext) {
    ctx.print(`${bold(cyan('发布助手'))} ${dim('· weather-service')}`, '');
    this.ask();
  }

  private get version(): string {
    return `v1.4.${this.patch}`;
  }

  live(): string[] {
    if (this.phase === 'working') {
      return [`${spinner(this.progress)} ${this.doing}  ${progressBar(this.progress / RELEASE_WORK_TICKS, 16)}`];
    }
    if (this.phase === 'idle') return [dim('等待下一项任务…（Ctrl-C 退出）')];
    const step = RELEASE_STEPS[this.step];
    return [
      `${cyan('?')} ${bold(step.title(this.version))}`,
      ...step.options.map((option, i) => (i === this.selected ? cyan(`› ● ${option}`) : dim(`  ○ ${option}`))),
      dim('  ↑/↓ 选择，↵ 确认，Esc 跳过'),
    ];
  }

  key(name: string): boolean {
    if (this.phase !== 'asking') return false;
    const count = RELEASE_STEPS[this.step].options.length;
    switch (name) {
      case 'up':
        this.selected = (this.selected + count - 1) % count;
        return true;
      case 'down':
      case 'tab':
        this.selected = (this.selected + 1) % count;
        return true;
      case 'enter':
        this.answer();
        return true;
      case 'escape':
        this.ctx.print(`${yellow('○')} ${RELEASE_STEPS[this.step].title(this.version)} ${dim('已跳过')}`, '');
        this.rest();
        return true;
      default:
        return false;
    }
  }

  tick(): void {
    if (this.phase === 'working') {
      this.progress++;
      if (this.progress >= RELEASE_WORK_TICKS) {
        this.ctx.print(`  ${green(this.result)}`, '');
        this.rest();
      }
    } else if (this.phase === 'idle') {
      this.wait--;
      if (this.wait <= 0) this.ask();
    }
  }

  private answer(): void {
    const step = RELEASE_STEPS[this.step];
    this.ctx.print(`${green('●')} ${step.title(this.version)} ${cyan(step.options[this.selected])}`);
    const outcome = step.outcome(this.selected, this.version);
    if (!outcome) {
      this.ctx.print(dim('  好的，这一步先跳过'), '');
      this.rest();
      return;
    }
    this.phase = 'working';
    this.progress = 0;
    this.doing = outcome.doing;
    this.result = outcome.done;
  }

  private rest(): void {
    this.phase = 'idle';
    this.wait = RELEASE_IDLE_TICKS;
    this.step = (this.step + 1) % RELEASE_STEPS.length;
    if (this.step === 0) this.patch++;
  }

  private ask(): void {
    this.phase = 'asking';
    const step = RELEASE_STEPS[this.step];
    this.selected = step.initial;
    this.ctx.needsInput({
      title: '发布助手在等你选择',
      body: `${step.title(this.version)}回到终端用 ↑/↓ 选择，按 ↵ 确认。`,
      source: RELEASE_SOURCE,
    });
  }
}

// MARK: ./sync.sh

const NEW_NOTES = ['会议记录-周一.md', '读书笔记.md', '待办.md'];

/** `./sync.sh`: lists new notes and asks `[Y/n]`; the answer is typed text plus ↵ (empty means yes). */
export class NotesSync implements DemoJob {
  done = false;
  private answer = '';
  /** Ticks of syncing so far; -1 while asking. */
  private progress = -1;

  constructor(private readonly ctx: JobContext) {
    ctx.print(`发现 ${NEW_NOTES.length} 条新笔记：`, ...NEW_NOTES.map((name) => `  ${green('+')} ${name}`));
  }

  private get question(): string {
    return `同步到备份文件夹吗？[Y/n] ${this.answer}`;
  }

  live(): string[] {
    if (this.progress < 0) return [this.question];
    return [`${spinner(this.progress)} 正在同步 ${Math.min(NEW_NOTES.length, this.progress + 1)}/${NEW_NOTES.length}`];
  }

  text(text: string): void {
    if (this.progress < 0) this.answer += text;
  }

  key(name: string): boolean {
    if (this.progress >= 0) return false;
    if (name === 'backspace') {
      this.answer = Array.from(this.answer).slice(0, -1).join('');
      return true;
    }
    if (name !== 'enter') return false;
    const reply = this.answer.trim().toLowerCase();
    this.ctx.print(this.question);
    this.answer = '';
    if (['', 'y', 'yes', '是', '好'].includes(reply)) {
      this.progress = 0;
    } else if (['n', 'no', '否', '不'].includes(reply)) {
      this.ctx.print(dim('已取消，笔记没有同步。'), '');
      this.done = true;
    } else {
      this.ctx.print(red('请输入 y 或 n。'));
    }
    return true;
  }

  tick(): void {
    if (this.progress < 0) return;
    this.progress++;
    if (this.progress > NEW_NOTES.length) {
      this.ctx.print(green(`已同步 ${NEW_NOTES.length} 条笔记到 ~/备份/笔记`), '');
      this.done = true;
    }
  }
}
