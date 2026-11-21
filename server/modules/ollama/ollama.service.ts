/**
 * Talks to an Ollama server on the LAN: health, model list, warm-up and streamed chat.
 * Author: Josh Neufield (Archon Tech)
 *
 * Design rules:
 *  - No tools are ever sent. The request body is built in one place (buildChatRequest) and has no `tools` field.
 *  - Two timeouts. Until the first token the long OLLAMA_TIMEOUT_MS applies (a cold start loads the model into
 *    VRAM); once tokens flow, a short idle timeout cuts off a stalled reply. Neither can hang a request.
 *  - Nothing is buffered: each token is handed to `emit` the moment it is parsed.
 *  - "Offline" is a normal, quick answer (cached health plus a 2 s live probe), never a hang.
 *  - Errors say what to do: model not installed, GPU out of memory, timeout, offline.
 */
import { AppError } from '@/shared/utils.js';

import type { OllamaConfig } from './ollama.config.js';

export const MAX_OUTPUT_TOKENS = 2048;
const MAX_ACTIVE_STREAMS = 2;
const PROBE_TIMEOUT_MS = 2_000;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type OllamaErrorCode =
  | 'OLLAMA_OFFLINE'
  | 'OLLAMA_TIMEOUT'
  | 'OLLAMA_MODEL_MISSING'
  | 'OLLAMA_OUT_OF_MEMORY'
  | 'OLLAMA_BUSY'
  | 'OLLAMA_NOT_CONFIGURED'
  | 'OLLAMA_UPSTREAM';

export class OllamaError extends AppError {
  constructor(code: OllamaErrorCode, message: string, statusCode: number) {
    super(message, { code, statusCode });
    this.name = 'OllamaError';
  }
}

/** One normalised event streamed to the browser. */
export type OllamaEvent =
  | { type: 'meta'; task?: string; included?: string[]; excluded?: { path: string; reason: string }[]; draft: true }
  | { type: 'status'; state: 'loading' | 'generating'; message?: string }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; tokensPerSecond?: number }
  | { type: 'error'; code: OllamaErrorCode; message: string }
  | { type: 'done' };

export type ModelInfo = { name: string; sizeBytes?: number; parameterSize?: string };

export type HealthState = {
  status: 'unknown' | 'online' | 'offline';
  models: ModelInfo[];
  checkedAt: number | null;
  error?: string;
};

export type StreamRequest = {
  model?: string;
  messages: ChatMessage[];
  think?: boolean;
  /** Sent as the first event, but only once the pre-checks pass, so offline / not installed / busy can still be a plain HTTP error. */
  preamble?: OllamaEvent;
};

/** The one place a chat request body is built. It never contains `tools`, and always pins the context window. */
export function buildChatRequest(config: OllamaConfig, request: { model: string; messages: ChatMessage[]; think: boolean }): { path: string; body: Record<string, unknown> } {
  if (config.api === 'openai') {
    return {
      path: '/v1/chat/completions',
      body: {
        model: request.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        // /v1 cannot set num_ctx (Ollama ignores it there); `reasoning_effort: none` is how thinking is switched off.
        ...(request.think ? {} : { reasoning_effort: 'none' }),
      },
    };
  }
  return {
    path: '/api/chat',
    body: {
      model: request.model,
      messages: request.messages,
      stream: true,
      think: request.think,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.numCtx, num_predict: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    },
  };
}

/** Maps an error from Ollama (HTTP status and body text, or an in-stream error) to a code and an actionable message. */
export function classifyUpstreamError(status: number, text: string, model: string): { code: OllamaErrorCode; message: string; statusCode: number } {
  const body = text.slice(0, 400);
  if (status === 404 || /model .*not found|try pulling it first|pull model manifest/i.test(body)) {
    return { code: 'OLLAMA_MODEL_MISSING', statusCode: 404, message: `The model "${model}" is not installed on the Ollama host. Install it there with: ollama pull ${model}` };
  }
  if (/out of memory|cuda.*(memory|alloc)|cudamalloc|insufficient (?:gpu |video )?memory|requires more (?:system )?memory|failed to allocate|unable to allocate/i.test(body)) {
    return { code: 'OLLAMA_OUT_OF_MEMORY', statusCode: 507, message: `The GPU ran out of memory loading "${model}". Close other GPU-heavy programs (games) on the Ollama host, or pick a smaller model, then try again.` };
  }
  if (/does not support thinking/i.test(body)) {
    return { code: 'OLLAMA_UPSTREAM', statusCode: 400, message: `"${model}" does not support thinking. Turn Thinking off for this model.` };
  }
  return { code: 'OLLAMA_UPSTREAM', statusCode: 502, message: `Ollama returned an error${status ? ` (${status})` : ''}: ${body.replace(/\s+/g, ' ').trim() || 'no details'}` };
}

