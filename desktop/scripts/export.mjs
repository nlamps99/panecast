import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const client = fileURLToPath(new URL('../../client/', import.meta.url));
execFileSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', '../desktop/web'], {
  cwd: client, env: { ...process.env, PANECAST_DESKTOP_BUILD: '1' }, stdio: 'inherit',
});
const web = new URL('../web/', import.meta.url);
copyFileSync(new URL('../src/bridge.js', import.meta.url), new URL('desktop-bridge.js', web));
const index = new URL('index.html', web);
writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head><script src="/desktop-bridge.js"></script>'));
const icons = new URL('../src-tauri/icons/', import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)),
  'icon', fileURLToPath(new URL('../../client/assets/images/icon.png', import.meta.url)), '--output', fileURLToPath(icons)], { stdio: 'inherit' });
