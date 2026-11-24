/**
 * ComfyUI image generation service: validates prompts, coordinates GPU leases and Ollama unload, runs a fixed
 * server-side txt2img workflow, and stores resulting PNGs outside the repository under random 16-hex identifiers.
 * Author: Josh Neufield (Archon Tech)
 *
 * Design rules:
 *  - Workflows are never accepted from the client: only validated prompt, negative prompt, dimensions and seed are
 *    substituted into the server-owned txt2img node graph, with batch_size pinned to 1.
 *  - Prompts and negative prompts pass `findSecrets` before touching the GPU or network.
 *  - Every acquired lease is paired with a finally block that posts `/free { unload_models: true }` and releases the
 *    lease, whether generation succeeds, fails, times out, or loses its lease heartbeat.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GpuArbiter, GpuState, Lease } from '@/modules/gpu-arbiter/index.js';
import { AppError, findSecrets } from '@/shared/utils.js';

import type { ComfyuiConfig } from './comfyui.config.js';

const MAX_PROMPT_CHARS = 2_000;
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 1_024;
const DIMENSION_STEP = 64;
const DEFAULT_CHECKPOINT = 'sd_xl_base_1.0.safetensors';
const DEFAULT_GENERATE_TIMEOUT_MS = 180_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_TIMEOUT_MS = 3_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const GPU_BUSY_MESSAGE = 'The desktop GPU is busy (a game or another job)';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Exact 16-character lowercase hex identifier format required for stored images.
 * Used by comfyui.routes.ts to validate `/file/:id` params and by comfyui.service.ts before reading from disk.
 */
export const IMAGE_ID_PATTERN = /^[a-f0-9]{16}$/;

/**
 * Validated-on-arrival request parameters for a single txt2img generation job.
 * Consumed by comfyui.routes.ts, index.ts, and tests/comfyui.service.test.ts.
 */
export type GenerateImageInput = {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed?: number;
};

/**
 * Metadata returned once a generated PNG has been saved under `config.imagesDir`.
 * Consumed by comfyui.routes.ts, index.ts, and tests/comfyui.service.test.ts.
 */
export type GeneratedImage = {
  id: string;
  width: number;
  height: number;
  seed: number;
};

/**
 * Combined ComfyUI reachability and GPU arbiter snapshot for the Images status endpoint.
 * Consumed by comfyui.routes.ts, index.ts, and tests/comfyui.service.test.ts.
 */
export type ComfyuiStatus = {
  configured: boolean;
  online: boolean;
  problem?: string;
  state: GpuState;
  leases: Lease[];
};

/**
 * Dependencies required to construct the ComfyUI service.
 * Consumed by comfyui.module.ts and tests/comfyui.service.test.ts.
 */
export type ComfyuiServiceOptions = {
  config: ComfyuiConfig;
  arbiter: Pick<GpuArbiter, 'acquire' | 'heartbeat' | 'release' | 'state'>;
  unloadOllama: () => Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

type ValidatedGenerateInput = {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
};

type HistoryImageRef = {
  filename: string;
  subfolder: string;
  type: string;
};

function isValidDimension(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_DIMENSION
    && value <= MAX_DIMENSION
    && value % DIMENSION_STEP === 0
  );
}

