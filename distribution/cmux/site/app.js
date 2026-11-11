const byId = id => document.getElementById(id);
const link = (id, file, base = '.') => { const node = byId(id); node.href = `${base}/${file}`; node.hidden = false; };
fetch('./release.json', { cache: 'no-store' }).then(response => {
  if (!response.ok) throw new Error('release metadata unavailable');
  return response.json();
}).then(release => {
  byId('version').textContent = `${release.upstreamVersion} · DR2 ${release.revision}`;
  byId('size').textContent = `${(release.dmg.size / 1024 / 1024).toFixed(1)} MB`;
  // Large files come from object storage; checksums stay next to this page.
  const files = release.downloadBase ?? '.';
  link('dmg', release.dmg.file, files);
  link('archive', release.archive.file, files);
  link('source', release.source.file, files);
  link('checksum', `${release.dmg.file}.sha256`);
  byId('upstream').href = `https://github.com/manaflow-ai/cmux/releases/tag/v${release.upstreamVersion}`;
}).catch(() => {
  byId('version').textContent = '版本信息暂时不可用';
  byId('load-error').textContent = '未能读取发布记录，请刷新页面后再下载。';
  byId('load-error').hidden = false;
});
byId('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(byId('install-command').textContent);
    byId('copy').textContent = '已复制';
  } catch {
    byId('copy').textContent = '请选中下方命令复制';
  }
});
// cmux DR2 for Windows is published separately, with its own metadata.
fetch('./windows.json', { cache: 'no-store' }).then(response => {
  if (!response.ok) throw new Error('no Windows release');
  return response.json();
}).then(windows => {
  const files = windows.downloadBase ?? '.';
  byId('windows-version').textContent = `v${windows.version} · cmux ${windows.cmux.commit.slice(0, 7)}`;
  byId('windows-size').textContent = `${(windows.size / 1024 / 1024).toFixed(1)} MB`;
  byId('windows-command').textContent = `irm ${files}/${windows.installer.file} | iex`;
  link('windows-zip', windows.file, files);
  link('windows-checksum', `${windows.file}.sha256`);
  if (windows.source) link('windows-source', windows.source.file, files);
  byId('windows').hidden = false;
}).catch(() => {});
byId('windows-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(byId('windows-command').textContent);
    byId('windows-copy').textContent = '已复制';
  } catch {
    byId('windows-copy').textContent = '请选中下方命令复制';
  }
});
