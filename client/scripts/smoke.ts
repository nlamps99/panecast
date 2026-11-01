/**
 * End-to-end check of the protocol layer against a real broker and relay:
 * pair, connect, subscribe, verify a screen checksum, page history.
 *
 *   <pairing URL on stdin> | node --experimental-transform-types \
 *     --import ./scripts/ts-resolve.mjs scripts/smoke.ts <device-id-file>
 *
 * Read-only toward the terminal: it never sends input. It prints counts and
 * pass/fail lines only, never tokens, pairing codes or terminal content. The
 * registered device id is written to <device-id-file> so the caller can revoke
 * it on the broker afterwards.
 */
/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { RelayConnection, type SocketLike } from '../src/protocol/connection';
import { brokerEndpoint, webSocketUrl } from '../src/protocol/endpoint';
import { parsePairingUrl } from '../src/protocol/pairing';
import { registerDevice } from '../src/protocol/register';
import { screenHash } from '../src/protocol/screen';
import { pickDefaultTarget } from '../src/session/surfaces';
import { TerminalSession } from '../src/session/terminalSession';

const deviceIdFile = process.argv[2];
if (!deviceIdFile) throw new Error('usage: smoke.ts <device-id-file>');

function step(ok: boolean, message: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function waitFor<T>(check: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 50);
  });
}

async function main() {
  const parsed = parsePairingUrl(await readStdin());
  step(parsed.ok, 'parse pairing URL');
  if (!parsed.ok) return;
  const endpointResult = brokerEndpoint(parsed.payload.serverUrl, parsed.payload.relayId);
  step(endpointResult.ok, 'broker endpoint');
  if (!endpointResult.ok) return;
  const endpoint = endpointResult.endpoint;

  const credentials = await registerDevice({
    endpoint,
    pairingCode: parsed.payload.pairingCode,
    clientId: `panecast-smoke-${randomUUID()}`,
    deviceName: 'Panecast smoke test',
  });
  writeFileSync(deviceIdFile, credentials.deviceId, { mode: 0o600 });
  step(true, 'register device');

  const connection = new RelayConnection({
    url: webSocketUrl(endpoint),
    token: credentials.token,
    deviceId: credentials.deviceId,
    appVersion: '0.1.0-smoke',
    createSocket: (url, protocols, headers) =>
      new (WebSocket as unknown as new (u: string, o: object) => SocketLike)(url, { protocols, headers }),
    log: (message) => console.log(`  [ws] ${message}`),
  });
  const session = new TerminalSession(connection, { liveLines: 120 });
  connection.start();
  const opened = await waitFor(() => connection.isOpen, 10_000);
  step(Boolean(opened), 'WebSocket open + hello accepted');
  if (!opened) return connection.stop();

  // Stay connected past the relay's 100 ms hello window.
  await new Promise((r) => setTimeout(r, 300));
  step(connection.isOpen, 'still open after the hello window');

  const target = await pickDefaultTarget(connection);
  step(target !== null, 'workspace.list + surface.list found a terminal');
  if (!target) return connection.stop();

  let checksums = 0;
  let matched = 0;
  connection.onPush((frame) => {
    if (frame.type !== 'screen.checksum' || frame.surfaceId !== target.surfaceId) return;
    const screen = session.getState().screen;
    if (frame.rev !== screen.rev) return;
    checksums++;
    if (screenHash(screen.rows, screen.cursor) === frame.hash) matched++;
  });

  session.setTarget(target);
  const live = await waitFor(() => session.getState().subscription === 'live', 10_000);
  step(Boolean(live), 'surface.subscribe');
  const rows = await waitFor(() => session.getState().screen.rows.length > 0 && session.getState().screen.rows, 10_000);
  step(Boolean(rows), `screen.diff applied (${rows ? rows.length : 0} rows)`);

  await waitFor(() => checksums >= 2, 15_000);
  step(checksums > 0 && matched === checksums, `screen.checksum matched ${matched}/${checksums}`);

  session.startBrowsing();
  await session.loadOlder();
  const browse = session.getState().browse;
  step(Boolean(browse && browse.started && !browse.error), `surface.history first page (${browse?.olderRows.length ?? 0} rows, more=${!browse?.exhausted})`);
  if (browse && !browse.exhausted) {
    const before = browse.olderRows.length;
    await session.loadOlder();
    const after = session.getState().browse;
    step(Boolean(after && !after.error && after.olderRows.length > before), `surface.history second page (${after?.olderRows.length ?? 0} rows)`);
  }
  session.resumeLive();
  session.setTarget(null);

  if (!browse || browse.exhausted) {
    // Page history on another terminal with more scrollback, without subscribing.
    const { listWorkspaces, listSurfaces } = await import('../src/session/surfaces');
    let paged = false;
    for (const workspace of await listWorkspaces(connection)) {
      for (const surface of await listSurfaces(connection, workspace.id)) {
        const ids = { workspace_id: workspace.id, surface_id: surface.id };
        const first = (await connection.call('surface.history', { ...ids, tail_lines: 40, limit: 50 }, 30_000)) as {
          rows: string[];
          anchor_rows?: string[];
          next_cursor: string | null;
        };
        if (!first.next_cursor) continue;
        const second = (await connection.call(
          'surface.history',
          { ...ids, cursor: first.next_cursor, limit: 50 },
          30_000,
        )) as { rows: string[]; next_cursor: string | null };
        step(
          first.rows.length === 50 && (first.anchor_rows?.length ?? 0) === 40 && second.rows.length > 0,
          `surface.history paging on another terminal (${first.rows.length} + ${second.rows.length} rows, anchor ${first.anchor_rows?.length ?? 0})`,
        );
        paged = true;
        break;
      }
      if (paged) break;
    }
    if (!paged) console.log('SKIP no terminal has more than 90 rows of scrollback');
  }

  session.dispose();
  connection.stop();
}

main().catch((error: unknown) => {
  console.log(`FAIL ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exitCode = 1;
});
