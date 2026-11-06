import type { EventFrame } from '../protocol/frames';
import { lifecycleNotificationId, notificationSignal } from './notificationSignal';

/**
 * Which cmux events belong in the inbox, and what they say. A port of
 * `InboxNotification` in `relay/Sources/SharedKit/InboxNotification.swift`,
 * which also decides what the relay pushes over APNs: the same events count,
 * the same payload fields are read in the same order, and a "needs input"
 * event without an id gets the same deterministic id, so a prompt the agent
 * repeats maps to one inbox item.
 *
 * Only the fallback titles differ: they are Chinese here. The synthetic id is
 * still built from SharedKit's English fallback, so ids match the relay's.
 */
export type InboxRecord = {
  id: string;
  /**
   * `payload`: cmux sent an id. `content`: derived from the event's content
   * (a needs-input event without an id), so a repeat has the same id.
   * `local`: made up on this phone, unique per event.
   */
  idSource: 'payload' | 'content' | 'local';
  /** Null when the event names no workspace (SharedKit's `"unknown"`). */
  workspaceId: string | null;
  surfaceId: string | null;
  /** Never empty; a Chinese fallback when the event has no title. */
  title: string;
  subtitle: string | null;
  /** Empty when the event carries no text besides the title. */
  body: string;
  /** `ts` as sent, normally seconds since the epoch. */
  ts: number | null;
  /** A question, approval request, failure or blocker needs attention. */
  needsInput: boolean;
};

/** `EventCategory` raw values; SharedKit decodes anything else as `unknown`. */
const KNOWN_CATEGORIES = new Set(['workspace', 'surface', 'notification', 'system', 'agent', 'hook']);

const SYNTHETIC_SLUG_LENGTH = 96;

type Source = 'Codex' | 'OpenAI' | 'Claude Code' | 'cmux hook' | 'Agent' | 'cmux';

const SOURCE_LABEL: Record<Source, string> = {
  Codex: 'Codex',
  OpenAI: 'OpenAI',
  'Claude Code': 'Claude Code',
  'cmux hook': 'cmux',
  Agent: '智能体',
  cmux: 'cmux',
};

type Signals = { category: string; text: string; notification: boolean; needsInput: boolean };

/** Questions/problems and explicit task completion, shared with relay push filtering. */
export function isInboxEvent(event: EventFrame): boolean {
  const signals = classify(event);
  return signals.notification || signals.needsInput;
}

/** `InboxNotification.requiresUserInput`. */
export function requiresUserInput(event: EventFrame): boolean {
  return classify(event).needsInput;
}

/**
 * `InboxNotification.record(from:)`. Returns null for events that do not
 * belong in the inbox. `newLocalId` is called only when the event has no id
 * and is not a needs-input event.
 */
export function parseInboxEvent(event: EventFrame, newLocalId: () => string): InboxRecord | null {
  const signals = classify(event);
  if (!signals.notification && !signals.needsInput) return null;
  if (!isObject(event.payload)) return null;
  const payload = event.payload;

  // SharedKit first tries the payload as a complete `NotificationRecord`.
  const decoded = decodeNotificationRecord(payload);
  if (decoded) {
    return {
      id: decoded.id,
      idSource: 'payload',
      workspaceId: decoded.workspaceId || null,
      surfaceId: decoded.surfaceId || null,
      title: decoded.title || fallbackTitle(event, signals, 'display'),
      subtitle: decoded.subtitle || null,
      body: decoded.body === decoded.title ? '' : decoded.body,
      ts: decoded.ts,
      needsInput: signals.needsInput,
    };
  }

  const workspaceId =
    stringValue(payload, 'workspace_id') ??
    stringValue(payload, 'workspaceId') ??
    stringValue(payload, 'workspaceID') ??
    stringValue(payload, 'workspace');
  const payloadTitle = stringValue(payload, 'title') ?? stringValue(payload, 'headline');
  const payloadBody =
    stringValue(payload, 'body') ??
    stringValue(payload, 'message') ??
    stringValue(payload, 'text') ??
    stringValue(payload, 'summary') ??
    stringValue(payload, 'reason') ??
    stringValue(payload, 'status') ??
    stringValue(payload, 'prompt') ??
    nestedStringValue(payload, ['details', 'message']) ??
    nestedStringValue(payload, ['details', 'body']);
  const surfaceId =
    stringValue(payload, 'surface_id') ??
    stringValue(payload, 'surfaceId') ??
    stringValue(payload, 'surfaceID') ??
    stringValue(payload, 'surface');
  const payloadId =
    stringValue(payload, 'id') ??
    lifecycleNotificationId(event) ??
    stringValue(payload, 'notification_id') ??
    stringValue(payload, 'notificationId') ??
    stringValue(payload, 'event_id') ??
    stringValue(payload, 'eventId') ??
    nestedStringValue(payload, ['details', 'id']);

  let id: string;
  let idSource: InboxRecord['idSource'];
  if (payloadId) {
    id = payloadId;
    idSource = 'payload';
  } else if (signals.needsInput) {
    // SharedKit's own title and body, so the id matches the relay's.
    const title = payloadTitle ?? fallbackTitle(event, signals, 'sharedKit');
    const body = payloadBody ?? title;
    id = syntheticNeedsInputId(event.name, workspaceId ?? 'unknown', surfaceId, title, body);
    idSource = 'content';
  } else {
    id = newLocalId();
    idSource = 'local';
  }

  const title = payloadTitle ?? fallbackTitle(event, signals, 'display');
  return {
    id,
    idSource,
    workspaceId,
    surfaceId,
    title,
    subtitle:
      stringValue(payload, 'subtitle') ??
      stringValue(payload, 'workspace_title') ??
      stringValue(payload, 'workspaceTitle') ??
      stringValue(payload, 'surface_title') ??
      stringValue(payload, 'surfaceTitle'),
    // SharedKit repeats the title as the body; showing it twice adds nothing.
    body: payloadBody === null || payloadBody === title ? '' : payloadBody,
    ts: intValue(payload, 'ts'),
    needsInput: signals.needsInput,
  };
}

