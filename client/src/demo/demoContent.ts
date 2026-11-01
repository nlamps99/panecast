import { CheckRun, finishedCheckRows, LogTail, NotesSync, ReleaseHelper } from './demoPrograms';
import type { DemoTerminal, ShellProfile } from './demoTerminal';
import { bold, dim, PANE_COLS, red } from './demoText';

/**
 * The demo Mac: two cmux windows with a few workspaces each, and what their
 * terminals show when the demo starts. Everything here is made up.
 */

export type TerminalSeed = {
  id: string;
  title: string;
  profile: ShellProfile;
  /** Fills the scrollback and may start a foreground job. */
  seed(terminal: DemoTerminal): void;
};

export type WorkspaceSeed = {
  id: string;
  title: string;
  terminals: readonly TerminalSeed[];
  focusedId: string;
};

export type WindowSeed = { id: string; workspaces: readonly WorkspaceSeed[]; selectedId: string };

// MARK: Shell profiles

const PANECAST: ShellProfile = {
  cwd: '~/code/panecast',
  branch: 'main',
  listing: ['client/', 'relay/', 'broker/', 'docs/', 'scripts/', 'README.md', 'LICENSE'],
  files: {
    'README.md': [
      bold('# Panecast'),
      '',
      '在手机上查看和操作电脑上的终端。',
      '',
      '- client/  手机客户端（iOS、Android、网页）',
      '- relay/   跑在 Mac 上的 relay',
      '- broker/  跑在服务器上的 broker',
    ],
  },
  programs: [
    { command: './scripts/check', description: '跑一遍检查', start: (ctx) => new CheckRun(ctx, false, 5) },
    {
      command: './scripts/check --watch',
      description: '监视模式，输出一直在变',
      start: (ctx) => new CheckRun(ctx, true, 13),
    },
  ],
};

const WEATHER: ShellProfile = {
  cwd: '~/code/weather-service',
  branch: 'release/1.4',
  listing: ['src/', 'logs/', 'scripts/', 'CHANGELOG.md', 'package.json'],
  files: {
    'CHANGELOG.md': [
      bold('## v1.4.0'),
      '- 新增：空气质量指数（AQI）接口',
      '- 修复：城市名带空格时搜索不到',
      '- 改进：7 天预报的响应时间缩短到 40 ms 以内',
    ],
  },
  programs: [
    {
      command: 'tail -f logs/server.log',
      description: '看服务日志，每隔一两秒多一行',
      start: (ctx) => new LogTail(ctx, { backlog: 10 }, 29),
    },
    { command: './scripts/release.sh', description: '发布助手，用 ↑/↓ 和 ↵ 回答', start: (ctx) => new ReleaseHelper(ctx) },
  ],
};

const NOTES: ShellProfile = {
  cwd: '~/notes',
  listing: ['会议记录-周一.md', '读书笔记.md', '待办.md', 'sync.sh'],
  files: {
    '待办.md': ['- 在手机上看终端', '- 用中文输入法输入命令', '- 扫码配对'],
    '会议记录-周一.md': [bold('# 周一例会'), '- 下周三前完成配对流程', '- 演示模式要能离线使用'],
    '读书笔记.md': [bold('# 读书笔记'), '- 每天固定一段不被打扰的时间', '- 先写下来，再慢慢整理'],
    'sync.sh': ['#!/bin/sh', 'rsync -a ~/notes/ ~/备份/笔记/'],
  },
  programs: [{ command: './sync.sh', description: '同步笔记，会问你 [Y/n]', start: (ctx) => new NotesSync(ctx) }],
};

const BLOG: ShellProfile = {
  cwd: '~/code/blog',
  branch: 'main',
  listing: ['posts/', 'public/', 'themes/', 'build.sh', 'config.toml'],
  files: { 'config.toml': ['title = "慢慢写"', 'language = "zh-CN"', 'theme = "plain"'] },
};

const PHOTOS: ShellProfile = {
  cwd: '~/照片',
  listing: ['2024-旅行/', '2025-家里/', '待整理/', '整理.sh'],
  files: { '整理.sh': ['#!/bin/sh', '# 按拍摄日期把照片放进对应的文件夹', 'echo "整理完成"'] },
};

const HOME: ShellProfile = {
  cwd: '~',
  listing: ['Desktop/', 'Documents/', 'Downloads/', 'code/', 'notes/', '照片/'],
};

const PROFILES = [PANECAST, WEATHER, NOTES, BLOG, PHOTOS];