function validateGenerateInput(input: GenerateImageInput): ValidatedGenerateInput {
  if (!input || typeof input !== 'object') {
    throw new AppError('Invalid image generation request.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }

  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0 || input.prompt.length > MAX_PROMPT_CHARS) {
    throw new AppError(
      `Prompt must be a non-empty string of at most ${MAX_PROMPT_CHARS} characters.`,
      { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 },
    );
  }

  if (input.negative !== undefined && (typeof input.negative !== 'string' || input.negative.length > MAX_PROMPT_CHARS)) {
    throw new AppError(
      `Negative prompt must be at most ${MAX_PROMPT_CHARS} characters.`,
      { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 },
    );
  }

  if (!isValidDimension(input.width) || !isValidDimension(input.height)) {
    throw new AppError(
      `Width and height must be multiples of ${DIMENSION_STEP} between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`,
      { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 },
    );
  }

  let seed: number;
  if (input.seed === undefined) {
    seed = randomInt(0, 0x1_0000_0000);
  } else if (typeof input.seed === 'number' && Number.isSafeInteger(input.seed) && input.seed >= 0) {
    seed = input.seed;
  } else {
    throw new AppError('Seed must be a non-negative integer.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }

  const negative = input.negative ?? '';
  const textToScan = negative ? `${input.prompt}\n${negative}` : input.prompt;
  const secrets = findSecrets(textToScan);
  if (secrets.length > 0) {
    throw new AppError(
      `Not generated: prompt looks like it contains ${secrets.join(' and ')}. Remove any secrets and try again.`,
      { code: 'COMFYUI_SECRETS_REFUSED', statusCode: 422 },
    );
  }

  return {
    prompt: input.prompt,
    negative,
    width: input.width,
    height: input.height,
    seed,
  };
}

/**
 * Builds the fixed txt2img ComfyUI API node graph. Values are placed into typed object fields directly (never string
 * templates), batch_size is hardcoded to 1, and no client-supplied workflow structure is ever accepted.
 */
function buildTxt2ImgWorkflow(input: ValidatedGenerateInput, checkpoint: string): Record<string, unknown> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: input.seed,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: checkpoint,
      },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: input.width,
        height: input.height,
        batch_size: 1,
      },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: input.prompt,
        clip: ['4', 1],
      },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: input.negative,
        clip: ['4', 1],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['3', 0],
        vae: ['4', 2],
      },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'archon',
        images: ['8', 0],
      },
    },
  };
}

function isPngBuffer(bytes: Buffer): boolean {
  return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function extractHistoryImage(payload: unknown, promptId: string): HistoryImageRef | null {
  if (!payload || typeof payload !== 'object') return null;
  const entry = (payload as Record<string, unknown>)[promptId];
  if (!entry || typeof entry !== 'object') return null;

  const record = entry as {
    status?: { status_str?: unknown; completed?: unknown };
    outputs?: Record<string, { images?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }> }>;
  };

  if (record.status?.status_str === 'error') {
    throw new AppError('ComfyUI reported an error while running the workflow.', {
      code: 'COMFYUI_UPSTREAM',
      statusCode: 502,
    });
  }

  const outputs = record.outputs && typeof record.outputs === 'object' ? Object.values(record.outputs) : [];
  for (const output of outputs) {
    const first = Array.isArray(output?.images) ? output.images[0] : undefined;
    if (first && typeof first.filename === 'string' && first.filename.trim() !== '') {
      return {
        filename: first.filename,
        subfolder: typeof first.subfolder === 'string' ? first.subfolder : '',
        type: typeof first.type === 'string' && first.type !== '' ? first.type : 'output',
      };
    }
  }

  if (record.status?.completed === true) {
    throw new AppError('ComfyUI finished the workflow without producing an image.', {
      code: 'COMFYUI_UPSTREAM',
      statusCode: 502,
    });
  }

  return null;
}

/**
 * Creates the ComfyUI service bound to a GPU arbiter and Ollama unload callback.
 * Used by comfyui.module.ts, index.ts, and tests/comfyui.service.test.ts.
 */