/**
 * The id SharedKit gives a needs-input event that carries none: its name,
 * workspace, surface, title and body, with everything but letters, marks and
 * digits turned into single dashes, cut to 96 characters.
 */
export function syntheticNeedsInputId(
  name: string,
  workspaceId: string,
  surfaceId: string | null,
  title: string,
  body: string,
): string {
  const raw = [name, workspaceId, surfaceId ?? '', title, body].join('|');
  let mapped = '';
  for (const char of raw) mapped += isAlphanumeric(char) ? char : '-';
  const slug = mapped.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return `needs-input-${prefixCharacters(slug, SYNTHETIC_SLUG_LENGTH)}`;
}

function classify(event: EventFrame): Signals {
  const category = KNOWN_CATEGORIES.has(event.category) ? event.category : 'unknown';
  const text = searchText(event, category);
  const signal = notificationSignal(event);
  return {
    category,
    text,
    notification: signal !== null,
    needsInput: signal === 'attention',
  };
}

function searchText(event: EventFrame, category: string): string {
  const values = [category, event.name];
  if (isObject(event.payload)) {
    for (const key of ['app', 'source', 'agent', 'model', 'title', 'message', 'body']) {
      const value = stringValue(event.payload, key);
      if (value) values.push(value);
    }
    const detail = nestedStringValue(event.payload, ['details', 'message']);
    if (detail) values.push(detail);
  }
  return normalize(values.join(' '));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]/g, ' ');
}

function sourceOf(signals: Signals): Source {
  const { text, category } = signals;
  if (text.includes('codex')) return 'Codex';
  if (text.includes('openai')) return 'OpenAI';
  if (text.includes('claude')) return 'Claude Code';
  if (category === 'hook') return 'cmux hook';
  if (category === 'agent') return 'Agent';
  return 'cmux';
}

/** `titleFallback` in SharedKit, or the Chinese text shown in the app. */
function fallbackTitle(event: EventFrame, signals: Signals, flavor: 'sharedKit' | 'display'): string {
  if (signals.needsInput) {
    const source = sourceOf(signals);
    if (flavor === 'sharedKit') return `${source} needs input`;
    const label = SOURCE_LABEL[source];
    // A space between Latin and Chinese text, none between Chinese words.
    return /[A-Za-z0-9]$/.test(label) ? `${label} 需要你回应` : `${label}需要你回应`;
  }
  if (notificationSignal(event) === 'completed') return flavor === 'sharedKit' ? 'Task completed' : '任务已完成';
  if (event.name === 'notification.created') return flavor === 'sharedKit' ? 'cmux 알림' : 'cmux 通知';
  return event.name;
}

type DecodedRecord = {
  id: string;
  workspaceId: string;
  surfaceId: string | null;
  title: string;
  subtitle: string | null;
  body: string;
  ts: number;
};

/**
 * SharedKit decodes the payload as `NotificationRecord` with
 * `convertFromSnakeCase`, so `workspace_id` and `workspaceId` both work. Every
 * field but `surfaceId` and `subtitle` is required; a wrong type anywhere
 * fails the whole decode.
 */
function decodeNotificationRecord(payload: Record<string, unknown>): DecodedRecord | null {
  const field = (camel: string, snake = camel): unknown =>
    Object.prototype.hasOwnProperty.call(payload, snake) ? payload[snake] : payload[camel];
  const id = field('id');
  const workspaceId = field('workspaceId', 'workspace_id');
  const title = field('title');
  const body = field('body');
  const ts = field('ts');
  const threadId = field('threadId', 'thread_id');
  const surfaceId = optionalString(field('surfaceId', 'surface_id'));
  const subtitle = optionalString(field('subtitle'));
  if (
    typeof id !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof threadId !== 'string' ||
    typeof ts !== 'number' ||
    !Number.isInteger(ts) ||
    surfaceId === undefined ||
    subtitle === undefined
  ) {
    return null;
  }
  return { id, workspaceId, surfaceId, title, subtitle, body, ts };
}

/** Null when absent, the string when a string, undefined (a decode failure) otherwise. */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function stringValue(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nestedStringValue(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  let value: unknown = payload;
  for (const key of keys) {
    if (!isObject(value)) return null;
    value = value[key];
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Like SharedKit's `intValue`: integers, truncated doubles, and strings holding an integer. */
function intValue(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return Number(value);
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Foundation's `CharacterSet.alphanumerics`: Unicode letters, marks and numbers. */
const ALPHANUMERIC = unicodeRegExp('^[\\p{L}\\p{M}\\p{N}]$', /^[A-Za-z0-9]$/);
const MARK = unicodeRegExp('^\\p{M}$', /^[̀-ͯ]$/);

function unicodeRegExp(source: string, fallback: RegExp): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch {
    return fallback;
  }
}

function isAlphanumeric(char: string): boolean {
  return ALPHANUMERIC.test(char);
}

/**
 * Swift's `prefix(_:)` counts characters (grapheme clusters). A combining mark
 * joins the character before it; that covers the slugs this sees, which hold
 * only letters, marks, digits and dashes.
 */
function prefixCharacters(text: string, count: number): string {
  let out = '';
  let characters = 0;
  for (const scalar of text) {
    const joinsPrevious = out.length > 0 && MARK.test(scalar);
    if (!joinsPrevious) {
      if (characters === count) break;
      characters++;
    }
    out += scalar;
  }
  return out;
}
