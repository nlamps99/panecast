import type { NotificationBehavior, NotificationPermissionsStatus } from 'expo-notifications';

import type { NotificationInfo } from './payload';

export type Permission = 'unknown' | 'undetermined' | 'granted' | 'denied' | 'unsupported';

export type PermissionState = { status: Permission; canAskAgain: boolean };

/** `IosAuthorizationStatus` values, kept here so this module needs no runtime import. */
const IOS_DENIED = 1;
const IOS_AUTHORIZED = 2;
const IOS_PROVISIONAL = 3;
const IOS_EPHEMERAL = 4;

/**
 * On iOS the root `status` lumps provisional in with denied, so read
 * `ios.status` as the docs advise. Provisional and ephemeral may post (quietly);
 * the native client treats them as authorized too.
 */
export function permissionFrom(response: NotificationPermissionsStatus): PermissionState {
  const ios = response.ios?.status;
  if (typeof ios === 'number') {
    if (ios === IOS_AUTHORIZED || ios === IOS_PROVISIONAL || ios === IOS_EPHEMERAL) return { status: 'granted', canAskAgain: true };
    if (ios === IOS_DENIED) return { status: 'denied', canAskAgain: false };
    return { status: 'undetermined', canAskAgain: true };
  }
  const status: string = response.status;
  if (response.granted || status === 'granted') return { status: 'granted', canAskAgain: response.canAskAgain };
  // Android 13+ reports `denied` with `canAskAgain` until the user has refused twice.
  if (status === 'denied') return { status: 'denied', canAskAgain: response.canAskAgain };
  return { status: 'undetermined', canAskAgain: response.canAskAgain };
}

/** `hide`: nothing. `nudge`: a banner and a sound, but not in Notification Center. `show`: everything. */
export type Presentation = 'hide' | 'nudge' | 'show';

export type PresentationContext = {
  appActive: boolean;
  /** expo-router pathname: `/`, `/terminal`, `/inbox`, `/settings`, `/pair`. */
  route: string;
  computerId: string | null;
  relayId: string | null;
  /** The connected computer's workspaces, to tell whether a push without a relay id is from it. */
  workspaceIds: readonly string[];
  /** The terminal the session is subscribed to. */
  target: { workspaceId: string; surfaceId: string } | null;
  /** The live socket is open, so the inbox gets this notification as an event too. */
  connected: boolean;
};

/**
 * Is the notification from the computer this app is connected to? Local
 * notifications name it; a relay push does not (yet), so fall back to the
 * relay id if one is ever sent, then to whether the workspace is one of ours.
 */
export function fromCurrentComputer(info: NotificationInfo, ctx: PresentationContext): boolean {
  if (info.computerId) return info.computerId === ctx.computerId;
  if (info.relayId) return info.relayId === ctx.relayId;
  return info.workspaceId !== null && ctx.workspaceIds.includes(info.workspaceId);
}

/**
 * What to show for a notification that arrives while the app is in the
 * foreground (the only time `setNotificationHandler` runs).
 *
 * - Our own local notifications only exist for the background; if one lands
 *   just as the app comes back, the inbox already has it.
 * - From the connected computer, while its socket is open, the same item
 *   reaches the inbox over the socket. On that terminal or on the inbox tab
 *   the user sees it already: hide. Elsewhere: a banner, kept out of
 *   Notification Center so it does not pile up beside the inbox.
 * - From another computer, or while disconnected, the inbox will not get it:
 *   show it normally.
 */
export function presentationFor(info: NotificationInfo, ctx: PresentationContext): Presentation {
  if (info.reminder) return 'show';
  if (info.local) return ctx.appActive ? 'hide' : 'show';
  if (!ctx.appActive) return 'show';
  if (!ctx.connected || !fromCurrentComputer(info, ctx)) return 'show';
  if (ctx.route === '/inbox') return 'hide';
  if (ctx.route === '/terminal' && ctx.target && info.workspaceId === ctx.target.workspaceId) {
    if (!info.surfaceId || info.surfaceId === ctx.target.surfaceId) return 'hide';
  }
  return 'nudge';
}

export function behaviorFor(presentation: Presentation): NotificationBehavior {
  return {
    shouldShowBanner: presentation !== 'hide',
    shouldShowList: presentation === 'show',
    shouldPlaySound: presentation !== 'hide',
    shouldSetBadge: false,
  };
}

/**
 * Whether to post a local notification for a new inbox item. Only while the
 * app is in the background (the socket may still be up for a while, which is
 * the only way an Android phone without Google Play services hears from the
 * Mac). On iOS, skip it when the Mac's relay holds this phone's APNs token:
 * the relay pushes the same item and two banners would show.
 */
export function shouldPostLocal(input: {
  os: string;
  appActive: boolean;
  permission: Permission;
  relayPushes: boolean;
}): boolean {
  if (input.os !== 'ios' && input.os !== 'android') return false;
  if (input.appActive || input.permission !== 'granted') return false;
  return !(input.os === 'ios' && input.relayPushes);
}