export function createComfyuiService({
  config,
  arbiter,
  unloadOllama,
  now = Date.now,
  fetchImpl = fetch,
}: ComfyuiServiceOptions) {
  const isConfigured = (): boolean => config.configured && !config.problem;

  async function postPrompt(workflow: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const response = await fetchImpl(`${config.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });
    if (!response.ok) {
      throw new AppError(`ComfyUI rejected the prompt (${response.status}).`, {
        code: 'COMFYUI_UPSTREAM',
        statusCode: 502,
      });
    }
    const data = (await response.json().catch(() => null)) as { prompt_id?: unknown } | null;
    if (!data || typeof data.prompt_id !== 'string' || data.prompt_id.trim() === '') {
      throw new AppError('ComfyUI returned no prompt_id.', {
        code: 'COMFYUI_UPSTREAM',
        statusCode: 502,
      });
    }
    return data.prompt_id;
  }

  async function fetchHistoryImage(promptId: string, signal: AbortSignal): Promise<HistoryImageRef | null> {
    const response = await fetchImpl(`${config.baseUrl}/history/${encodeURIComponent(promptId)}`, {
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      throw new AppError(`ComfyUI history check failed (${response.status}).`, {
        code: 'COMFYUI_UPSTREAM',
        statusCode: 502,
      });
    }
    const payload = await response.json().catch(() => {
      throw new AppError('ComfyUI returned invalid JSON from /history.', {
        code: 'COMFYUI_UPSTREAM',
        statusCode: 502,
      });
    });
    return extractHistoryImage(payload, promptId);
  }

  async function downloadPngView(image: HistoryImageRef, signal: AbortSignal): Promise<Buffer> {
    if (!image.filename.toLowerCase().endsWith('.png')) {
      throw new AppError('ComfyUI returned a non-PNG filename; only PNG images are accepted.', {
        code: 'COMFYUI_INVALID_IMAGE',
        statusCode: 502,
      });
    }
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const response = await fetchImpl(`${config.baseUrl}/view?${params.toString()}`, { signal });
    if (!response.ok) {
      throw new AppError(`ComfyUI image download failed (${response.status}).`, {
        code: 'COMFYUI_UPSTREAM',
        statusCode: 502,
      });
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.includes('image/png') && !contentType.includes('application/octet-stream')) {
      throw new AppError('ComfyUI returned a non-PNG content type; only PNG images are accepted.', {
        code: 'COMFYUI_INVALID_IMAGE',
        statusCode: 502,
      });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!isPngBuffer(bytes)) {
      throw new AppError('ComfyUI returned data without a valid PNG signature.', {
        code: 'COMFYUI_INVALID_IMAGE',
        statusCode: 502,
      });
    }
    return bytes;
  }

  /**
   * Validates inputs, checks secrets, takes an exclusive interactive image GPU lease, unloads Ollama, submits the
   * server-side txt2img workflow, polls history with lease heartbeats, saves the PNG, and always frees + releases.
   */
  async function generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const validated = validateGenerateInput(input);
    if (!isConfigured()) {
      throw new AppError(
        config.problem ?? 'ComfyUI is not configured on this server.',
        { code: 'COMFYUI_NOT_CONFIGURED', statusCode: 503 },
      );
    }

    const acquired = await arbiter.acquire({ holder: 'comfyui', kind: 'image', priority: 'interactive' });
    if (!acquired.ok) {
      if (acquired.reason === 'busy-external' || acquired.reason === 'held') {
        throw new AppError(GPU_BUSY_MESSAGE, { code: 'COMFYUI_GPU_BUSY', statusCode: 409 });
      }
      throw new AppError('The desktop GPU status could not be checked.', {
        code: 'COMFYUI_GPU_UNAVAILABLE',
        statusCode: 503,
      });
    }

    const { lease } = acquired;
    const timeoutMs = config.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    const heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = now();
    let lastHeartbeatAt = startedAt;
    const controller = new AbortController();
    const runState: {
      abortReason: 'timeout' | 'lease-lost' | null;
      submittedPrompt: boolean;
      promptId: string | null;
      interrupted: boolean;
    } = {
      abortReason: null,
      submittedPrompt: false,
      promptId: null,
      interrupted: false,
    };

    const sendInterrupt = async (): Promise<void> => {
      if (runState.interrupted || !runState.submittedPrompt) return;
      runState.interrupted = true;
      await fetchImpl(`${config.baseUrl}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runState.promptId ? { prompt_id: runState.promptId } : {}),
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      }).catch(() => undefined);
    };

    const runHeartbeat = (): boolean => {
      lastHeartbeatAt = now();
      if (!arbiter.heartbeat(lease.id)) {
        if (!runState.abortReason) runState.abortReason = 'lease-lost';
        controller.abort();
        return false;
      }
      return true;
    };

    const timeoutTimer = setTimeout(() => {
      if (!runState.abortReason) runState.abortReason = 'timeout';
      controller.abort();
    }, timeoutMs);
    timeoutTimer.unref();

    const heartbeatTimer = setInterval(() => {
      runHeartbeat();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();

    try {
      try {
        await unloadOllama();
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('Could not unload the local LLM before starting ComfyUI.', {
          code: 'COMFYUI_UNLOAD_FAILED',
          statusCode: 502,
        });
      }

      const workflow = buildTxt2ImgWorkflow(validated, config.checkpoint ?? DEFAULT_CHECKPOINT);
      runState.submittedPrompt = true;
      const submittedId = await postPrompt(workflow, controller.signal);
      runState.promptId = submittedId;

      let outputImage: HistoryImageRef | null = null;
      while (!outputImage) {
        if (runState.abortReason) throw new Error('aborted');
        if (now() - startedAt >= timeoutMs) {
          runState.abortReason = 'timeout';
          controller.abort();
          throw new Error('aborted');
        }
        if (now() - lastHeartbeatAt >= heartbeatIntervalMs && !runHeartbeat()) {
          throw new Error('aborted');
        }

        outputImage = await fetchHistoryImage(submittedId, controller.signal);
        if (runState.abortReason) throw new Error('aborted');
        if (now() - startedAt >= timeoutMs) {
          runState.abortReason = 'timeout';
          controller.abort();
          throw new Error('aborted');
        }
        if (!outputImage) {
          await sleepWithSignal(pollIntervalMs, controller.signal);
        }
      }

      const pngBytes = await downloadPngView(outputImage, controller.signal);
      if (runState.abortReason) throw new Error('aborted');
      if (now() - startedAt >= timeoutMs) {
        runState.abortReason = 'timeout';
        controller.abort();
        throw new Error('aborted');
      }

      const id = randomBytes(8).toString('hex');
      const resolvedDir = path.resolve(config.imagesDir);
      await mkdir(resolvedDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(resolvedDir, `${id}.png`), pngBytes, { flag: 'wx', mode: 0o600 });

      return {
        id,
        width: validated.width,
        height: validated.height,
        seed: validated.seed,
      };
    } catch (error) {
      if (runState.abortReason === 'timeout') {
        await sendInterrupt();
        throw new AppError(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s.`, {
          code: 'COMFYUI_TIMEOUT',
          statusCode: 504,
        });
      }
      if (runState.abortReason === 'lease-lost') {
        await sendInterrupt();
        throw new AppError('Image generation was interrupted because the GPU lease expired or was preempted.', {
          code: 'COMFYUI_LEASE_LOST',
          statusCode: 409,
        });
      }
      if (error instanceof AppError) throw error;
      throw new AppError('ComfyUI is offline or unreachable.', {
        code: 'COMFYUI_OFFLINE',
        statusCode: 503,
      });
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(heartbeatTimer);
      try {
        await fetchImpl(`${config.baseUrl}/free`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unload_models: true }),
          signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        }).catch(() => undefined);
      } finally {
        arbiter.release(lease.id);
      }
    }
  }

  /**
   * Probes ComfyUI (`GET /system_stats` with 3 s timeout) and merges `{ configured, online }` with `arbiter.state()`.
   */
  async function status(): Promise<ComfyuiStatus> {
    const configured = isConfigured();
    let online = false;
    if (configured) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/system_stats`, {
          signal: AbortSignal.timeout(config.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS),
        });
        online = response.ok;
      } catch {
        online = false;
      }
    }
    return {
      configured,
      online,
      ...(config.problem ? { problem: config.problem } : {}),
      ...arbiter.state(),
    };
  }

  /**
   * Reads a stored PNG by its 16-hex identifier from `config.imagesDir`, never accepting a path from the caller.
   */
  async function readImage(id: string): Promise<Buffer> {
    if (typeof id !== 'string' || !IMAGE_ID_PATTERN.test(id)) {
      throw new AppError('Invalid image id.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
    }
    const resolvedDir = path.resolve(config.imagesDir);
    const targetPath = path.join(resolvedDir, `${id}.png`);
    if (path.dirname(targetPath) !== resolvedDir) {
      throw new AppError('Invalid image id.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
    }
    try {
      const bytes = await readFile(targetPath);
      if (!isPngBuffer(bytes)) {
        throw new AppError('Stored image is not a valid PNG.', { code: 'COMFYUI_INVALID_IMAGE', statusCode: 500 });
      }
      return bytes;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('Image not found.', { code: 'COMFYUI_NOT_FOUND', statusCode: 404 });
      }
      throw new AppError('Could not read stored image.', { code: 'COMFYUI_READ_FAILED', statusCode: 500 });
    }
  }

  return { generate, status, readImage };
}

/**
 * Public ComfyUI service surface consumed by comfyui.routes.ts, comfyui.module.ts, index.ts, and tests.
 */
export type ComfyuiService = ReturnType<typeof createComfyuiService>;
