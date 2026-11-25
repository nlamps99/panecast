import { parsePairingUrl } from '../protocol/pairing';
import { isShareKey, parseShareKey } from '../protocol/shareKey';

export type PairingInputSummary = { ok: boolean; text: string };

/**
 * What the pasted text looks like, without showing any of its secrets: the
 * paste field hides what was typed, so this line tells the user whether they
 * pasted the right thing. Only the server's host name is shown.
 */
export function describePairingInput(raw: string): PairingInputSummary | null {
  const value = raw.trim();
  if (!value) return null;
  if (isShareKey(value)) {
    const key = parseShareKey(value);
    if (!key) return { ok: false, text: '分享密钥不完整，请让对方重新复制一次' };
    const name = key.name ? `「${key.name}」` : '';
    return { ok: true, text: `已识别：${name}的分享密钥（服务器 ${host(key.serverUrl)}）` };
  }
  const parsed = parsePairingUrl(value);
  if (parsed.ok) {
    const lan = parsed.payload.lanUrl ? '，同一 Wi-Fi 下可直连' : '';
    return { ok: true, text: `已识别：配对链接（服务器 ${host(parsed.payload.serverUrl)}${lan}）` };
  }
  if (parsed.error.kind === 'missing_field') return { ok: false, text: '配对链接不完整，请在电脑上重新运行 panecast pair' };
  return { ok: false, text: '无法识别：请粘贴 cmux://pair 开头的配对链接，或 pcs1. 开头的分享密钥' };
}

function host(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] || url;
}
