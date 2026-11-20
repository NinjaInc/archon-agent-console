/**
 * Settings for the optional "Local (Ollama)" backend, read once from the environment.
 * Author: Josh Neufield (Archon Tech)
 *
 * Nothing here is hardcoded to a machine: the address comes from OLLAMA_BASE_URL. The address must be on this
 * machine or a private network (the local model is LAN-only by design), so a typo or a malicious value can never
 * point the server at a public host. A bad value never stops the console from starting; the backend just reports
 * the problem and stays off.
 */

export type OllamaApi = 'native' | 'openai';

export type OllamaConfig = {
  /** Origin of the Ollama server with no trailing slash, e.g. http://127.0.0.1:11434 */
  baseUrl: string;
  /** True when OLLAMA_BASE_URL is set (or OLLAMA_ENABLED=true). The tab stays hidden otherwise. */
  configured: boolean;
  /** Why the settings were refused, if they were. The backend stays off while this is set. */
  problem?: string;
  model: string;
  /** How long to wait for the FIRST token. Long on purpose: a cold start loads the model into VRAM. */
  timeoutMs: number;
  /** Once tokens are flowing, how long a silence is tolerated before the reply is cut off. */
  idleTimeoutMs: number;
  /** Context window requested for every call. Never above MAX_NUM_CTX and never offered as a choice in the UI. */
  numCtx: number;
  /** How long Ollama keeps the model in VRAM after the last call. Short, so the GPU is free for other things. */
  keepAlive: string;
  /** native = /api/chat (honours num_ctx and think per request). openai = /v1/chat/completions (SSE; cannot pin num_ctx). */
  api: OllamaApi;
  healthIntervalMs: number;
};

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = 'qwen3:8b';
export const DEFAULT_NUM_CTX = 8192;
export const MIN_NUM_CTX = 2048;
/** Hard ceiling for OLLAMA_NUM_CTX. 32k on an 8 GB card starves the rest of the desktop, so it is not reachable. */
export const MAX_NUM_CTX = 16384;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const HEALTH_INTERVAL_MS = 30_000;

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/;
const KEEP_ALIVE = /^(0|\d{1,4}[smh])$/;

function integerInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** True for loopback, RFC 1918, link-local and unique-local addresses, and plain LAN host names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((part) => part > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  // A name with no dots (a LAN machine name) or an obviously local suffix. Public DNS names are refused.
  return !host.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

export function loadOllamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const rawUrl = (env.OLLAMA_BASE_URL ?? '').trim();
  const configured = rawUrl !== '' || env.OLLAMA_ENABLED === 'true';

  const config: OllamaConfig = {
    baseUrl: DEFAULT_BASE_URL,
    configured,
    model: DEFAULT_MODEL,
    timeoutMs: integerInRange(env.OLLAMA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 10_000, 600_000),
    idleTimeoutMs: integerInRange(env.OLLAMA_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, 5_000, 300_000),
    numCtx: integerInRange(env.OLLAMA_NUM_CTX, DEFAULT_NUM_CTX, MIN_NUM_CTX, MAX_NUM_CTX),
    keepAlive: KEEP_ALIVE.test((env.OLLAMA_KEEP_ALIVE ?? '').trim()) ? (env.OLLAMA_KEEP_ALIVE as string).trim() : '5m',
    api: env.OLLAMA_API === 'openai' ? 'openai' : 'native',
    healthIntervalMs: HEALTH_INTERVAL_MS,
  };

  const model = (env.OLLAMA_MODEL ?? '').trim();
  if (model !== '') {
    if (MODEL_NAME.test(model)) config.model = model;
    else config.problem = 'OLLAMA_MODEL is not a valid model name';
  }

  if (rawUrl !== '') {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') config.problem = 'OLLAMA_BASE_URL must start with http:// or https://';
      else if (url.username || url.password) config.problem = 'OLLAMA_BASE_URL must not contain a user name or password';
      else if (!isPrivateHost(url.hostname)) config.problem = 'OLLAMA_BASE_URL must be on this machine or a private network (the local model is LAN-only)';
      else config.baseUrl = url.origin;
    } catch {
      config.problem = 'OLLAMA_BASE_URL is not a valid URL';
    }
  }

  return config;
}
