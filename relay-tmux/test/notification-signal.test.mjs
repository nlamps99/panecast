import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationSignal } from '../src/notification-signal.mjs';
import { inboxEvent } from '../src/inbox.mjs';

const cases = JSON.parse(readFileSync(new URL('../../docs/specs/fixtures/notification-signals.json', import.meta.url), 'utf8'));
for (const { label, event, expected } of cases) test(label, () => {
  assert.equal(notificationSignal(event), expected);
  const retained = inboxEvent(event);
  if (retained) assert.equal(notificationSignal(retained), expected);
  if (expected) assert.ok(retained);
});
