import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import { accountPath, readAccount, readPrivate, savePrivate, weixinDirectory } from './storage.mjs';
import { loginWeixin } from './login.mjs';

export function qrSVG(value) {
  const code = new QRCode(-1, 1); code.addData(value); code.make(); const size = code.getModuleCount();
  let path = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (code.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" width="360" height="360"><rect width="100%" height="100%" fill="white"/><path fill="black" d="${path}"/></svg>`;
}

export async function loginPage(signal) {
  const secret = randomBytes(24).toString('hex'), path = '/' + secret;
  let state = { state: 'starting', message: '正在获取二维码…', svg: '' }, pinResolve;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== expectedHost || !request.url?.startsWith(path) || (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === path + '/state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(state)); return; }
    if (request.method === 'POST' && request.url === path + '/pin') {
      if (request.headers.origin !== `http://${expectedHost}` || request.headers['x-panecast-login'] !== secret) { response.writeHead(403); response.end(); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 100) { response.writeHead(413); response.end(); return; } }
      if (!/^\d{4,12}$/.test(body) || !pinResolve) { response.writeHead(400); response.end(); return; }
      const done = pinResolve; pinResolve = null; state = { ...state, state: 'waiting', message: '正在验证，请在微信中确认。' }; done(body); response.end('{}'); return;
    }
    if (request.method !== 'GET' || request.url !== path) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${secret}'; style-src 'nonce-${secret}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Panecast · 绑定微信</title><style nonce="${secret}">body{font:16px system-ui;margin:40px auto;padding:20px;max-width:480px;background:#191c28;color:#edf0f7}h1{font-size:25px}#qr{background:white;border-radius:12px;max-width:360px}svg{width:100%;height:auto}input,button{font:inherit;padding:10px;margin-top:12px;border-radius:8px}button{background:#a6d36b;border:0}p{line-height:1.7}#pin{display:none}</style><h1>在微信里继续终端对话</h1><p id="message">正在获取二维码…</p><div id="qr"></div><form id="pin"><label>输入手机微信显示的 PIN<br><input id="digits" inputmode="numeric" pattern="[0-9]{4,12}" autocomplete="off" required></label><button>确认</button></form><p>请用你自己的微信扫码并确认绑定。绑定后在微信发送 /list 选择终端。</p><script nonce="${secret}">const base=location.pathname;const message=document.getElementById('message'),qr=document.getElementById('qr'),form=document.getElementById('pin');async function poll(){try{const r=await fetch(base+'/state');const s=await r.json();message.textContent=s.message;qr.innerHTML=s.svg;form.style.display=s.state==='pin'?'block':'none';if(['done','failed'].includes(s.state))return;}catch{}setTimeout(poll,1000)}form.onsubmit=async e=>{e.preventDefault();const input=document.getElementById('digits');await fetch(base+'/pin',{method:'POST',headers:{'x-panecast-login':'${secret}'},body:input.value});input.value='';};poll();</script></html>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const abort = () => { pinResolve?.(''); pinResolve = null; }; signal.addEventListener('abort', abort, { once: true });
  return {
    url: `http://127.0.0.1:${server.address().port}${path}`,
    onQR(value) { state = { state: 'waiting', message: '用手机微信扫描二维码，并确认绑定。', svg: qrSVG(value) }; },
    requestPin() { state = { ...state, state: 'pin', message: '微信要求 PIN 验证，请输入手机上显示的数字。' }; return new Promise(resolve => { pinResolve = resolve; }); },
    finish(ok) { state = { state: ok ? 'done' : 'failed', message: ok ? '绑定成功！在微信发送 /list 即可选择终端。' : '绑定未完成，请返回终端查看提示后重试。', svg: '' }; },
    async close() { signal.removeEventListener('abort', abort); abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function weixinCLI(args, configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), directory = weixinDirectory(config);
  const action = args[0] ?? 'status';
  if (action === 'status') {
    const account = await readAccount(directory), status = await readPrivate(join(directory, 'status.json'));
    console.log(account ? '微信已绑定（仅接受扫码者本人的私聊）' : '微信尚未绑定。运行 panecast weixin login --browser');
    const labels = { connected: '已连接', connecting: '连接中', reconnecting: '正在重连', stopped: '已停止', login_required: '需要重新登录', error: '连接异常' };
    if (account) console.log(status && Date.now() - status.at < 15000 ? `通道：${labels[status.state] ?? '状态未知'}${status.message ? ` · ${status.message}` : ''}` : '后台状态未更新。请确认 Panecast 网关正在运行。');
    return;
  }
  if (action === 'logout') {
    await savePrivate(accountPath(directory), { version: 1, enabled: false });
    console.log('已在本机停用微信并清除登录凭据。后台会停止收发；可在微信中解除 Bot 绑定。'); return;
  }
  if (action !== 'login') throw new Error('用法：panecast weixin login [--browser] | status | logout');
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timeout = setTimeout(abort, 8 * 60_000); let page, prompt;
  try {
    if (args.includes('--browser')) {
      page = await loginPage(controller.signal); console.log(`在本机浏览器扫码绑定：${page.url}`);
      if (process.platform === 'darwin' && !args.includes('--no-open')) execFile('open', [page.url], () => {});
    } else prompt = createInterface({ input: process.stdin, output: process.stdout });
    const svgIndex = args.indexOf('--qr-file'), svgPath = svgIndex >= 0 ? resolve(args[svgIndex + 1] ?? '') : null;
    await loginWeixin({ directory, signal: controller.signal,
      onQR: async value => {
        if (page) page.onQR(value); else { qrcode.generate(value, { small: true }); console.log('用本人微信扫描并确认绑定。'); }
        if (svgPath) { const { writeFile } = await import('node:fs/promises'); await writeFile(svgPath, qrSVG(value), { mode: 0o600 }); }
      },
      requestPin: () => page ? page.requestPin() : prompt.question('请输入手机微信显示的 PIN：', { signal: controller.signal }),
    });
    page?.finish(true); console.log('微信绑定成功。网关运行时会自动连接；在微信发送 /list 选择终端。');
    if (page) await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (error) { page?.finish(false); if (page) await new Promise(resolve => setTimeout(resolve, 3000)); throw error; }
  finally { clearTimeout(timeout); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); controller.abort(); prompt?.close(); await page?.close(); }
}
