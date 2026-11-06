import { RpcCallError } from '../protocol/connection';
import { utf8Encode } from '../protocol/sha256';

const FILES: Record<string, string> = {
  'README.md': '# Panecast\n\n手机上的终端。这个项目用于演示文件预览与下载。\n',
  'artifacts/checks.txt': 'Validation complete\n42 checks passed\nNo failures\n',
};
export function demoProject(method: string, path: unknown): unknown {
  const p = typeof path === 'string' ? path : '';
  if (method === 'project.list') {
    const entries = p === '' ? [{ name: 'README.md', directory: false, size: 100 }, { name: 'artifacts', directory: true, size: 0 }]
      : p === 'artifacts' ? [{ name: 'checks.txt', directory: false, size: 53 }] : null;
    if (!entries) throw new RpcCallError('not_found', '演示目录不存在');
    return { root: '/Users/demo/code/panecast', path: p, entries };
  }
  if (method === 'project.diff') return { root: '/Users/demo/code/panecast', working: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Remote terminal\n+Your terminal, wherever you are.\n', staged: '', truncated: false };
  if (method === 'project.read' && FILES[p] !== undefined) {
    const bytes = utf8Encode(FILES[p]);
    return { name: p.split('/').pop(), mime_type: 'text/plain', size: bytes.length, data_base64: btoa(String.fromCharCode(...bytes)), text: FILES[p] };
  }
  throw new RpcCallError('not_found', '演示文件不存在');
}
