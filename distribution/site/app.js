const byId = (id) => document.getElementById(id);
const installTabs = [...document.querySelectorAll('[data-method]')];
let commands = {};
let activeMethod = 'brew';

function selectMethod(method, focus = false) {
  activeMethod = method;
  for (const tab of installTabs) {
    const selected = tab.dataset.method === method;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  byId('install-panel').setAttribute('aria-labelledby', `tab-${method}`);
  byId('install-command').textContent = commands[method]?.command ?? '正在读取安装命令…';
  byId('install-note').textContent = commands[method]?.note ?? '';
}
installTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectMethod(tab.dataset.method));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % installTabs.length;
    if (event.key === 'ArrowLeft') next = (index + installTabs.length - 1) % installTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = installTabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectMethod(installTabs[next].dataset.method, true); }
  });
});
byId('copy-install').addEventListener('click', async () => {
  const command = commands[activeMethod]?.command;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    byId('copy-install').textContent = '已复制 ✓'; byId('copy-status').textContent = '安装命令已复制。';
    setTimeout(() => { byId('copy-install').textContent = '复制 ⧉'; }, 1800);
  } catch {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(byId('install-command')); selection.removeAllRanges(); selection.addRange(range);
    byId('copy-status').textContent = '请按 Command+C 复制选中的命令。';
    byId('copy-install').textContent = '请按 ⌘C';
  }
});
byId('copy-desktop-install').addEventListener('click', async () => {
  const code = byId('desktop-install-command');
  if (!code.textContent) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    byId('copy-desktop-install').textContent = '已复制 ✓';
    byId('copy-status').textContent = '桌面版安装命令已复制，请在终端粘贴并按回车。';
    setTimeout(() => { byId('copy-desktop-install').textContent = '复制 ⧉'; }, 1800);
  } catch {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
    byId('copy-status').textContent = '请按 Command+C 复制选中的桌面版安装命令。';
    byId('copy-desktop-install').textContent = '请按 ⌘C';
  }
});

function releaseRow(release, platform, files = '.') {
  const item = document.createElement('article'); item.className = 'release-item';
  const meta = document.createElement('div'); meta.className = 'release-meta';
  const title = document.createElement('strong'); title.textContent = `${platform} ${release.version}${release.versionCode ? ` · build ${release.versionCode}` : ''}`;
  const date = document.createElement('time'); date.dateTime = release.date; date.textContent = release.date;
  meta.append(title, date); item.append(meta);
  const list = document.createElement('ul');
  for (const note of release.notes ?? []) { const line = document.createElement('li'); line.textContent = note; list.append(line); }
  item.append(list);
  const link = document.createElement('a'); link.href = `${files}/${release.file}`; link.textContent = '下载此版本 ↗'; item.append(link);
  return item;
}

async function loadReleases() {
  const response = await fetch('./releases.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot load releases');
  const data = await response.json();
  const base = new URL('./', location.href).href.replace(/\/$/, '');
  // Current packages are served from object storage; pages, scripts and checksums stay here.
  const files = data.downloadBase ?? '.';
  byId('android-version').textContent = `v${data.android.version} · build ${data.android.versionCode}`;
  byId('android-size').textContent = `${(data.android.size / 1000000).toFixed(1)} MB`;
  byId('android-download').href = `${files}/${data.android.file}`;
  byId('android-checksum').href = `./${data.android.file}.sha256`;
  byId('mac-version').textContent = `v${data.mac.version} CLI`;
  if (data.desktop) {
    byId('desktop-card').hidden = false;
    byId('desktop-version').textContent = `v${data.desktop.version}`;
    byId('desktop-size').textContent = `${(data.desktop.size / 1000000).toFixed(1)} MB`;
    byId('desktop-download').href = `${files}/${data.desktop.file}`;
    byId('desktop-checksum').href = `./${data.desktop.file}.sha256`;
    if (data.desktop.archive) {
      byId('desktop-archive').hidden = false;
      byId('desktop-archive').href = `${files}/${data.desktop.archive.file}`;
    }
    if (data.desktop.installer) {
      byId('desktop-install-panel').hidden = false;
      byId('desktop-install-command').textContent = `curl -fsSL ${base}/install-desktop.sh | bash`;
    }
  }
  if (data.windows) {
    byId('windows-card').hidden = false;
    byId('windows-version').textContent = `v${data.windows.version}`;
    byId('windows-size').textContent = `${(data.windows.size / 1000000).toFixed(1)} MB`;
    byId('windows-download').href = `${files}/${data.windows.file}`;
    byId('windows-checksum').href = `./${data.windows.file}.sha256`;
  }
  commands = {
    brew: { command: `brew tap panecast/tap ${base}/homebrew-tap.git\nbrew install panecast/tap/panecast`, note: '需要已安装 Homebrew；自动处理 Node.js 和 tmux 依赖，支持 Apple Silicon 与 Intel。' },
    script: { command: `curl -fsSL ${base}/install.sh | bash`, note: '自带独立 Node.js 运行时，无需 sudo。如使用 tmux 来源，请另行安装 tmux。' },
    npm: { command: `npm install -g ${data.downloadBase ?? base}/${data.mac.file}`, note: '需要 Node.js 22+。这是直接安装官方发布包，无需配置 npm 仓库。' },
  };
  selectMethod(activeMethod);
  const list = byId('release-list'); list.replaceChildren(releaseRow(data.mac, 'Mac CLI', files), releaseRow(data.android, 'Android', files));
  if (data.desktop) list.prepend(releaseRow(data.desktop, 'Mac 桌面版', files));
  if (data.windows) list.prepend(releaseRow(data.windows, 'Windows 桌面版', files));
  for (const release of data.history ?? []) list.append(releaseRow(release, release.platform));
}
loadReleases().catch(() => { byId('load-error').hidden = false; byId('android-version').textContent = 'Android APK'; });