/** The profile for a new terminal in a workspace whose shells sit in `cwd`; home for a new workspace. */
export function profileFor(cwd: string | undefined): ShellProfile {
  return PROFILES.find((profile) => profile.cwd === cwd) ?? HOME;
}

// MARK: Scrollback

function buildLog(): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= 260; i++) {
    lines.push(dim(`[build] ${String(i).padStart(3, '0')} compiled src/module-${i % 17}/index.ts in ${((i * 7) % 90) + 10} ms`));
  }
  return lines;
}

function seedProjectShell(t: DemoTerminal): void {
  t.print(...buildLog(), '');
  t.print(
    `${t.prompt} git status`,
    '位于分支 main',
    '您的分支与上游分支 \'origin/main\' 一致。',
    '',
    '尚未暂存以备提交的变更：',
    '  （使用 "git add <文件>..." 更新要提交的内容）',
    `        ${red('修改：     client/src/ui/TerminalView.tsx')}`,
    `        ${red('修改：     client/src/session/terminalSession.ts')}`,
    '',
    `${t.prompt} ./scripts/check`,
    ...finishedCheckRows(),
    '',
    '─'.repeat(PANE_COLS),
    '  终端里的长行会按词折行，只有横线的行会截断到屏幕宽度。',
    '  /Users/demo/code/panecast/client/node_modules/react-native/Libraries/Lists/VirtualizedList.js',
    '─'.repeat(PANE_COLS),
    '',
    dim('输入 help 看看演示模式能做什么。'),
  );
}

/** What a terminal made with `surface.create` shows. */
export function seedNewShell(t: DemoTerminal): void {
  t.print(dim('新终端。输入 help 看看演示模式能做什么。'));
}

// MARK: The world

export const WINDOW_SEEDS: readonly WindowSeed[] = [
  {
    id: 'demo-win-1',
    selectedId: 'demo-ws-1',
    workspaces: [
      {
        id: 'demo-ws-1',
        title: 'panecast',
        focusedId: 'demo-sf-1',
        terminals: [
          { id: 'demo-sf-1', title: 'zsh — panecast', profile: PANECAST, seed: seedProjectShell },
          {
            id: 'demo-sf-2',
            title: '自动测试',
            profile: PANECAST,
            seed: (t) => t.run('./scripts/check --watch'),
          },
        ],
      },
      {
        id: 'demo-ws-2',
        title: 'notes',
        focusedId: 'demo-sf-3',
        terminals: [
          {
            id: 'demo-sf-3',
            title: 'zsh — notes',
            profile: NOTES,
            seed: (t) => {
              t.run('cat 待办.md');
              t.run('ls');
              t.run('./sync.sh');
            },
          },
        ],
      },
      {
        id: 'demo-ws-3',
        title: '天气服务',
        focusedId: 'demo-sf-5',
        terminals: [
          {
            id: 'demo-sf-4',
            title: '服务日志',
            profile: WEATHER,
            seed: (t) => t.launch('tail -f logs/server.log', (ctx) => new LogTail(ctx, { backlog: 700, banner: true })),
          },
          {
            id: 'demo-sf-5',
            title: '发布助手',
            profile: WEATHER,
            seed: (t) => {
              t.run('cat CHANGELOG.md');
              t.run('./scripts/release.sh');
            },
          },
        ],
      },
    ],
  },
  {
    id: 'demo-win-2',
    selectedId: 'demo-ws-4',
    workspaces: [
      {
        id: 'demo-ws-4',
        title: '博客',
        focusedId: 'demo-sf-6',
        terminals: [
          {
            id: 'demo-sf-6',
            title: 'zsh — blog',
            profile: BLOG,
            seed: (t) =>
              t.print(
                `${t.prompt} ./build.sh`,
                '生成 42 篇文章、11 个标签页',
                '压缩图片 86 张：31.2 MB → 9.8 MB',
                '完成，用时 3.4 s，输出在 public/',
              ),
          },
        ],
      },
      {
        id: 'demo-ws-5',
        title: '照片整理',
        focusedId: 'demo-sf-7',
        terminals: [
          {
            id: 'demo-sf-7',
            title: 'zsh — 照片',
            profile: PHOTOS,
            seed: (t) => {
              t.run('ls');
              t.print(
                `${t.prompt} du -sh *`,
                '2.1G    2024-旅行',
                '860M    2025-家里',
                '312M    待整理',
                '4.0K    整理.sh',
              );
            },
          },
        ],
      },
    ],
  },
];
