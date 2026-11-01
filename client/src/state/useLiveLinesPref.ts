import { useEffect } from 'react';

import type { TerminalSession } from '../session/terminalSession';
import { usePrefs } from './prefs';

/**
 * Keeps `session`'s live rows equal to the 终端历史行数 preference, so a
 * change in settings takes effect without reconnecting. Mount it where the
 * session lives for the whole connection (the tabs layout), not on a screen
 * that may unmount.
 */
export function useLiveLinesPref(session: TerminalSession): void {
  const { historyLines } = usePrefs();
  useEffect(() => {
    session.setLiveLines(historyLines);
  }, [session, historyLines]);
}
