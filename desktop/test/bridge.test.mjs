import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(handler = async () => {}) {
  const calls = [];
  const window = { __TAURI__: { core: {
    Channel: class {},
    invoke(command, args) { calls.push({ command, args }); return handler(command, args); },
  } } };
  vm.runInNewContext(source, { window });
  return { bridge: window.panecastDesktop, calls };
}

test('native socket events arrive through one channel and sends retain order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { bridge, calls } = setup(async (command, args) => {
    if (command === 'socket_send' && args.data === 'hello') await gate;
  });
  const events = [];
  const unsubscribe = bridge.onSocket(event => events.push(event));
  await bridge.connectSocket('socket', 'wss://example.com/v1/ws', ['cmuxremote.v1'], { Authorization: 'Bearer test' });
  const channel = calls[0].args.onEvent;
  channel.onmessage({ id: 'socket', type: 'open' });
  bridge.sendSocket('socket', 'hello');
  bridge.sendSocket('socket', 'rpc');
  await tick();
  assert.deepEqual(calls.filter(call => call.command === 'socket_send').map(call => call.args.data), ['hello']);
  release(); await tick();
  assert.deepEqual(calls.filter(call => call.command === 'socket_send').map(call => call.args.data), ['hello', 'rpc']);
  channel.onmessage({ id: 'socket', type: 'message', data: '终端输出' });
  assert.equal(events[1].data, '终端输出');
  unsubscribe();
  channel.onmessage({ id: 'socket', type: 'close', code: 1000 });
  assert.equal(events.length, 2);
  assert.throws(() => bridge.sendSocket('socket', 'late'), /连接已断开/);
});

test('failed IPC send closes the socket and does not send queued terminal input', async () => {
  const { bridge, calls } = setup(async command => {
    if (command === 'socket_send') throw new Error('queue full');
  });
  const events = [];
  bridge.onSocket(event => events.push(event));
  await bridge.connectSocket('socket', 'wss://example.com/v1/ws', ['cmuxremote.v1'], { Authorization: 'Bearer test' });
  bridge.sendSocket('socket', 'first'); bridge.sendSocket('socket', 'second');
  await tick();
  assert.equal(calls.filter(call => call.command === 'socket_send').length, 1);
  assert.equal(events.at(-1).code, 1006);
  assert.equal(calls.at(-1).command, 'socket_close');
});

test('clipboard writes use native IPC after an asynchronous operation', async () => {
  const { bridge, calls } = setup(async command => command === 'clipboard_write');
  await tick();
  assert.equal(await bridge.writeClipboard('复制终端内容'), true);
  assert.equal(calls[0].args.text, '复制终端内容');
});

test('HTTP cancellation before native registration is delivered once registered', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { bridge, calls } = setup(async command => command === 'request' ? response : undefined);
  const pending = bridge.request('http', 'https://example.com/v1/health', {});
  bridge.abortRequest('http');
  assert.equal(calls.length, 1);
  calls[0].args.onStarted.onmessage();
  assert.equal(calls[1].command, 'abort_request');
  finish({ status: 200, body: '{}' }); await pending;
  bridge.abortRequest('http');
  assert.equal(calls.length, 2);
});
