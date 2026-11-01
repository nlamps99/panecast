import type { Notification } from 'expo-notifications';

import type { InboxItem } from '../session/inboxStore';

/**
 * What a notification points at. Remote pushes come from the relay's
 * `APNsProvider.payloadData` (top-level `workspace_id`, `surface_id`,
 * `notification_id`, `thread_id`); local ones are posted by this app and also
 * carry `computer_id`. `relay_id` is not sent by the relay today; it is read so
 * a relay that adds it lets a tap switch to the right computer.
 */
export type NotificationInfo = {
  /** Posted by this app from the inbox, rather than pushed by a relay. */
  local: boolean;
  workspaceId: string | null;
  surfaceId: string | null;
  notificationId: string | null;
  /** This app's id for the paired computer (local notifications only). */
  computerId: string | null;
  /** The relay id from the pairing (if the relay ever includes it). */
  relayId: string | null;
};

const LOCAL_SOURCE = 'panecast.inbox';

/** The `data` of a local notification for an inbox item. */
export function localNotificationData(item: InboxItem, computerId: string): Record<string, string> {
  const data: Record<string, string> = { source: LOCAL_SOURCE, computer_id: computerId, notification_id: item.id };
  if (item.workspaceId) data.workspace_id = item.workspaceId;
  if (item.surfaceId) data.surface_id = item.surfaceId;
  return data;
}

/** The identifier of a local notification; posting the same item twice replaces the first. */
export function localNotificationIdentifier(item: InboxItem, computerId: string): string {
  return `inbox.${computerId}.${item.id}`;
}

/**
 * Reads where a notification points. Local notifications keep their fields in
 * `content.data`. On iOS a remote push's custom keys are not in `content.data`
 * (expo-notifications only fills it from an Expo-shaped `body` key); they are
 * in `trigger.payload`, the raw `userInfo`.
 */
export function parseNotification(notification: Notification): NotificationInfo {
  const fields = { ...pushPayload(notification), ...asRecord(notification.request.content.data) };
  return {
    local: fields.source === LOCAL_SOURCE,
    // The relay falls back to the literal "unknown" when cmux sent no workspace.
    workspaceId: id(fields.workspace_id, 'unknown'),
    // Older local notifications used "" for "no surface".
    surfaceId: id(fields.surface_id),
    notificationId: id(fields.notification_id),
    computerId: id(fields.computer_id),
    relayId: id(fields.relay_id),
  };
}

function pushPayload(notification: Notification): Record<string, unknown> {
  const trigger: unknown = notification.request.trigger;
  if (typeof trigger !== 'object' || trigger === null) return {};
  const { type, payload } = trigger as { type?: unknown; payload?: unknown };
  return type === 'push' ? asRecord(payload) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function id(value: unknown, ...placeholders: string[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || placeholders.includes(value)) return null;
  return value;
}
