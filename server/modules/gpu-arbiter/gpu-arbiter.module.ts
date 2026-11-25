/**
 * Composition root for the GPU arbiter: one lease database shared by the console (and later the nightly runner).
 * Author: Josh Neufield (Archon Tech)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPrivateHost } from '@/shared/utils.js';

import { createDesktopCheck } from './gpu-arbiter.desktop.js';
import { createGpuArbiter, type GpuArbiter } from './gpu-arbiter.service.js';

function desktopUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'http:' && !url.username && !url.password && isPrivateHost(url.hostname)) return url.toString();
  } catch {
    // reported below
  }
  console.warn('[gpu] GPU_STATUS_URL ignored: it must be an http address on a private network');
  return null;
}

let shared: GpuArbiter | null = null;

/**
 * The one arbiter, created on first use so importing this module touches no files.
 * Used by server/index.ts to hand the arbiter to the ComfyUI module.
 */
export function getGpuArbiter(env: NodeJS.ProcessEnv = process.env): GpuArbiter {
  if (!shared) {
    const directory = path.join(os.homedir(), '.local', 'share', 'archon-agent-console');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    shared = createGpuArbiter({ path: path.join(directory, 'gpu-lease.db'), external: createDesktopCheck(desktopUrl(env.GPU_STATUS_URL)) });
  }
  return shared;
}
