import type { Notification, NotificationPermissionsStatus } from 'expo-notifications';

import type { InboxItem } from '../../session/inboxStore';
import { localNotificationData, parseNotification, type NotificationInfo } from '../payload';
import { behaviorFor, permissionFrom, presentationFor, shouldPostLocal, type PresentationContext } from '../policy';

function notification(data: Record<string, unknown> | undefined, trigger: unknown): Notification {
  return {
    date: 1,
    request: { identifier: 'n', content: { title: 't', subtitle: null, body: 'b', data, categoryIdentifier: null, sound: null }, trigger },
  } as unknown as Notification;
}

const item: InboxItem = {
  id: 'n-1',
  workspaceId: 'w1',
  surfaceId: null,
  title: '测试通过',
  subtitle: null,
  body: '',
  at: 0,
  read: false,
  needsInput: false,
};

describe('parseNotification', () => {
  it('reads a relay push from the iOS trigger payload (userInfo), not content.data', () => {
    const info = parseNotification(
      notification(undefined, {
        type: 'push',
        payload: { aps: { alert: {} }, workspace_id: 'w1', surface_id: 's1', notification_id: 'n1', thread_id: 'workspace-w1' },
      }),
    );
    expect(info).toEqual({ local: false, workspaceId: 'w1', surfaceId: 's1', notificationId: 'n1', computerId: null, relayId: null });
  });

  it('treats the relay\'s "unknown" workspace and an empty surface as absent', () => {
    const info = parseNotification(notification(undefined, { type: 'push', payload: { workspace_id: 'unknown', surface_id: '' } }));
    expect(info.workspaceId).toBeNull();
    expect(info.surfaceId).toBeNull();
  });

  it('round-trips the data of our own local notifications', () => {
    const info = parseNotification(notification(localNotificationData(item, 'c1'), null));
    expect(info).toEqual({ local: true, workspaceId: 'w1', surfaceId: null, notificationId: 'n-1', computerId: 'c1', relayId: null });
  });

  it('reads a relay id if a relay sends one', () => {
    expect(parseNotification(notification(undefined, { type: 'push', payload: { relay_id: 'mac2' } })).relayId).toBe('mac2');
  });
});

describe('permissionFrom', () => {
  const base = { expires: 'never', granted: false, canAskAgain: true, status: 'undetermined' } as const;
  const ios = (status: number) => ({ ...base, ios: { status } }) as unknown as NotificationPermissionsStatus;

  it('reads ios.status: provisional counts as granted, denied cannot be asked again', () => {
    expect(permissionFrom(ios(0))).toEqual({ status: 'undetermined', canAskAgain: true });
    expect(permissionFrom(ios(1))).toEqual({ status: 'denied', canAskAgain: false });
    expect(permissionFrom(ios(2)).status).toBe('granted');
    expect(permissionFrom(ios(3)).status).toBe('granted');
  });

  it('keeps Android canAskAgain after a first refusal', () => {
    const denied = { ...base, status: 'denied', canAskAgain: true } as unknown as NotificationPermissionsStatus;
    expect(permissionFrom(denied)).toEqual({ status: 'denied', canAskAgain: true });
    const granted = { ...base, status: 'granted', granted: true } as unknown as NotificationPermissionsStatus;
    expect(permissionFrom(granted).status).toBe('granted');
  });
});

describe('presentationFor', () => {
  const remote: NotificationInfo = { local: false, workspaceId: 'w1', surfaceId: 's1', notificationId: 'n1', computerId: null, relayId: null };
  const ctx: PresentationContext = {
    appActive: true,
    route: '/',
    computerId: 'c1',
    relayId: 'mac2',
    workspaceIds: ['w1', 'w2'],
    target: { workspaceId: 'w1', surfaceId: 's1' },
    connected: true,
  };

  it('hides a push for the terminal on screen', () => {
    expect(presentationFor(remote, { ...ctx, route: '/terminal' })).toBe('hide');
    expect(presentationFor({ ...remote, surfaceId: null }, { ...ctx, route: '/terminal' })).toBe('hide');
  });

  it('nudges for another terminal of the same computer, without adding to Notification Center', () => {
    expect(presentationFor({ ...remote, surfaceId: 's9' }, { ...ctx, route: '/terminal' })).toBe('nudge');
    expect(presentationFor(remote, ctx)).toBe('nudge');
    expect(behaviorFor('nudge')).toEqual({ shouldShowBanner: true, shouldShowList: false, shouldPlaySound: true, shouldSetBadge: false });
  });

  it('hides on the inbox tab, where the item shows up live', () => {
    expect(presentationFor(remote, { ...ctx, route: '/inbox' })).toBe('hide');
  });

  it('shows in full when the inbox will not get it: another computer, or disconnected', () => {
    expect(presentationFor({ ...remote, workspaceId: 'other' }, ctx)).toBe('show');
    expect(presentationFor({ ...remote, relayId: 'other-mac' }, ctx)).toBe('show');
    expect(presentationFor(remote, { ...ctx, route: '/inbox', connected: false })).toBe('show');
  });

  it('never re-shows our own local notification in the foreground', () => {
    expect(presentationFor({ ...remote, local: true, computerId: 'c1' }, ctx)).toBe('hide');
    expect(behaviorFor('hide')).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  });
});

describe('shouldPostLocal', () => {
  const base = { os: 'android', appActive: false, permission: 'granted' as const, relayPushes: false };

  it('posts only in the background with permission', () => {
    expect(shouldPostLocal(base)).toBe(true);
    expect(shouldPostLocal({ ...base, appActive: true })).toBe(false);
    expect(shouldPostLocal({ ...base, permission: 'undetermined' })).toBe(false);
    expect(shouldPostLocal({ ...base, os: 'web' })).toBe(false);
  });

  it('leaves iOS to the relay when the relay holds the APNs token', () => {
    expect(shouldPostLocal({ ...base, os: 'ios' })).toBe(true);
    expect(shouldPostLocal({ ...base, os: 'ios', relayPushes: true })).toBe(false);
    expect(shouldPostLocal({ ...base, relayPushes: true })).toBe(true);
  });
});
