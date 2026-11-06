import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { RpcPeer } from '../src/hub/rpc.mjs';
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
