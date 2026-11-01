import { RpcCallError } from '../../protocol/connection';
import type { EventFrame, PushFrame } from '../../protocol/frames';
import { applyDiff, EMPTY_SCREEN, screenHash, type ScreenState } from '../../protocol/screen';
import { DemoChannel } from '../demoChannel';

/** Shared helpers for the demo tests. Kept out of `__tests__/`, where jest would run it as a suite. */

export const plain = (rows: readonly string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());

/** Calls the demo and lets its 40 ms latency (plus `extraMs`) pass. */
export async function rpc<T = Record<string, unknown>>(
  channel: DemoChannel,
  method: string,
  params: Record<string, unknown> = {},
  extraMs = 0,
): Promise<T> {
  const promise = channel.call<T>(method, params);
  await jest.advanceTimersByTimeAsync(50 + extraMs);
  return promise;
}

/** Like `rpc`, for a call expected to fail; returns the error. */
export async function rpcError(channel: DemoChannel, method: string, params: Record<string, unknown> = {}): Promise<RpcCallError> {
  const settled = channel.call(method, params).then(
    () => null,
    (error: unknown) => error,
  );
  await jest.advanceTimersByTimeAsync(50);
  const error = await settled;
  if (!(error instanceof RpcCallError)) throw new Error(`${method} did not fail with an RpcCallError`);
  return error;
}

/**
 * What a phone holds: applies every frame the demo pushes, checks each
 * `screen.checksum` against its own copy, and records events.
 */
export class Mirror {
  screens = new Map<string, ScreenState>();
  diffs = 0;
  droppedDiffs = 0;
  checksums = 0;
  mismatches: string[] = [];
  events: EventFrame[] = [];
  frames: PushFrame[] = [];
  readonly dispose: () => void;

  constructor(channel: DemoChannel) {
    this.dispose = channel.onPush((frame) => {
      this.frames.push(frame);
      this.apply(frame);
    });
  }

  rows(surfaceId: string): string[] {
    return plain(this.screens.get(surfaceId)?.rows ?? []);
  }

  eventNames(category?: string): string[] {
    return this.events.filter((e) => !category || e.category === category).map((e) => e.name);
  }

  private apply(frame: PushFrame): void {
    switch (frame.type) {
      case 'screen.diff': {
        const before = this.screens.get(frame.surfaceId) ?? EMPTY_SCREEN;
        const after = applyDiff(before, frame);
        if (after === before) this.droppedDiffs++;
        this.screens.set(frame.surfaceId, after);
        this.diffs++;
        return;
      }
      case 'screen.checksum': {
        this.checksums++;
        const screen = this.screens.get(frame.surfaceId);
        if (!screen || screen.rev !== frame.rev || screenHash(screen.rows, screen.cursor) !== frame.hash) {
          this.mismatches.push(`${frame.surfaceId}@${frame.rev}`);
        }
        return;
      }
      case 'event':
        this.events.push(frame);
        return;
      default:
        return;
    }
  }
}

/** SharedKit's `isNeedsInputEvent`, ported: a needs-human phrase plus a known agent or a direct "needs input". */
export function isNeedsInputEvent(event: EventFrame): boolean {
  const leaves: string[] = [event.category, event.name];
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value) leaves.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(event.payload);
  const text = leaves.join(' ').toLowerCase().replace(/[_-]/g, ' ');
  const needsHuman = ['needs input', 'waiting for your input', 'needs your attention', 'needs your approval', 'approval required', 'permission prompt'].some(
    (phrase) => text.includes(phrase),
  );
  const knownAgent = ['claude', 'codex', 'openai'].some((name) => text.includes(name));
  const direct = text.includes('needs input') || event.name.toLowerCase().replace(/[_-]/g, ' ').includes('needs input');
  return needsHuman && (knownAgent || direct);
}

/** True when the agent name would come from a real product (the demo must stay neutral). */
export function namesARealAgent(event: EventFrame): boolean {
  return /claude|codex|openai/i.test(JSON.stringify(event.payload));
}
