import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { DiffOp, PushFrame } from '../protocol/frames';
import { screenHash } from '../protocol/screen';
import type { RpcChannel } from '../session/terminalSession';
import { codePointWidth } from '../terminal/cellWidth';

/**
 * A pretend relay with canned terminals, for trying the app without a Mac and
 * for App Review. It speaks the same RPC and push protocol as the real relay:
 * subscribe starts with clear + every row, then diffs; a checksum every 5 s;
 * `surface.history` pages one snapshot with an anchor.
 */

const COLS = 120;
const LIVE_LINES = 120;

type DemoSurface = { id: string; title: string; focused: boolean; transcript: string[]; input: string };

const ESC = '\u001b';
const green = (text: string) => `${ESC}[32m${text}${ESC}[0m`;
const dim = (text: string) => `${ESC}[2m${text}${ESC}[0m`;
const bold = (text: string) => `${ESC}[1m${text}${ESC}[0m`;
const badge = (text: string) => `${ESC}[30;42m ${text} ${ESC}[0m`;

function buildLog(): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= 260; i++) {
    lines.push(dim(`[build] ${String(i).padStart(3, '0')} compiled src/module-${i % 17}/index.ts in ${(i * 7) % 90 + 10} ms`));
  }
  return lines;
}

function projectTranscript(): string[] {
  return [
    ...buildLog(),
    '',
    `${green('~/code/panecast')} ${dim('main')} $ git status`,
    'On branch main',
    "Your branch is up to date with 'origin/main'.",
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    `        ${ESC}[31mmodified:   client/src/ui/TerminalView.tsx${ESC}[0m`,
    `        ${ESC}[31mmodified:   client/src/session/terminalSession.ts${ESC}[0m`,
    '',
    `${green('~/code/panecast')} ${dim('main')} $ npm test`,
    '',
    `${badge('PASS')} src/protocol/__tests__/connection.test.ts`,
    `${badge('PASS')} src/session/__tests__/terminalSession.test.ts`,
    `${badge('PASS')} src/terminal/__tests__/layout.test.ts`,
    '',
    `${bold('Tests:')}       ${green('99 passed')}, 99 total`,
    'Time:        2.43 s',
    '',
    '─'.repeat(COLS),
    '  终端里的长行会按词折行，只有横线的行会截断到屏幕宽度。',
    `  /Users/demo/code/panecast/client/node_modules/react-native/Libraries/Lists/VirtualizedList.js`,
    '─'.repeat(COLS),
    '',
  ];
}

function serverTranscript(): string[] {
  return [
    `${green('~/code/panecast/client')} $ npx expo start`,
    'Starting Metro Bundler',
    '',
    `${dim('›')} Metro waiting on exp://192.168.1.20:8081`,
    `${dim('›')} Press ${bold('r')} │ reload app`,
    `${dim('›')} Press ${bold('j')} │ open debugger`,
    '',
    'iOS Bundled 412ms index.ts (1 module)',
    '',
  ];
}

function notesTranscript(): string[] {
  return [`${green('~/notes')} $ cat todo.md`, '- 在手机上看终端', '- 用中文输入法输入命令', '- 扫码配对', ''];
}

const WORKSPACES = [
  { id: 'demo-ws-1', title: 'panecast', index: 0, selected: true },
  { id: 'demo-ws-2', title: 'notes', index: 1, selected: false },
];

export class DemoChannel implements RpcChannel {
  readonly isOpen = true;
  readonly status: ConnectionStatus = { state: 'open' };
  private surfaces = new Map<string, { workspaceId: string; surface: DemoSurface }>();
  private subscribed: { surfaceId: string; rows: string[]; rev: number } | null = null;
  private checksumTimer: ReturnType<typeof setInterval> | null = null;
  private pushListeners = new Set<(frame: PushFrame) => void>();

  constructor() {
    this.add('demo-ws-1', { id: 'demo-sf-1', title: 'zsh — panecast', focused: true, transcript: projectTranscript(), input: '' });
    this.add('demo-ws-1', { id: 'demo-sf-2', title: 'expo start', focused: false, transcript: serverTranscript(), input: '' });
    this.add('demo-ws-2', { id: 'demo-sf-3', title: 'zsh — notes', focused: true, transcript: notesTranscript(), input: '' });
  }

