/**
 * Fake ComfyUI HTTP server on 127.0.0.1 and stub GPU arbiter for deterministic unit and route tests.
 * Author: Josh Neufield (Archon Tech)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AcquireResult, GpuArbiter, GpuState, Lease, LeaseKind, LeasePriority } from '@/modules/gpu-arbiter/index.js';

/** Minimal valid 1x1 transparent PNG (67 bytes: PNG signature, IHDR, IDAT, IEND). */
export const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export type FakeComfyuiBehavior = {
  /** HTTP status for GET /system_stats (default 200). */
  systemStatsStatus?: number;
  /** Delay before GET /system_stats responds (ms). */
  systemStatsDelayMs?: number;
  /** HTTP status for POST /prompt (default 200). */
  promptStatus?: number;
  /** Custom JSON payload returned by POST /prompt. */
  promptResponse?: unknown;
  /** Number of empty `{}` history polls before reporting the output image (default 1). */
  pollsBeforeDone?: number;
  /** Keep returning `{}` from GET /history/{id} forever so timeout/preemption paths run. */
  neverComplete?: boolean;
  /** Delay on each GET /history/{id} response (ms). */
  historyDelayMs?: number;
  /** HTTP status for GET /history/{id} (default 200). */
  historyStatus?: number;
  /** Simulate a ComfyUI workflow execution failure in /history/{id}. */
  historyWorkflowError?: boolean;
  /** Simulate completed: true with no output images in /history/{id}. */
  historyEmptyOutputs?: boolean;
  /** Filename advertised in the history output (default 'archon_00001_.png'). */
  outputFilename?: string;
  /** Callback invoked on each GET /history/{id} request with the 1-based poll count. */
  onHistoryPoll?: (pollCount: number) => void;
  /** HTTP status for GET /view (default 200). */
  viewStatus?: number;
  /** Content-Type header for GET /view (default 'image/png'). */
  viewContentType?: string;
  /** Raw bytes returned by GET /view (default VALID_1X1_PNG). */
  viewBytes?: Buffer;
  /** HTTP status for POST /free (default 200). */
  freeStatus?: number;
};

export type RecordedComfyuiRequest = {
  method: string;
  path: string;
  body: any;
  seq: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a real loopback HTTP fake of ComfyUI's REST API (`/system_stats`, `/prompt`, `/history/:id`, `/view`,
 * `/interrupt`, `/free`). Consumed by comfyui.service.test.ts and comfyui.routes.test.ts.
 */
