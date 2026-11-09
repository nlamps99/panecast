import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const client = fileURLToPath(new URL('../../client/', import.meta.url));
execFileSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', '../desktop/web'], {
  cwd: client, env: { ...process.env, PANECAST_DESKTOP_BUILD: '1' }, stdio: 'inherit',
});
