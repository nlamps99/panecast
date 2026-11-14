import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTmuxRelay } from '../server.mjs';
import { SourceRegistry } from './registry.mjs';
import { HubSession } from './session.mjs';
import { RpcPeer, localEndpoint } from './rpc.mjs';
import { scoped, scopeResult } from './ids.mjs';
import { WeixinRuntime } from '../weixin/runtime.mjs';

export async function createHub(config, options = {}) {
  const registry = new SourceRegistry(config.sources ?? [], options);
  const effective = { ...config, hub_event_monitor: true, port: config.port ?? 4400, state_directory: config.state_directory ?? join(homedir(), '.cmuxremote', 'hub') };
  const relay = await createTmuxRelay(effective, { backend: registry, backendName: 'hub',
    allowInboxEvent: (frame) => !frame.payload?.source_id || registry.sources.has(frame.payload.source_id),
    createSession: ({ send, close, notify }) => new HubSession(registry, effective, send, close, notify) });
  const weixin = new WeixinRuntime(registry, effective, relay.journal, options.weixin);
  const monitors = new Map();
  let timer, monitoring = false;
  const unlisten = registry.onEvent((frame) => { void relay.ingestEvent(frame).catch(() => {}); });
  const forward = (id, frame, replay = false) => {
    if (frame.type !== 'event' || !registry.sources.has(id)) return Promise.resolve();
    const value = scopeResult(id, frame);
    value.payload = { ...value.payload, source_id: id };
    if (frame.payload?.id) value.payload.id = scoped(id, frame.payload.id);
    if (frame.payload?.panecast_event_id) value.payload.panecast_origin_event_id = `${id}:${frame.payload.panecast_event_id}`;
    return relay.ingestEvent(value, { replay });
  };
  async function monitor() {
    if (monitoring) return; monitoring = true;
    try {
      for (const [id, peer] of monitors) {
        const source = registry.sources.get(id);
        if (!source || source.config !== peer.sourceConfig || peer.closed) { peer.close(); monitors.delete(id); }
      }
      for (const { config: c } of registry.sources.values()) {
        if (c.type === 'codex') {
          void registry.codex(c.id).connection().catch(() => {});
        } else if (c.type === 'cmux' && !monitors.has(c.id)) {
          const peer = new RpcPeer({ url: localEndpoint(c.url), token: c.token, protocols: ['cmuxremote.v1'], hello: { protocolVersion: 1, appVersion: 'panecast-hub/0.1', deviceId: c.device_id } });
          peer.sourceConfig = c; monitors.set(c.id, peer);
          peer.onMessage((frame) => { void forward(c.id, frame).catch(() => {}); });
          void peer.connect().then(async () => {
            // Catch retained notifications missed while this source connection
            // was down. Origin IDs make these stable in the hub journal.
            let cursor, head;
            for (let page = 0; page < 20; page++) {
              const result = await peer.call('inbox.sync', { cursor, until_cursor: head, limit: 100 });
              for (const event of result.events ?? []) await forward(c.id, event, true);
              cursor = result.next_cursor; head = result.head_cursor;
              if (!result.has_more) break;
            }
          }).catch(() => {});
        }
      }
    } finally { monitoring = false; }
  }
  return { ...relay, registry,
    async start() { const address = await relay.start(); await monitor(); timer = setInterval(() => void monitor(), 5000); timer.unref(); weixin.start(); return address; },
    async close() { clearInterval(timer); unlisten(); await weixin.close(); for (const peer of monitors.values()) peer.close(); monitors.clear(); registry.close(); await relay.close(); },
    reloadSources(sources) { registry.reload(sources); void monitor(); },
  };
}
