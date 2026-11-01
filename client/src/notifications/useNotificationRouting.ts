import { usePathname } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { useAppState } from '../state/hooks';
import type { NotificationState } from './controller';
import { notifications } from './instance';

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
