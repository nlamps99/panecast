import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { demoChannel } from '../demo/demoChannel';
import { TerminalSession } from '../session/terminalSession';
import { TerminalScreen } from '../ui/TerminalScreen';

/** The terminal screen against a pretend Mac. No pairing needed. */
export default function DemoRoute() {
  const [channel] = useState(demoChannel);
  const [session] = useState(() => new TerminalSession(channel));

  // Stop the demo subscription when leaving; the session itself is cheap.
  useEffect(() => () => session.setTarget(null), [session]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/pair');
  };

  return <TerminalScreen channel={channel} session={session} demo leaveLabel="退出演示" onLeave={leave} />;
}