export async function startFakeComfyui(initialBehavior: FakeComfyuiBehavior = {}) {
  const requests: RecordedComfyuiRequest[] = [];
  let behavior: FakeComfyuiBehavior = { ...initialBehavior };
  let promptCounter = 0;
  let historyPolls = 0;
  let seqCounter = 0;
  const onEventCallbacks: Array<(label: string) => void> = [];

  const recordEvent = (label: string) => {
    for (const fn of onEventCallbacks) fn(label);
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const urlPath = req.url ?? '/';
    const method = req.method ?? 'GET';
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    seqCounter += 1;
    requests.push({ method, path: urlPath, body, seq: seqCounter });
    recordEvent(`${method} ${urlPath.split('?')[0]}`);

    const sendJson = (status: number, payload: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (method === 'GET' && urlPath === '/system_stats') {
      if (behavior.systemStatsDelayMs) await sleep(behavior.systemStatsDelayMs);
      return sendJson(behavior.systemStatsStatus ?? 200, {
        system: { os: 'posix', comfyui_version: '0.3.0' },
        devices: [{ name: 'cuda:0', type: 'cuda' }],
      });
    }

    if (method === 'POST' && urlPath === '/prompt') {
      const status = behavior.promptStatus ?? 200;
      if (status >= 400) return sendJson(status, { error: 'bad prompt' });
      promptCounter += 1;
      const promptId = `prompt-${promptCounter}`;
      return sendJson(status, behavior.promptResponse ?? { prompt_id: promptId, number: promptCounter });
    }

    if (method === 'GET' && urlPath.startsWith('/history/')) {
      historyPolls += 1;
      behavior.onHistoryPoll?.(historyPolls);
      if (behavior.historyDelayMs) await sleep(behavior.historyDelayMs);
      const status = behavior.historyStatus ?? 200;
      if (status >= 400) return sendJson(status, { error: 'history error' });

      const promptId = decodeURIComponent(urlPath.slice('/history/'.length));
      if (behavior.historyWorkflowError) {
        return sendJson(200, {
          [promptId]: { status: { status_str: 'error', completed: false }, outputs: {} },
        });
      }
      if (behavior.neverComplete || historyPolls <= (behavior.pollsBeforeDone ?? 1)) {
        return sendJson(200, {});
      }
      if (behavior.historyEmptyOutputs) {
        return sendJson(200, {
          [promptId]: { status: { status_str: 'success', completed: true }, outputs: {} },
        });
      }
      return sendJson(200, {
        [promptId]: {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': {
              images: [
                {
                  filename: behavior.outputFilename ?? 'archon_00001_.png',
                  subfolder: '',
                  type: 'output',
                },
              ],
            },
          },
        },
      });
    }

    if (method === 'GET' && urlPath.startsWith('/view')) {
      const status = behavior.viewStatus ?? 200;
      if (status >= 400) return sendJson(status, { error: 'view failed' });
      const bytes = behavior.viewBytes ?? VALID_1X1_PNG;
      res.writeHead(200, { 'content-type': behavior.viewContentType ?? 'image/png' });
      res.end(bytes);
      return;
    }

    if (method === 'POST' && urlPath === '/interrupt') {
      return sendJson(200, { interrupted: true });
    }

    if (method === 'POST' && urlPath === '/free') {
      return sendJson(behavior.freeStatus ?? 200, { freed: true });
    }

    sendJson(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    requests,
    onEvent(fn: (label: string) => void) {
      onEventCallbacks.push(fn);
    },
    setBehavior(next: FakeComfyuiBehavior) {
      behavior = { ...next };
      historyPolls = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type StubArbiterOptions = {
  refuseReason?: 'busy-external' | 'held' | 'desktop-unreachable';
  heartbeatResult?: boolean | ((callIndex: number) => boolean);
  onEvent?: (label: string) => void;
};

/**
 * In-memory stub GPU arbiter that records acquire, heartbeat, release, and live lease state without SQLite.
 * Consumed by comfyui.service.test.ts and comfyui.routes.test.ts.
 */
export function createStubArbiter(options: StubArbiterOptions = {}) {
  const activeLeases = new Map<string, Lease>();
  const acquired: Lease[] = [];
  const heartbeats: string[] = [];
  const released: string[] = [];
  let leaseCounter = 0;
  let refuseReason = options.refuseReason;
  let heartbeatRule = options.heartbeatResult ?? true;

  const arbiter: Pick<GpuArbiter, 'acquire' | 'heartbeat' | 'release' | 'state'> = {
    async acquire(request: { holder: string; kind: LeaseKind; priority: LeasePriority }): Promise<AcquireResult> {
      options.onEvent?.(`acquire:${request.kind}:${request.priority}:${request.holder}`);
      if (refuseReason) {
        return { ok: false, reason: refuseReason };
      }
      leaseCounter += 1;
      const lease: Lease = {
        id: `lease-${leaseCounter}`,
        holder: request.holder,
        kind: request.kind,
        priority: request.priority,
        expiresAt: Date.now() + 90_000,
        preempted: false,
      };
      activeLeases.set(lease.id, lease);
      acquired.push(lease);
      return { ok: true, lease };
    },
    heartbeat(id: string): boolean {
      heartbeats.push(id);
      options.onEvent?.(`heartbeat:${id}`);
      if (!activeLeases.has(id)) return false;
      const ok = typeof heartbeatRule === 'function' ? heartbeatRule(heartbeats.length) : heartbeatRule;
      if (!ok) activeLeases.delete(id);
      return ok;
    },
    release(id: string): void {
      released.push(id);
      activeLeases.delete(id);
      options.onEvent?.(`release:${id}`);
    },
    state(): { state: GpuState; leases: Lease[] } {
      const leases = [...activeLeases.values()];
      const state: GpuState = leases.some((l) => l.kind === 'image') ? 'image' : leases.length > 0 ? 'llm' : 'idle';
      return { state, leases };
    },
  };

  return {
    arbiter,
    acquired,
    heartbeats,
    released,
    activeLeases,
    setRefuse(next: StubArbiterOptions['refuseReason']) {
      refuseReason = next;
    },
    setHeartbeat(next: StubArbiterOptions['heartbeatResult']) {
      heartbeatRule = next ?? true;
    },
  };
}