/** One NDJSON line from the native /api/chat stream. */
export function parseNativeLine(line: string, model: string): OllamaEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let data: Record<string, any>;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (data.error) {
    const mapped = classifyUpstreamError(0, String(data.error), model);
    return [{ type: 'error', code: mapped.code, message: mapped.message }];
  }
  const events: OllamaEvent[] = [];
  if (typeof data.message?.thinking === 'string' && data.message.thinking) events.push({ type: 'reasoning', text: data.message.thinking });
  if (typeof data.message?.content === 'string' && data.message.content) events.push({ type: 'text', text: data.message.content });
  if (data.done) {
    const out = Number(data.eval_count ?? 0);
    const nanos = Number(data.eval_duration ?? 0);
    events.push({ type: 'usage', inputTokens: Number(data.prompt_eval_count ?? 0), outputTokens: out, tokensPerSecond: nanos > 0 ? Math.round((out / (nanos / 1e9)) * 10) / 10 : undefined });
  }
  return events;
}

/** One line from the OpenAI-compatible /v1 SSE stream. */
export function parseOpenAiLine(line: string, model: string): OllamaEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return [];
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return [];
  let data: Record<string, any>;
  try {
    data = JSON.parse(payload);
  } catch {
    return [];
  }
  if (data.error) {
    const mapped = classifyUpstreamError(0, typeof data.error === 'string' ? data.error : String(data.error.message ?? ''), model);
    return [{ type: 'error', code: mapped.code, message: mapped.message }];
  }
  const events: OllamaEvent[] = [];
  const delta = data.choices?.[0]?.delta;
  if (typeof delta?.reasoning === 'string' && delta.reasoning) events.push({ type: 'reasoning', text: delta.reasoning });
  if (typeof delta?.content === 'string' && delta.content) events.push({ type: 'text', text: delta.content });
  if (data.usage) events.push({ type: 'usage', inputTokens: Number(data.usage.prompt_tokens ?? 0), outputTokens: Number(data.usage.completion_tokens ?? 0) });
  return events;
}

export type OllamaServiceDependencies = {
  config: OllamaConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Receives short log lines; never message text. */
  audit?: (message: string) => void;
};

