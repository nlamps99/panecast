import { randomBytes } from 'node:crypto';

export const API_ORIGIN = 'https://ilinkai.weixin.qq.com';
// Protocol compatibility version, followed by our implementation identifier.
const CHANNEL_VERSION = '3.0.0/panecast-0.1.9';
export class WeixinError extends Error {
  constructor(code, message, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}

export function weixinOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new WeixinError('invalid_endpoint', '微信返回了无效的服务地址'); }
  if (url.protocol !== 'https:' || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new WeixinError('invalid_endpoint', '微信返回了不受支持的服务地址');
  }
  return url.origin;
}

/** No SDK host or model process is required; only the documented iLink transport. */
export class WeixinApi {
  constructor({ fetchImpl = fetch, origin = API_ORIGIN, token = '' } = {}) {
    this.fetch = fetchImpl; this.origin = weixinOrigin(origin); this.token = token;
  }
  async request(path, { body, signal, timeout = 35000, authenticated = false, origin = this.origin } = {}) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) throw new WeixinError('cancelled', '操作已停止');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };
    if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (authenticated) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetch(weixinOrigin(origin) + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(authenticated ? { ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'Panecast/0.1.9' } } : body) }),
        signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new WeixinError('http_error', `微信接口暂不可用（HTTP ${response.status}）`, true);
      // Bound both allocation and body reading; never echo response bodies/tokens.
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 4 * 1024 * 1024) { controller.abort(); throw new WeixinError('invalid_response', '微信响应过大', true); }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      let value;
      try { value = JSON.parse(text, (key, v, context) => key === 'message_id' && typeof v === 'number' ? context?.source ?? (Number.isSafeInteger(v) ? String(v) : null) : v); }
      catch { throw new WeixinError('invalid_response', '微信响应格式无效', true); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WeixinError('invalid_response', '微信响应格式无效', true);
      const failure = [value.ret, value.errcode].find(code => code !== undefined && code !== 0);
      if (failure !== undefined) throw new WeixinError(String(failure), failure === -14 ? '微信登录已失效，请重新扫码绑定' : '微信拒绝了本次请求，请查看状态后重试');
      return value;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      throw new WeixinError(signal?.aborted ? 'cancelled' : 'network_error', signal?.aborted ? '操作已停止' : '微信连接中断或超时', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  getQR(signal, token) { return this.request('/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: token ? [token] : [] }, signal, origin: API_ORIGIN }); }
  qrStatus(qrcode, pin, signal, origin) {
    const query = new URLSearchParams({ qrcode }); if (pin) query.set('verify_code', pin);
    return this.request('/ilink/bot/get_qrcode_status?' + query, { signal, origin });
  }
  updates(cursor, signal) { return this.request('/ilink/bot/getupdates', { body: { get_updates_buf: cursor ?? '' }, authenticated: true, signal, timeout: 40000 }); }
  send(to, text, context, id, signal) {
    if (!context) throw new WeixinError('missing_context', '请先在微信中发一条消息以恢复回复通道');
    return this.request('/ilink/bot/sendmessage', { authenticated: true, signal, timeout: 15000, body: { msg: {
      from_user_id: '', to_user_id: to, client_id: id, message_type: 2, message_state: 2, context_token: context,
      item_list: [{ type: 1, text_item: { text } }],
    } } });
  }
}
