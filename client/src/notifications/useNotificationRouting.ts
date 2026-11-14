import { router, usePathname } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { useAppState } from '../state/hooks';
import type { NotificationState } from './controller';
import { notifications } from './instance';
import { desktopBridge } from '../platform/desktop';
import { appStore } from '../state/appStore';
import { openSurface } from '../state/navigation';
import { watchDesktopNotifications } from './desktop';

/**
 * Mounted once in the root layout. Sets the foreground presentation policy,
 * registers the APNs token with the paired computers (iOS), posts local
 * notifications for new inbox items while in the background, and opens the
 * terminal a tapped notification points at.
 */
export function useNotificationRouting(): void {
  const pathname = usePathname();
  const { phase, machine } = useAppState();
  useEffect(() => {
    const bridge = desktopBridge();
    if (machine && bridge) return watchDesktopNotifications(machine, bridge);
  }, [machine]);
  useEffect(() => desktopBridge()?.onNotification?.(notification => {
    void (async () => {
      if (notification.computerId) await appStore.select(notification.computerId);
      const current = appStore.getState().machine;
      if (!current || (notification.computerId && current.computer?.id !== notification.computerId)) return;
      if (notification.notificationId) current.inbox.markRead(notification.notificationId);
      if (notification.sourceId && notification.threadId) router.navigate({ pathname: '/sources', params: { sourceId: notification.sourceId, threadId: notification.threadId } });
      else if (notification.workspaceId && notification.surfaceId) openSurface(current, notification.workspaceId, notification.surfaceId);
      else router.navigate('/inbox');
    })().catch(() => router.navigate('/inbox'));
  }), []);

  useEffect(() => {
    notifications.start();
    return () => notifications.stop();
  }, []);

  useEffect(() => {
    notifications.setRoute(pathname);
  }, [pathname]);

  // Runs after the render that mounted the tabs (or switched computers), so navigating is safe.
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setTimeout(() => notifications.flushTap(), 0);
    return () => clearTimeout(timer);
  }, [phase, machine]);
}

/** Permission, token and registration state, for 设置 → 通知. */
export function useNotificationState(): NotificationState {
  return useSyncExternalStore(notifications.subscribe, notifications.getState, notifications.getState);
}
