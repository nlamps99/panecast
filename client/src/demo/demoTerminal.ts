import { absolutePath, blue, bold, dim, green, padEnd, padRow, red } from './demoText';

/** Rows of scrollback each demo terminal keeps, oldest dropped first. */
const MAX_SCROLLBACK = 1_500;

/** A pending question an agent in this terminal is waiting on the user for. */
export type InputRequest = { title: string; body: string; source: string };

/** What a foreground job may do to its terminal. */
export type JobContext = {
  /** Appends committed rows to the scrollback. */
  print(...rows: string[]): void;
  /** Raises a "needs input" notification for this terminal. */
  needsInput(request: InputRequest): void;
};

/**
 * A foreground program. It owns the bottom of the screen (`live()`) until it
 * sets `done`; committed output goes through `JobContext.print`.
 */
export interface DemoJob {
  readonly done: boolean;
  /** Rows below the scrollback that the job redraws in place (spinners, menus). */
  live(): string[];
  /** Called every 500 ms while the demo ticks. */
  tick?(): void;
  /** Returns true when the job used the key; unused Ctrl-C interrupts it. */
  key?(name: string): boolean;
  /** Typed text. Jobs without it ignore typing. */
  text?(text: string): void;
}

export type ProgramSpec = {
  /** The command line that starts it, e.g. `./scripts/check --watch`. */
  command: string;
  description: string;
  start(ctx: JobContext): DemoJob;
};

/** The canned world one shell sees: where it is, what `ls` and `cat` show, what it can run. */
export type ShellProfile = {
  cwd: string;
  branch?: string;
  listing: readonly string[];
  files?: Readonly<Record<string, readonly string[]>>;
  programs?: readonly ProgramSpec[];
};

type TerminalHooks = {
  needsInput(terminalId: string, request: InputRequest): void;
};

/** `~/code/panecast main $` with colours, as the demo shells draw it. */
export function promptPrefix(profile: Pick<ShellProfile, 'cwd' | 'branch'>): string {
  return `${green(profile.cwd)}${profile.branch ? ` ${dim(profile.branch)}` : ''} $`;
}

/** `ls` output: directories (trailing `/`) in bold blue, two spaces apart. */
export function listingRow(listing: readonly string[]): string {
  return listing.map((name) => (name.endsWith('/') ? bold(blue(name.slice(0, -1))) : name)).join('  ');
}

const BUILTINS: readonly [string, string][] = [
  ['ls', '列出文件'],
  ['cat <文件>', '查看文件内容'],
  ['echo <文字>', '原样输出，可以试试中文输入法'],
  ['pwd', '当前目录'],
  ['date', '电脑上的时间'],
  ['clear', '清屏（也可以按 Ctrl-L）'],
];

/**
 * One pretend shell. Rows are kept with SGR colours and padded to the pane
 * width when drawn, like cmux pads `surface.read_text`.
 */
export class DemoTerminal {
  private transcript: string[] = [];
  private input = '';
  private history: string[] = [];
  private historyIndex: number | null = null;
  private job: DemoJob | null = null;

  constructor(
    readonly id: string,
    readonly paneId: string,
    readonly ref: string,
    readonly paneRef: string,
    public title: string,
    readonly profile: ShellProfile,
    private readonly hooks: TerminalHooks,
  ) {}

