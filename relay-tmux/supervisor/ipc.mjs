import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, readFile } from 'node:fs/promises';

export async function callSupervisor(connectionFile, method, params = {}, timeout = 45000) {
  const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(connection.socket); let buffer = '';
    const fail = () => { socket.destroy(); reject(new Error('监工后台未响应；发送结果可能未知，请先查看状态。')); };
    socket.setTimeout(timeout, fail); socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ id: randomUUID(), token: connection.token, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 2_000_000) return fail();
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      socket.destroy();
      try { const message = JSON.parse(buffer.slice(0, newline)); message.ok ? resolve(message.result) : reject(new Error(message.error ?? '监工操作失败')); } catch { reject(new Error('监工后台响应无效')); }
    });
  });
}

export async function serveSupervisor(socketPath, token, dispatch) {
  const equal = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const server = net.createServer(socket => {
    let buffer = '', handled = false;
    socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 100000) return socket.destroy();
      const newline = buffer.indexOf('\n'); if (handled || newline < 0) return; handled = true;
      void (async () => {
        const request = JSON.parse(buffer.slice(0, newline));
        if (!equal(request.token)) throw new Error('监工连接未授权');
        socket.setTimeout(50000, () => socket.destroy());
        const result = await dispatch(request.method, request.params ?? {});
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      })().catch(error => socket.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 800) }) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return async () => { await new Promise(resolve => server.close(resolve)); await unlink(socketPath).catch(() => {}); };
}