export function createOllamaService({ config, fetchImpl = fetch, now = Date.now, audit }: OllamaServiceDependencies) {
  let health: HealthState = { status: 'unknown', models: [], checkedAt: null };
  let checking: Promise<HealthState> | null = null;
  let active = 0;

  const url = (path: string) => `${config.baseUrl}${path}`;
  const offline = () => new OllamaError('OLLAMA_OFFLINE', 'Local LLM offline', 503);

  function markOffline(reason: string): void {
    if (health.status !== 'offline') audit?.(`local model is offline (${reason})`);
    health = { status: 'offline', models: [], checkedAt: now(), error: reason };
  }

  /** Asks /api/tags. Always resolves; the result is also remembered as the current health. */
  function checkHealth(): Promise<HealthState> {
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await fetchImpl(url('/api/tags'), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { models?: Array<{ name?: string; size?: number; details?: { parameter_size?: string } }> };
        const models = (data.models ?? []).filter((entry) => typeof entry.name === 'string').map((entry) => ({ name: entry.name as string, sizeBytes: entry.size, parameterSize: entry.details?.parameter_size }));
        if (health.status === 'offline') audit?.('local model is back online');
        health = { status: 'online', models, checkedAt: now() };
      } catch (error) {
        markOffline(error instanceof Error ? error.name === 'TimeoutError' ? 'timed out' : error.message : 'unreachable');
      } finally {
        checking = null;
      }
      return health;
    })();
    return checking;
  }

  /** Throws "Local LLM offline" quickly when the host cannot be reached. Uses the recent result when it is fresh. */
  async function ensureOnline(): Promise<void> {
    const fresh = health.status === 'online' && health.checkedAt !== null && now() - health.checkedAt < config.healthIntervalMs;
    if (!fresh) await checkHealth();
    if (health.status !== 'online') throw offline();
  }

  /** Names of the models currently loaded in VRAM, or null when that cannot be read. */
  async function loadedModels(): Promise<string[] | null> {
    try {
      const response = await fetchImpl(url('/api/ps'), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((entry) => entry.name ?? '').filter(Boolean);
    } catch {
      return null;
    }
  }

  function resolveModel(requested: string | undefined): string {
    const model = requested && requested.trim() ? requested.trim() : config.model;
    if (health.models.length > 0 && !health.models.some((entry) => entry.name === model)) {
      throw new OllamaError('OLLAMA_MODEL_MISSING', `The model "${model}" is not installed on the Ollama host. Install it there with: ollama pull ${model}`, 404);
    }
    return model;
  }

  /** Loads the model into VRAM with the same context window chat will use, so the first real message is fast and does not trigger a reload. */
  async function warmUp(requested?: string): Promise<{ model: string; alreadyLoaded: boolean; seconds: number }> {
    await ensureOnline();
    const model = resolveModel(requested);
    const loaded = await loadedModels();
    const started = now();
    // An empty prompt only loads the model. keep_alive and num_ctx match streamChat's, so the runner is reused.
    const response = await fetchImpl(url('/api/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: config.keepAlive, options: { num_ctx: config.numCtx } }),
      signal: AbortSignal.timeout(config.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') throw new OllamaError('OLLAMA_TIMEOUT', `The model did not load within ${Math.round(config.timeoutMs / 1000)}s.`, 504);
      markOffline(error instanceof Error ? error.message : 'unreachable');
      throw offline();
    });
    if (!response.ok) {
      const mapped = classifyUpstreamError(response.status, await response.text().catch(() => ''), model);
      throw new OllamaError(mapped.code, mapped.message, mapped.statusCode);
    }
    return { model, alreadyLoaded: Boolean(loaded?.includes(model)), seconds: Math.round(((now() - started) / 1000) * 10) / 10 };
  }

  /**
   * Streams one chat turn. Failures that happen before anything is sent (offline, model not installed, too many
   * streams) are thrown, so the route can answer with a normal error. Failures after that arrive as an `error` event.
   */
  async function streamChat(request: StreamRequest, emit: (event: OllamaEvent) => void, clientSignal?: AbortSignal): Promise<void> {
    await ensureOnline();
    const model = resolveModel(request.model);
    if (active >= MAX_ACTIVE_STREAMS) throw new OllamaError('OLLAMA_BUSY', 'The local model is already answering other requests. Try again in a moment.', 429);
    active += 1;
    if (request.preamble) emit(request.preamble);

    const controller = new AbortController();
    let stoppedBy: 'client' | 'first-token' | 'idle' | null = null;
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, why: 'first-token' | 'idle') => {
      clearTimeout(timer);
      timer = setTimeout(() => { stoppedBy = why; controller.abort(); }, ms);
    };
    const onClientAbort = () => { stoppedBy = 'client'; controller.abort(); };
    if (clientSignal?.aborted) onClientAbort();
    clientSignal?.addEventListener('abort', onClientAbort, { once: true });

    let sawToken = false;
    try {
      const loaded = await loadedModels();
      if (loaded && !loaded.includes(model)) emit({ type: 'status', state: 'loading', message: 'Loading the model into the GPU. The first reply can take up to a minute.' });

      const { path, body } = buildChatRequest(config, { model, messages: request.messages, think: request.think === true });
      arm(config.timeoutMs, 'first-token');
      const response = await fetchImpl(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok || !response.body) {
        const mapped = classifyUpstreamError(response.status, await response.text().catch(() => ''), model);
        throw new OllamaError(mapped.code, mapped.message, mapped.statusCode);
      }

      const parse = config.api === 'openai' ? parseOpenAiLine : parseNativeLine;
      const decoder = new TextDecoder();
      let pending = '';
      const handle = (line: string) => {
        for (const event of parse(line, model)) {
          if (event.type === 'text' || event.type === 'reasoning') {
            if (!sawToken) {
              sawToken = true;
              emit({ type: 'status', state: 'generating' });
            }
          }
          emit(event);
        }
      };
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          handle(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        // Tokens are flowing: from here only silence counts, and only the short idle timeout applies.
        if (sawToken) arm(config.idleTimeoutMs, 'idle');
      }
      handle(pending + decoder.decode());
    } catch (error) {
      if (stoppedBy === 'client') return;
      if (stoppedBy === 'first-token') {
        emit({ type: 'error', code: 'OLLAMA_TIMEOUT', message: `No reply within ${Math.round(config.timeoutMs / 1000)}s. The model may still be loading or the GPU may be busy. Try again in a moment.` });
      } else if (stoppedBy === 'idle') {
        emit({ type: 'error', code: 'OLLAMA_TIMEOUT', message: `The model stopped responding (no output for ${Math.round(config.idleTimeoutMs / 1000)}s), so the reply was cut off.` });
      } else if (error instanceof OllamaError) {
        emit({ type: 'error', code: error.code as OllamaErrorCode, message: error.message });
      } else {
        markOffline(error instanceof Error ? error.message : 'unreachable');
        emit({ type: 'error', code: 'OLLAMA_OFFLINE', message: 'Local LLM offline' });
      }
    } finally {
      clearTimeout(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
      active -= 1;
      if (stoppedBy !== 'client') emit({ type: 'done' });
    }
  }

  function getStatus() {
    return {
      configured: config.configured && !config.problem,
      problem: config.problem,
      status: health.status,
      checkedAt: health.checkedAt,
      error: health.error,
      model: config.model,
      models: health.models,
      api: config.api,
      numCtx: config.numCtx,
    };
  }

  /** Checks health now and then every healthIntervalMs. The timer never keeps the process alive. Returns a stop function. */
  function startHealthPolling(): () => void {
    void checkHealth();
    const interval = setInterval(() => void checkHealth(), config.healthIntervalMs);
    interval.unref();
    return () => clearInterval(interval);
  }

  return { checkHealth, ensureOnline, getStatus, getHealth: () => health, warmUp, streamChat, startHealthPolling, activeStreams: () => active };
}

export type OllamaService = ReturnType<typeof createOllamaService>;
