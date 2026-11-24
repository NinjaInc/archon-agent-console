import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

import { createComfyuiModule } from '../index.js';

import { VALID_1X1_PNG, createStubArbiter, startFakeComfyui, type FakeComfyuiBehavior, type StubArbiterOptions } from './fake-comfyui.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
});

/** response.json() is typed as unknown under server/tsconfig.json; tests assert on the parsed shape. */
const json = async (response: Response): Promise<any> => response.json();

async function setupRoutes(options: { behavior?: FakeComfyuiBehavior; arbiter?: StubArbiterOptions } = {}) {
  const imagesDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-routes-'));
  const fake = await startFakeComfyui({ pollsBeforeDone: 0, ...options.behavior });
  const stub = createStubArbiter(options.arbiter);
  let unloadCalls = 0;

  const { comfyuiRoutes } = createComfyuiModule({
    arbiter: stub.arbiter,
    unloadOllama: async () => {
      unloadCalls += 1;
    },
    env: {
      COMFYUI_BASE_URL: fake.baseUrl,
      COMFYUI_IMAGES_DIR: imagesDir,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/images', comfyuiRoutes);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/images`;

  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fake.close();
    await rm(imagesDir, { recursive: true, force: true });
  };
  cleanups.push(close);

  return {
    baseUrl,
    fake,
    stub,
    imagesDir,
    unloadCalls: () => unloadCalls,
    post: (routePath: string, body: unknown) =>
      fetch(`${baseUrl}${routePath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close,
  };
}

test('GET /status reports reachability and arbiter state without leaking host or filesystem paths', async () => {
  const t = await setupRoutes();
  const response = await fetch(`${t.baseUrl}/status`);
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes('127.0.0.1'), false);
  assert.equal(raw.includes(t.imagesDir), false);
  assert.deepEqual(JSON.parse(raw), {
    configured: true,
    online: true,
    state: 'idle',
    leases: [],
  });
  await t.close();
});

test('POST /generate ignores client workflow fields and GET /file/:id serves the stored PNG', async () => {
  const t = await setupRoutes();
  const genResponse = await t.post('/generate', {
    prompt: 'watercolor lighthouse',
    width: 512,
    height: 512,
    seed: 77,
    // Untrusted client fields that must never override the fixed server-side workflow:
    workflow: { '99': { class_type: 'EvilCustomNode', inputs: {} } },
    batch: 8,
  });
  assert.equal(genResponse.status, 200);
  const generated = await json(genResponse);
  assert.match(generated.id, /^[a-f0-9]{16}$/);
  assert.equal(generated.width, 512);
  assert.equal(generated.height, 512);
  assert.equal(generated.seed, 77);

  const sentWorkflow = t.fake.requests.find((req) => req.path === '/prompt')!.body.prompt;
  assert.equal('99' in sentWorkflow, false, 'client workflow must never be forwarded');
  assert.equal(sentWorkflow['5'].inputs.batch_size, 1, 'batch_size must stay 1');

  const fileResponse = await fetch(`${t.baseUrl}/file/${generated.id}`);
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('content-type'), 'image/png');
  assert.equal(fileResponse.headers.get('x-content-type-options'), 'nosniff');
  const servedBytes = Buffer.from(await fileResponse.arrayBuffer());
  assert.deepEqual(servedBytes, VALID_1X1_PNG);
  await t.close();
});

test('POST /generate returns 409 when GPU is busy and 400/422 on invalid or secret-bearing prompts', async () => {
  const t = await setupRoutes({ arbiter: { refuseReason: 'busy-external' } });
  const busy = await t.post('/generate', { prompt: 'castle', width: 512, height: 512 });
  assert.equal(busy.status, 409);
  const busyBody = await json(busy);
  assert.equal(busyBody.error.message, 'The desktop GPU is busy (a game or another job)');
  assert.equal(t.fake.requests.length, 0);

  t.stub.setRefuse(undefined);
  const badDim = await t.post('/generate', { prompt: 'castle', width: 500, height: 512 });
  assert.equal(badDim.status, 400);

  const secret = await t.post('/generate', {
    prompt: 'castle sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    width: 512,
    height: 512,
  });
  assert.equal(secret.status, 422);
  assert.equal((await json(secret)).error.code, 'COMFYUI_SECRETS_REFUSED');
  assert.equal(t.fake.requests.length, 0);
  await t.close();
});

test('GET /file/:id regex blocks path traversal and malformed ids, and returns 404 for unknown valid ids', async () => {
  const t = await setupRoutes();
  // Plant a sibling file above imagesDir to confirm traversal can never reach it.
  const outsideFile = path.join(path.dirname(t.imagesDir), 'outside-secret.png');
  await writeFile(outsideFile, VALID_1X1_PNG);
  cleanups.push(() => rm(outsideFile, { force: true }));

  const blockedPaths = [
    '/file/..%2foutside-secret',
    '/file/..%2f..%2fetc%2fpasswd',
    '/file/%2e%2e%5coutside-secret',
    '/file/0123456789abcdef.png',
    '/file/0123456789ABCDEF',
    '/file/0123456789abcde',
    '/file/0123456789abcdef0',
    '/file/0123456789abcdef/extra',
    '/file/%E0%A4%A',
  ];

  for (const badPath of blockedPaths) {
    const res = await fetch(`${t.baseUrl}${badPath}`);
    assert.equal(res.status, 400, `expected 400 for ${badPath}, got ${res.status}`);
    const body = await json(res);
    assert.equal(body.error.code, 'COMFYUI_BAD_REQUEST');
  }

  const missing = await fetch(`${t.baseUrl}/file/deadbeefcafebabe`);
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, 'COMFYUI_NOT_FOUND');

  await t.close();
});
