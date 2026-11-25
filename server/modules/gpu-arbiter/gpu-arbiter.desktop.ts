/**
 * Reads the desktop GPU status service (scripts/desktop/gpu-status.py) and decides whether something else owns the GPU.
 * Author: Josh Neufield (Archon Tech)
 */
import type { ExternalCheck } from './gpu-arbiter.service.js';

const MAX_OTHER_VRAM_MB = 1024;
const LAUNCHER_UTILISATION_PERCENT = 5;

type DesktopStatus = {
  gpu?: { utilization_percent?: unknown } | null;
  games_running?: unknown;
  launchers_running?: unknown;
  non_ours_vram_mb?: unknown;
};

/**
 * True/false from the facts the desktop reports, or null when they are incomplete (treated as "cannot tell").
 * A listed game, or more than 1 GB of VRAM held by other programs, is busy; a launcher counts only while the GPU is working.
 * Used by createDesktopCheck and tests/gpu-arbiter.desktop.test.ts.
 */
export function judgeDesktop(status: DesktopStatus): boolean | null {
  if (Array.isArray(status.games_running) && status.games_running.length > 0) return true;
  if (typeof status.non_ours_vram_mb === 'number' && status.non_ours_vram_mb > MAX_OTHER_VRAM_MB) return true;
  const utilisation = status.gpu?.utilization_percent;
  if (!Array.isArray(status.games_running) || !Array.isArray(status.launchers_running)) return null;
  if (typeof status.non_ours_vram_mb !== 'number' || typeof utilisation !== 'number') return null;
  return status.launchers_running.length > 0 && utilisation > LAUNCHER_UTILISATION_PERCENT;
}

/**
 * The arbiter's external check. With no URL, or when the service cannot answer, it returns null.
 * Used by gpu-arbiter.module.ts and tests/gpu-arbiter.desktop.test.ts.
 */
export function createDesktopCheck(url: string | null, fetchImpl: typeof fetch = fetch): ExternalCheck {
  return async () => {
    if (!url) return null;
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return null;
      const externalBusy = judgeDesktop((await response.json()) as DesktopStatus);
      return externalBusy === null ? null : { externalBusy };
    } catch {
      return null;
    }
  };
}
