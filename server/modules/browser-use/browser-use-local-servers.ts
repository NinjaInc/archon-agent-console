import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** A TCP server this user has running on the machine, as the Browser "Preview" list shows it. */
export type LocalServer = {
  port: number;
  /** The address to open: loopback for wildcard/loopback listeners, the bound address otherwise. */
  host: string;
  process: string;
  pid: number | null;
};

const run = promisify(execFile);
// Dev servers live on ordinary ports; the high range is where programs park internal helper listeners.
const MIN_PORT = 1024;
const MAX_PORT = 32767;
// Programs that listen locally for their own purposes, not something to preview.
const IGNORED_PROCESSES = new Set(['agy', 'claude', 'cloudflared', 'sshd', 'systemd', 'chrome', 'chromium']);

/**
 * Reads `ss -H -ltnp` output. Only listeners that show a process (this user's own; ss hides other users')
 * on a non-privileged, non-ephemeral port are returned, minus the console itself.
 */
export function parseListeningServers(output: string, ownPort: number): LocalServer[] {
  const byPort = new Map<number, LocalServer>();
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6 || columns[0] !== 'LISTEN') continue;
    const local = columns[3];
    const separator = local.lastIndexOf(':');
    if (separator < 0) continue;
    const port = Number(local.slice(separator + 1));
    const address = local.slice(0, separator).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const processColumn = columns.slice(5).join(' ');
    const name = /\(\("([^"]+)"/.exec(processColumn)?.[1];
    if (!name || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT || port === ownPort) continue;
    if (IGNORED_PROCESSES.has(name.split('-')[0])) continue;
    const wildcard = address === '*' || address === '0.0.0.0' || address === '::';
    const host = wildcard || address === '127.0.0.1' || address === '::1' ? '127.0.0.1' : address;
    if (!byPort.has(port)) {
      byPort.set(port, { port, host, process: name, pid: Number(/pid=(\d+)/.exec(processColumn)?.[1]) || null });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Servers this user is running right now (dev servers, preview servers, APIs). */
export async function listLocalServers(ownPort: number): Promise<LocalServer[]> {
  try {
    const { stdout } = await run('ss', ['-H', '-ltnp'], { timeout: 5_000 });
    return parseListeningServers(stdout, ownPort);
  } catch {
    // `ss` missing or failing just means no suggestions; the URL box still works.
    return [];
  }
}
