import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { RpcPeer, lineFramer } from '../src/hub/rpc.mjs';
import { CodexSource } from '../src/hub/codex.mjs';

test('a timed-out Codex initialization can reconnect instead of caching failure forever', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  let connections = 0;
  server.on('connection', (ws) => {
    const number = ++connections;
    ws.on('message', (data) => {
      const request = JSON.parse(data);
      if (number === 1 || request.id == null) return;
      ws.send(JSON.stringify({ id: request.id, result: request.method === 'thread/loaded/list' ? { data: [] } : {} }));
    });
  });
  const source = new CodexSource({ id: 'codex', mode: 'attach', access: 'control', url: `ws://127.0.0.1:${server.address().port}` }, () => {}, (options) => new RpcPeer({ ...options, timeoutMs: 100 }));
  t.after(() => source.close());
  await assert.rejects(source.connection(), { code: 'timeout' });
  assert.equal(source.peer.closed, true);
  const peer = await source.connection();
  assert.deepEqual(await peer.call('thread/loaded/list'), { data: [] });
  assert.equal(connections, 2);
});

test('stdio framing splits lines across any chunking and stops at an oversized line', () => {
  const lines = [], framer = lineFramer((line) => lines.push(line));
  for (const chunk of ['a\nb', 'c\n', '', 'dd', 'd\n\n中', '文\r\n', 'tail']) framer(chunk);
  assert.deepEqual(lines, ['a', 'bc', 'ddd', '', '中文\r']);
  framer('\n'); assert.equal(lines.at(-1), 'tail');
  let overflows = 0; const kept = [];
  const small = lineFramer((line) => kept.push(line), { maxBytes: 10, onOverflow: () => overflows++ });
  small('ok\n123456'); small('7890'); assert.equal(overflows, 0);
  small('1\nlater\n'); assert.equal(overflows, 1, 'a line past the limit, even once complete');
  small('more\n'); small('x'.repeat(50)); assert.equal(overflows, 1); assert.deepEqual(kept, ['ok']);
  const bytes = lineFramer(() => {}, { maxBytes: 8, onOverflow: () => overflows++ });
  bytes('中文中'); assert.equal(overflows, 2, 'the limit counts UTF-8 bytes');
});

test('a large message in many small chunks is framed in linear time', () => {
  const size = 16 * 1024 * 1024, piece = 'x'.repeat(16 * 1024);
  let received = 0; const framer = lineFramer((line) => { received = line.length; }, { maxBytes: 32 * 1024 * 1024 });
  const started = Date.now();
  for (let sent = 0; sent < size; sent += piece.length) framer(piece);
  framer('\n');
  assert.equal(received, size);
  // Concatenating and re-scanning per chunk took seconds for this; one pass takes milliseconds.
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

test('a stdio peer receives replies and events split across writes', async (t) => {
  const script = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk; let at;
      while ((at = input.indexOf('\\n')) >= 0) {
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        const reply = JSON.stringify({ id: request.id, result: { echo: request.params.text, big: 'y'.repeat(3 * 1024 * 1024) } }) + '\\n';
        process.stdout.write(JSON.stringify({ method: 'thread/started', params: { threadId: 'x' } }) + '\\n' + reply.slice(0, 7));
        let offset = 7; const step = () => { if (offset >= reply.length) return; process.stdout.write(reply.slice(offset, offset + 65536)); offset += 65536; setImmediate(step); }; step();
      }
    });`;
  const peer = new RpcPeer({ command: process.execPath, args: ['-e', script] });
  t.after(() => peer.close());
  const events = []; peer.onMessage((message) => events.push(message.method));
  const result = await peer.call('echo', { text: '中文' });
  assert.equal(result.echo, '中文'); assert.equal(result.big.length, 3 * 1024 * 1024);
  assert.deepEqual(events, ['thread/started']);
});

test('an upstream frame that is not an object ends the connection instead of throwing', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  server.on('connection', (ws) => ws.on('message', () => { ws.send('null'); ws.send('[1]'); }));
  const peer = new RpcPeer({ url: `ws://127.0.0.1:${server.address().port}` });
  const seen = []; peer.onMessage((message) => seen.push(message.method));
  await assert.rejects(peer.call('workspace.list'), { code: 'offline' });
  assert.equal(peer.closed, true); assert.deepEqual(seen, ['panecast/disconnected']);
});
