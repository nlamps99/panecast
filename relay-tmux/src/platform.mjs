import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The local endpoint that hooks and `panecast start` use to reach a running
 * relay: a Unix socket in its state directory, or on Windows (where Node cannot
 * listen on Unix sockets) a named pipe derived from that directory.
 */
export function notifySocketPath(config = {}, fallbackDirectory = join(homedir(), '.cmuxremote', 'hub'), platform = process.platform) {
  if (config.notify_socket) return config.notify_socket;
  const directory = config.state_directory ?? fallbackDirectory;
  if (platform !== 'win32') return join(directory, 'notify.sock');
  const key = createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\panecast-${key}`;
}

export const isNamedPipe = (path) => /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(String(path));