  get prompt(): string {
    return promptPrefix(this.profile);
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Appends rows without a command, for canned scrollback. */
  print(...rows: string[]): void {
    for (const row of rows) this.transcript.push(padRow(row));
    const excess = this.transcript.length - MAX_SCROLLBACK;
    if (excess > 0) this.transcript.splice(0, excess);
  }

  /** As if the user typed `command` and pressed Enter. */
  run(command: string): void {
    this.input = command;
    this.submit();
  }

  /** Echoes `command` at the prompt and starts `job` in the foreground (seeding only). */
  launch(command: string, start: (ctx: JobContext) => DemoJob): void {
    this.print(`${this.prompt} ${command}`);
    this.history.push(command);
    this.job = start(this.context());
    this.reap();
  }

  /** Every row of scrollback plus the screen below it, padded; what `surface.read_text` returns. */
  snapshot(): string[] {
    return [...this.transcript, ...this.tail()];
  }

  /** The last `lines` rows of `snapshot()`, without copying the whole scrollback. */
  screen(lines: number): string[] {
    const tail = this.tail();
    const fromTranscript = Math.max(0, Math.min(this.transcript.length, lines - tail.length));
    const rows = [...this.transcript.slice(this.transcript.length - fromTranscript), ...tail];
    return rows.length > lines ? rows.slice(rows.length - lines) : rows;
  }

  /** The prompt line (or the job's rows) and two blank rows under it. */
  private tail(): string[] {
    const live = this.job ? this.job.live() : [`${this.prompt} ${this.input}`];
    return [...live, '', ''].map(padRow);
  }

  tick(): void {
    if (!this.job) return;
    this.job.tick?.();
    this.reap();
  }

  /** `surface.send_text`: printable text goes to the line (or job); CR, LF, ^C and DEL act as keys. */
  sendText(text: string): void {
    let buffer = '';
    const flush = () => {
      if (buffer) this.typeText(buffer);
      buffer = '';
    };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const code = char.charCodeAt(0);
      if (char === '\r' || char === '\n') {
        flush();
        this.sendKey('enter');
        if (char === '\r' && text[i + 1] === '\n') i++;
      } else if (code === 0x1b) {
        flush();
        const arrow = /^\[([ABCD])/.exec(text.slice(i + 1, i + 3));
        if (arrow) {
          this.sendKey({ A: 'up', B: 'down', C: 'right', D: 'left' }[arrow[1] as 'A' | 'B' | 'C' | 'D']);
          i += 2;
        } else {
          this.sendKey('escape');
        }
      } else if (code === 0x03) {
        flush();
        this.sendKey('ctrl-c');
      } else if (code === 0x7f || code === 0x08) {
        flush();
        this.sendKey('backspace');
      } else if (code >= 0x20) {
        buffer += char;
      }
    }
    flush();
  }

  /** `surface.send_key` with a cmux key name (`enter`, `up`, `ctrl-c`, …). */
  sendKey(rawKey: string): void {
    const key = normalizeKey(rawKey);
    if (this.job) {
      const used = this.job.key?.(key) ?? false;
      if (!used && key === 'ctrl-c') this.interrupt();
      this.reap();
      return;
    }
    switch (key) {
      case 'enter':
        this.submit();
        break;
      case 'backspace':
        this.input = dropLast(this.input);
        break;
      case 'ctrl-c':
        this.print(`${this.prompt} ${this.input}^C`);
        this.input = '';
        this.historyIndex = null;
        break;
      case 'ctrl-u':
        this.input = '';
        break;
      case 'ctrl-l':
        this.transcript = [];
        break;
      case 'up':
        this.recall(-1);
        break;
      case 'down':
        this.recall(1);
        break;
      default:
        // Tab, Esc, the other arrows and Home/End do nothing at this prompt.
        break;
    }
  }

  private typeText(text: string): void {
    if (this.job) {
      this.job.text?.(text);
      this.reap();
      return;
    }
    this.input += text;
    this.historyIndex = null;
  }

  private recall(step: -1 | 1): void {
    if (this.history.length === 0) return;
    const current = this.historyIndex ?? this.history.length;
    const next = Math.min(this.history.length, Math.max(0, current + step));
    this.historyIndex = next === this.history.length ? null : next;
    this.input = next === this.history.length ? '' : this.history[next];
  }

  private submit(): void {
    const line = this.input;
    this.input = '';
    this.historyIndex = null;
    this.print(`${this.prompt} ${line}`);
    const command = line.trim();
    if (!command) return;
    if (this.history[this.history.length - 1] !== command) this.history.push(command);
    this.execute(command);
  }

  private execute(command: string): void {
    const normalized = command.replace(/\s+/g, ' ');
    const program = this.profile.programs?.find((p) => p.command === normalized);
    if (program) {
      this.job = program.start(this.context());
      this.reap();
      return;
    }
    const [name, ...args] = normalized.split(' ');
    const rest = command.slice(command.indexOf(name) + name.length).trim();
    switch (name) {
      case 'help':
        this.print(...this.help());
        return;
      case 'ls':
        this.print(listingRow(this.profile.listing));
        return;
      case 'pwd':
        this.print(absolutePath(this.profile.cwd));
        return;
      case 'echo':
        this.print(rest);
        return;
      case 'whoami':
        this.print('demo');
        return;
      case 'date':
        this.print(formatDate(Date.now()));
        return;
      case 'clear':
        this.transcript = [];
        return;
      case 'cat':
        this.cat(args);
        return;
      case 'cd':
        this.print(dim('（演示模式：这里不能切换目录）'));
        return;
      default:
        this.print(dim('（演示模式：命令不会真的执行）'));
    }
  }

  private cat(args: string[]): void {
    if (args.length === 0) {
      this.print(dim('用法：cat <文件>'));
      return;
    }
    for (const name of args) {
      const content = this.profile.files?.[name.replace(/^\.\//, '')];
      if (content) this.print(...content);
      else this.print(red(`cat: ${name}: 没有那个文件或目录`));
    }
  }

  private help(): string[] {
    const rows = [bold('演示模式可以试这些命令：')];
    for (const [command, description] of BUILTINS) rows.push(`  ${padEnd(green(command), 16)}${dim(description)}`);
    for (const program of this.profile.programs ?? []) {
      rows.push(`  ${padEnd(green(program.command), 28)}${dim(program.description)}`);
    }
    rows.push(dim('其他命令会显示出来，但不会真的执行。'));
    return rows;
  }

  /** Ctrl-C a job that does not handle it: its last rows stay on screen with `^C`. */
  private interrupt(): void {
    const job = this.job;
    if (!job) return;
    const live = job.live();
    if (live.length === 0) this.print('^C');
    else this.print(...live.slice(0, -1), `${live[live.length - 1]}^C`);
    this.job = null;
  }

  private reap(): void {
    if (this.job?.done) this.job = null;
  }

  private context(): JobContext {
    return {
      print: (...rows) => this.print(...rows),
      needsInput: (request) => this.hooks.needsInput(this.id, request),
    };
  }
}

/** cmux key names are hyphen-joined (`ctrl-c`); tolerate case and a few aliases. */
export function normalizeKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\+/g, '-');
  switch (key) {
    case 'return':
      return 'enter';
    case 'esc':
      return 'escape';
    default:
      return key;
  }
}

/** Removes the last code point, so a CJK character or emoji goes in one press. */
function dropLast(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** `2026年11月1日 星期日 10:24:03`, in the phone's time zone. */
function formatDate(at: number): string {
  const d = new Date(at);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]} ${time}`;
}