  onPush(listener: (frame: PushFrame) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onStatus(_listener: (status: ConnectionStatus) => void): () => void {
    return () => {};
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(this.handle(method, params) as T);
        } catch (error) {
          reject(error);
        }
      }, 40);
    });
  }

  private add(workspaceId: string, surface: DemoSurface) {
    this.surfaces.set(surface.id, { workspaceId, surface });
  }

  private handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'workspace.list':
        return { workspaces: WORKSPACES };
      case 'surface.list': {
        const surfaces = [...this.surfaces.values()]
          .filter((entry) => entry.workspaceId === params.workspace_id)
          .map(({ surface }, index) => ({ id: surface.id, title: surface.title, index, focused: surface.focused, type: 'terminal' }));
        return { surfaces };
      }
      case 'surface.subscribe':
        this.subscribe(String(params.surface_id));
        return {};
      case 'surface.unsubscribe':
        if (this.subscribed?.surfaceId === params.surface_id) this.stop();
        return {};
      case 'surface.history':
        return this.history(params);
      case 'surface.send_text':
        this.edit(String(params.surface_id), (surface) => {
          surface.input += String(params.text ?? '');
        });
        return {};
      case 'surface.send_key':
        this.edit(String(params.surface_id), (surface) => this.key(surface, String(params.key ?? '')));
        return {};
      case 'surface.focus':
      case 'host.battery':
        return {};
      default:
        throw new RpcCallError('method_not_found', `演示模式不支持 ${method}`);
    }
  }

  private key(surface: DemoSurface, key: string) {
    switch (key) {
      case 'enter': {
        const command = surface.input;
        surface.transcript.push(`${this.prompt(surface)} $ ${command}`);
        if (command.trim()) surface.transcript.push(dim('（演示模式：命令不会真的执行）'));
        surface.input = '';
        break;
      }
      case 'backspace':
        surface.input = Array.from(surface.input).slice(0, -1).join('');
        break;
      case 'ctrl-c':
        surface.transcript.push(`${this.prompt(surface)} $ ${surface.input}^C`);
        surface.input = '';
        break;
      default:
        break;
    }
  }

  private prompt(surface: DemoSurface): string {
    return surface.id === 'demo-sf-3' ? green('~/notes') : `${green('~/code/panecast')} ${dim('main')}`;
  }

  /** Every row of the surface's scrollback, padded like cmux pads to the pane width. */
  private snapshot(surface: DemoSurface): string[] {
    const rows = [...surface.transcript, `${this.prompt(surface)} $ ${surface.input}`, '', ''];
    return rows.map((row) => row + ' '.repeat(Math.max(0, COLS - visibleLength(row))));
  }

  private liveRows(surface: DemoSurface): string[] {
    return this.snapshot(surface).slice(-LIVE_LINES);
  }

  private subscribe(surfaceId: string) {
    const entry = this.surfaces.get(surfaceId);
    if (!entry) throw new RpcCallError('invalid_params', 'unknown surface');
    if (this.subscribed?.surfaceId === surfaceId) return;
    this.stop();
    const rows = this.liveRows(entry.surface);
    this.subscribed = { surfaceId, rows, rev: 1 };
    const ops: DiffOp[] = [{ op: 'clear' }, ...rows.map((text, y) => ({ op: 'row' as const, y, text })), { op: 'cursor', x: 0, y: 0 }];
    setTimeout(() => this.emit({ type: 'screen.diff', surfaceId, rev: 1, ops }), 60);
    this.checksumTimer = setInterval(() => {
      const current = this.subscribed;
      if (!current) return;
      this.emit({ type: 'screen.checksum', surfaceId: current.surfaceId, rev: current.rev, hash: screenHash(current.rows, { x: 0, y: 0 }) });
    }, 5_000);
  }

  private stop() {
    this.subscribed = null;
    if (this.checksumTimer) clearInterval(this.checksumTimer);
    this.checksumTimer = null;
  }

  private edit(surfaceId: string, change: (surface: DemoSurface) => void) {
    const entry = this.surfaces.get(surfaceId);
    if (!entry) throw new RpcCallError('invalid_params', 'unknown surface');
    change(entry.surface);
    const current = this.subscribed;
    if (!current || current.surfaceId !== surfaceId) return;
    const next = this.liveRows(entry.surface);
    const ops: DiffOp[] = [];
    if (next.length !== current.rows.length) {
      ops.push({ op: 'clear' }, ...next.map((text, y) => ({ op: 'row' as const, y, text })));
    } else {
      next.forEach((text, y) => {
        if (text !== current.rows[y]) ops.push({ op: 'row', y, text });
      });
    }
    if (ops.length === 0) return;
    current.rows = next;
    current.rev += 1;
    this.emit({ type: 'screen.diff', surfaceId, rev: current.rev, ops });
  }

  private history(params: Record<string, unknown>) {
    const entry = this.surfaces.get(String(params.surface_id));
    if (!entry) throw new RpcCallError('history_unavailable', 'unknown surface');
    const rows = this.snapshot(entry.surface);
    const limit = typeof params.limit === 'number' ? params.limit : 200;
    let end: number;
    let anchor: string[] | undefined;
    if (typeof params.cursor === 'string') {
      end = Number(params.cursor.split('.')[1] ?? 0);
    } else {
      const tail = Math.min(typeof params.tail_lines === 'number' ? params.tail_lines : 120, rows.length);
      end = rows.length - tail;
      anchor = rows.slice(end);
    }
    const start = Math.max(0, end - limit);
    return {
      rows: rows.slice(start, end),
      next_cursor: start > 0 ? `demo.${start}` : null,
      ...(anchor ? { anchor_rows: anchor } : {}),
    };
  }

  private emit(frame: PushFrame) {
    for (const listener of this.pushListeners) listener(frame);
  }
}

/** Display width ignoring SGR sequences. */
function visibleLength(row: string): number {
  let width = 0;
  for (const char of row.replace(/\u001b\[[0-9;]*m/g, '')) width += codePointWidth(char.codePointAt(0)!);
  return width;
}

let shared: DemoChannel | null = null;

/** One demo per app run, so its transcript survives leaving and re-entering the demo. */
export function demoChannel(): DemoChannel {
  shared ??= new DemoChannel();
  return shared;
}
