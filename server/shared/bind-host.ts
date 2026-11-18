/**
 * Bind-host policy for Archon Agent Console.
 *
 * Author: Josh Neufield (Archon Tech)
 *
 * Default: loopback only. A single private (RFC 1918) IPv4 address that belongs to this
 * machine is allowed only when ALLOW_LAN_BIND=true is set on purpose. Wildcards
 * (0.0.0.0, ::), hostnames and public addresses are always refused.
 */
import os from 'node:os';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export type BindHostDecision = { ok: true; lan: boolean } | { ok: false; reason: string };

export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function localIPv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === 'IPv4')
    .map((i) => i.address);
}

export function evaluateBindHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
  localAddresses: () => string[] = localIPv4Addresses,
): BindHostDecision {
  if (LOOPBACK_HOSTS.has(host)) return { ok: true, lan: false };
  if (!isPrivateIPv4(host)) {
    return { ok: false, reason: `HOST=${host} is not loopback or a private LAN IPv4 address (wildcards and public addresses are never allowed).` };
  }
  if (env.ALLOW_LAN_BIND !== 'true') {
    return { ok: false, reason: `HOST=${host} is a LAN address; set ALLOW_LAN_BIND=true to confirm you want the console reachable on the LAN.` };
  }
  if (!localAddresses().includes(host)) {
    return { ok: false, reason: `HOST=${host} is not an address of this machine.` };
  }
  return { ok: true, lan: true };
}
