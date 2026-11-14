import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WeixinApi, API_ORIGIN, weixinOrigin } from './api.mjs';
import { acquireLock, accountPath, readAccount, savePrivate } from './storage.mjs';

/** The scanning account is the sole authorized sender. No first-message claiming. */
export async function loginWeixin({ directory, onQR, requestPin, signal, api = new WeixinApi(), now = Date.now }) {
  const release = await acquireLock(directory, 'login');
  try {
    const previous = await readAccount(directory), deadline = now() + 8 * 60_000;
    for (let attempt = 0; attempt < 3 && now() < deadline && !signal.aborted; attempt++) {
      const qr = await api.getQR(signal, previous?.token);
      if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string' || qr.qrcode.length > 8192 || qr.qrcode_img_content.length > 8192) throw new Error('微信没有返回有效二维码');
      await onQR(qr.qrcode_img_content);
      let pin, origin = API_ORIGIN;
      while (now() < deadline && !signal.aborted) {
        let result;
        try { result = await api.qrStatus(qr.qrcode, pin, signal, origin); }
        catch (error) { if (signal.aborted) break; if (!['network_error', 'http_error'].includes(error.code)) throw error; await delay(1000, undefined, { signal }).catch(() => {}); continue; }
        const status = String(result.status);
        if (status.includes('need_verifycode')) {
          pin = (await requestPin()).trim();
          if (!/^\d{4,12}$/.test(pin)) throw new Error('请输入手机微信显示的数字 PIN 后重试');
        } else if (status === 'confirmed') {
          if (![result.bot_token, result.ilink_bot_id, result.ilink_user_id].every(v => typeof v === 'string' && v.length > 0 && v.length < 8192)) throw new Error('微信未返回完整的账号身份，未保存绑定');
          const account = { version: 1, enabled: true, epoch: randomUUID(), token: result.bot_token, botId: result.ilink_bot_id, ownerId: result.ilink_user_id, origin: weixinOrigin(result.baseurl || origin), boundAt: now() };
          if (signal.aborted) throw new Error('绑定已取消');
          await savePrivate(accountPath(directory), account); return { boundAt: account.boundAt };
        } else if (status === 'scaned') pin = undefined;
        else if (status === 'expired' || status === 'verify_code_blocked') break;
        else if (status === 'scaned_but_redirect') origin = weixinOrigin(`https://${result.redirect_host}`);
        else if (status === 'binded_redirect') throw new Error('微信提示已绑定其他实例，请先在微信管理绑定后重试');
        await delay(300, undefined, { signal }).catch(() => {});
      }
    }
    throw new Error(signal.aborted ? '微信绑定已取消' : '二维码已过期，请重新运行微信绑定');
  } finally { await release(); }
}
