import { notificationAllowed, notificationGroup, sanitizeNotificationPreferences } from '../preferences';
const item = { workspaceId: 'w', surfaceId: 's', title: 'approval', body: 'please review', needsInput: true };
it('applies project mute and needs-input filters independently of read state', () => {
  expect(notificationAllowed(sanitizeNotificationPreferences({ muted_workspaces: ['w'] }), item)).toBe(false);
  expect(notificationAllowed(sanitizeNotificationPreferences({ needs_input_only: true }), { ...item, needsInput: false })).toBe(false);
  expect(notificationAllowed(sanitizeNotificationPreferences({ needs_input_only: true }), item)).toBe(true);
});
it('handles overnight quiet hours in the selected timezone including DST', () => {
  const prefs = sanitizeNotificationPreferences({ quiet_hours: { enabled: true, start_minutes: 22 * 60, end_minutes: 8 * 60, time_zone: 'America/Los_Angeles' } });
  expect(notificationAllowed(prefs, item, Date.parse('2026-11-04T07:00:00Z'))).toBe(false); // 23:00 PST
  expect(notificationAllowed(prefs, item, Date.parse('2026-11-04T16:00:00Z'))).toBe(true); // 08:00 PST
  expect(notificationAllowed(prefs, item, Date.parse('2026-07-04T05:00:00Z'))).toBe(false); // 22:00 PDT
});
it('defines equal endpoints as all-day quiet and clamps malformed settings', () => {
  const prefs = sanitizeNotificationPreferences({ quiet_hours: { enabled: true, start_minutes: 0, end_minutes: 0, time_zone: 'invalid/zone' }, dedupe_seconds: -10 });
  expect(prefs.quiet_hours.time_zone).toBe('UTC'); expect(prefs.dedupe_seconds).toBe(0);
  expect(notificationAllowed(prefs, item)).toBe(false);
});
it('groups matching content only within the same task and workspace', () => {
  expect(notificationGroup(item)).not.toBe(notificationGroup({ ...item, workspaceId: 'other' }));
  expect(notificationGroup({ ...item, taskId: 'a' })).not.toBe(notificationGroup({ ...item, taskId: 'b' }));
});
