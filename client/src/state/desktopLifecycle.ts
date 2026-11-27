/**
 * Moments when the desktop window should check its connections: it was shown
 * or focused again, the network came back, or the process was not running for
 * a while (the Mac slept, or WebKit suspended the page). The phone gets the
 * first ones from `AppState`; a desktop window that is merely hidden stays
 * "active" there, and nothing reports a system wake to the page at all.
 */
export type WakeReason = 'focus' | 'visible' | 'online' | 'resume';

type Listener = (event: unknown) => void;
type EventSource = {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
};
type DocumentLike = EventSource & { readonly visibilityState?: string };

export type DesktopLifecycleOptions = {
  onWake(reason: WakeReason): void;
  /** The window was hidden (⌘W, minimized) or shown again. */
  onHidden?(hidden: boolean): void;
  window?: EventSource | null;
  document?: DocumentLike | null;
  /** How often the clock is checked for a gap. */
  tickMs?: number;
  /** A tick this much later than due means the process was not running. */
  gapMs?: number;
  /** Bursts (focus and visibilitychange together) wake once. */
  minIntervalMs?: number;
  now?: () => number;
};

export function watchDesktopLifecycle(options: DesktopLifecycleOptions): () => void {
  const target = options.window === undefined ? (typeof window === 'undefined' ? null : window) : options.window;
  const page = options.document === undefined ? (typeof document === 'undefined' ? null : document) : options.document;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 10_000;
  const gapMs = options.gapMs ?? 30_000;
  const minIntervalMs = options.minIntervalMs ?? 1_500;
  let lastWake = -Infinity;
  let hidden = page?.visibilityState === 'hidden';
  const wake = (reason: WakeReason) => {
    const at = now();
    // A resume always gets through: it is the one that finds dead sockets.
    if (reason !== 'resume' && at - lastWake < minIntervalMs) return;
    lastWake = at;
    options.onWake(reason);
  };
  const onFocus = () => wake('focus');
  const onOnline = () => wake('online');
  const onVisibility = () => {
    const nowHidden = page?.visibilityState === 'hidden';
    if (nowHidden !== hidden) {
      hidden = nowHidden;
      options.onHidden?.(nowHidden);
    }
    if (!nowHidden) wake('visible');
  };
  const listen = (source: EventSource | null, type: string, listener: Listener) => {
    if (typeof source?.addEventListener === 'function') source.addEventListener(type, listener);
  };
  const unlisten = (source: EventSource | null, type: string, listener: Listener) => {
    if (typeof source?.removeEventListener === 'function') source.removeEventListener(type, listener);
  };
  listen(target, 'focus', onFocus);
  listen(target, 'online', onOnline);
  listen(target, 'pageshow', onVisibility);
  listen(page, 'visibilitychange', onVisibility);
  let expected = now() + tickMs;
  const timer = setInterval(() => {
    const at = now();
    const late = at - expected;
    expected = at + tickMs;
    if (late >= gapMs) wake('resume');
  }, tickMs);
  return () => {
    clearInterval(timer);
    unlisten(target, 'focus', onFocus);
    unlisten(target, 'online', onOnline);
    unlisten(target, 'pageshow', onVisibility);
    unlisten(page, 'visibilitychange', onVisibility);
  };
}
