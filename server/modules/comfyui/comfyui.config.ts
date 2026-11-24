/**
 * Settings for the ComfyUI image client, read once from the environment.
 * Author: Josh Neufield (Archon Tech)
 *
 * ComfyUI runs on this machine or on the desktop GPU host on the private LAN. COMFYUI_BASE_URL may never point at a
 * public address: prompts and generated images stay on the private network. A bad value never stops the console from
 * starting; `problem` records why it was refused and `baseUrl` stays on the safe loopback default.
 */
import os from 'node:os';
import path from 'node:path';

import { isPrivateHost } from '@/shared/utils.js';

const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_IMAGES_DIR = path.join(os.homedir(), '.local', 'share', 'archon-agent-console', 'images');
const DEFAULT_CHECKPOINT = 'sd_xl_base_1.0.safetensors';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_TIMEOUT_MS = 3_000;

const CHECKPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/;

/**
 * Configuration for the ComfyUI client and local image store.
 * Consumed by comfyui.service.ts, comfyui.module.ts, index.ts, and the module's tests.
 */
export type ComfyuiConfig = {
  /** Origin of the ComfyUI server with no trailing slash, e.g. http://127.0.0.1:8188. */
  baseUrl: string;
  /** True when COMFYUI_BASE_URL was provided and accepted. */
  configured: boolean;
  /** Why the settings were refused, if they were. Image generation stays off while set. */
  problem?: string;
  /** Directory outside the repository where generated PNG files are stored by random id. */
  imagesDir: string;
  /** Checkpoint model filename substituted into the server-side txt2img workflow template. */
  checkpoint?: string;
  /** Overall timeout (ms) for a generation job before aborting and interrupting ComfyUI. */
  timeoutMs?: number;
  /** Interval (ms) at which the GPU lease heartbeat is renewed while waiting on ComfyUI. */
  heartbeatIntervalMs?: number;
  /** Delay (ms) between GET /history/{id} polls. */
  pollIntervalMs?: number;
  /** Timeout (ms) for GET /system_stats health checks. */
  statusTimeoutMs?: number;
};

function resolveImagesDir(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_IMAGES_DIR;
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

/**
 * Reads COMFYUI_BASE_URL (and optional COMFYUI_IMAGES_DIR / COMFYUI_CHECKPOINT) without ever throwing.
 * Used by comfyui.module.ts at startup and by tests/comfyui.config.test.ts to verify private-host validation.
 */
export function loadComfyuiConfig(env: NodeJS.ProcessEnv = process.env): ComfyuiConfig {
  const config: ComfyuiConfig = {
    baseUrl: DEFAULT_COMFYUI_BASE_URL,
    configured: false,
    imagesDir: resolveImagesDir(env.COMFYUI_IMAGES_DIR),
    checkpoint: DEFAULT_CHECKPOINT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    statusTimeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
  };

  const checkpoint = (env.COMFYUI_CHECKPOINT ?? '').trim();
  if (checkpoint !== '') {
    if (CHECKPOINT_NAME.test(checkpoint) && !checkpoint.includes('..')) {
      config.checkpoint = checkpoint;
    } else {
      config.problem = 'COMFYUI_CHECKPOINT is not a valid checkpoint filename';
    }
  }

  const raw = (env.COMFYUI_BASE_URL ?? '').trim();
  if (raw !== '') {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        config.problem = 'COMFYUI_BASE_URL must start with http:// or https://';
      } else if (url.username || url.password) {
        config.problem = 'COMFYUI_BASE_URL must not contain a user name or password';
      } else if (!isPrivateHost(url.hostname)) {
        config.problem = 'COMFYUI_BASE_URL must be on this machine or a private network';
      } else if (!config.problem) {
        config.baseUrl = url.origin;
        config.configured = true;
      }
    } catch {
      config.problem = 'COMFYUI_BASE_URL is not a valid URL';
    }
  }

  return config;
}
