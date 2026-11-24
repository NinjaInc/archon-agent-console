import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { AppError } from '@/shared/utils.js';

import type { ComfyuiConfig } from '../comfyui.config.js';
import { IMAGE_ID_PATTERN, createComfyuiService, type GenerateImageInput } from '../comfyui.service.js';

import { VALID_1X1_PNG, createStubArbiter, startFakeComfyui, type FakeComfyuiBehavior, type StubArbiterOptions } from './fake-comfyui.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
});

async function setup(options: {
  behavior?: FakeComfyuiBehavior;
  arbiter?: StubArbiterOptions;
  config?: Partial<ComfyuiConfig>;
  unloadImpl?: () => Promise<void>;
} = {}) {
  const events: string[] = [];
  const imagesDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-svc-'));
  const fake = await startFakeComfyui(options.behavior);
  fake.onEvent((label) => events.push(label));
  const stub = createStubArbiter({
    ...options.arbiter,
    onEvent: (label) => {
      events.push(label);
      options.arbiter?.onEvent?.(label);
    },
  });

  let clock = 1_000_000;
  let unloadCalls = 0;
  const config: ComfyuiConfig = {
    baseUrl: fake.baseUrl,
    configured: true,
    imagesDir,
    checkpoint: 'flux_dev.safetensors',
    timeoutMs: 180_000,
    heartbeatIntervalMs: 30_000,
    pollIntervalMs: 15,
    statusTimeoutMs: 3_000,
    ...options.config,
  };

  const service = createComfyuiService({
    config,
    arbiter: stub.arbiter,
    now: () => clock,
    unloadOllama: async () => {
      unloadCalls += 1;
      events.push('unloadOllama');
      if (options.unloadImpl) await options.unloadImpl();
    },
  });

  const close = async () => {
    await fake.close();
    await rm(imagesDir, { recursive: true, force: true });
  };
  cleanups.push(close);

  return {
    fake,
    stub,
    service,
    imagesDir,
    events,
    unloadCalls: () => unloadCalls,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    close,
  };
}

// ---- validation limits & secret guard ---------------------------------------------------------------------------

test('validation limits: prompt bounds, width/height multiples of 64 in 256..1024, and seed rules', async () => {
  const t = await setup();
  const badInputs: GenerateImageInput[] = [
    { prompt: '', width: 512, height: 512 },
    { prompt: '   \n\t  ', width: 512, height: 512 },
    { prompt: 'a'.repeat(2001), width: 512, height: 512 },
    { prompt: 'cat', negative: 'n'.repeat(2001), width: 512, height: 512 },
    { prompt: 'cat', width: 192, height: 512 },
    { prompt: 'cat', width: 512, height: 1088 },
    { prompt: 'cat', width: 500, height: 512 },
    { prompt: 'cat', width: 512, height: 513 },
    { prompt: 'cat', width: 512.5, height: 512 },
    { prompt: 'cat', width: Number.NaN, height: 512 },
    { prompt: 'cat', width: 512, height: 512, seed: -1 },
    { prompt: 'cat', width: 512, height: 512, seed: 3.14 },
  ];

  for (const input of badInputs) {
    await assert.rejects(t.service.generate(input), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMFYUI_BAD_REQUEST');
      assert.equal(error.statusCode, 400);
      return true;
    });
  }

  assert.equal(t.stub.acquired.length, 0, 'invalid input must never touch GPU leases');
  assert.equal(t.unloadCalls(), 0, 'invalid input must never unload Ollama');
  assert.equal(t.fake.requests.length, 0, 'invalid input must never call ComfyUI');

  // Boundary dimensions (256 and 1024) and exact 2000-character prompt succeed.
  const ok = await t.service.generate({ prompt: 'p'.repeat(2000), width: 256, height: 1024, seed: 0 });
  assert.equal(ok.width, 256);
  assert.equal(ok.height, 1024);
  assert.equal(ok.seed, 0);
  await t.close();
});

test('secret refusal: prompts or negative prompts matching findSecrets are refused without echoing the secret', async () => {
  const t = await setup();
  const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const envSecret = 'DATABASE_PASSWORD=supersecretpassword123';

  for (const input of [
    { prompt: `draw a badge with ${githubToken}`, width: 512, height: 512 },
    { prompt: 'a sunset', negative: envSecret, width: 512, height: 512 },
  ]) {
    await assert.rejects(t.service.generate(input), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMFYUI_SECRETS_REFUSED');
      assert.equal(error.statusCode, 422);
      assert.equal(error.message.includes(githubToken), false);
      assert.equal(error.message.includes('supersecretpassword123'), false);
      return true;
    });
  }

  assert.equal(t.stub.acquired.length, 0);
  assert.equal(t.unloadCalls(), 0);
  assert.equal(t.fake.requests.length, 0);
  await t.close();
});

// ---- happy path: ordering, server-side workflow, PNG storage, cleanup ------------------------------------------

test('success flow: acquires lease, unloads Ollama before /prompt, polls history, saves PNG, calls /free and releases lease', async () => {
  const t = await setup({ behavior: { pollsBeforeDone: 2 } });
  const result = await t.service.generate({
    prompt: 'isometric pixel cabin in snow',
    negative: 'blurry, watermark',
    width: 768,
    height: 512,
    seed: 424242,
  });

  assert.match(result.id, IMAGE_ID_PATTERN);
  assert.equal(result.width, 768);
  assert.equal(result.height, 512);
  assert.equal(result.seed, 424242);

  // Verify strict execution order: acquire -> unloadOllama -> POST /prompt -> /history -> /view -> POST /free -> release
  const acquireIdx = t.events.indexOf('acquire:image:interactive:comfyui');
  const unloadIdx = t.events.indexOf('unloadOllama');
  const promptIdx = t.events.indexOf('POST /prompt');
  const historyIdx = t.events.indexOf('GET /history/prompt-1');
  const viewIdx = t.events.indexOf('GET /view');
  const freeIdx = t.events.indexOf('POST /free');
  const releaseIdx = t.events.indexOf('release:lease-1');

  assert.ok(acquireIdx >= 0 && acquireIdx < unloadIdx, `expected acquire before unload: ${t.events.join(' -> ')}`);
  assert.ok(unloadIdx < promptIdx, `expected unloadOllama before POST /prompt: ${t.events.join(' -> ')}`);
  assert.ok(promptIdx < historyIdx && historyIdx < viewIdx, `expected prompt -> history -> view: ${t.events.join(' -> ')}`);
  assert.ok(viewIdx < freeIdx && freeIdx < releaseIdx, `expected view -> /free -> release: ${t.events.join(' -> ')}`);
  assert.equal(t.stub.activeLeases.size, 0);

  // Verify server-side workflow template values and pinned batch_size = 1.
  const posted = t.fake.requests.find((req) => req.path === '/prompt')!.body;
  assert.equal(posted.prompt['5'].inputs.width, 768);
  assert.equal(posted.prompt['5'].inputs.height, 512);
  assert.equal(posted.prompt['5'].inputs.batch_size, 1);
  assert.equal(posted.prompt['6'].inputs.text, 'isometric pixel cabin in snow');
  assert.equal(posted.prompt['7'].inputs.text, 'blurry, watermark');
  assert.equal(posted.prompt['3'].inputs.seed, 424242);
  assert.equal(posted.prompt['4'].inputs.ckpt_name, 'flux_dev.safetensors');

  // Verify /free payload unloads models.
  const freeReq = t.fake.requests.find((req) => req.path === '/free')!;
  assert.deepEqual(freeReq.body, { unload_models: true });

  // Verify saved PNG file on disk matches downloaded bytes and is readable via service.readImage.
  const onDisk = await readFile(path.join(t.imagesDir, `${result.id}.png`));
  assert.deepEqual(onDisk, VALID_1X1_PNG);
  assert.deepEqual(await t.service.readImage(result.id), VALID_1X1_PNG);

  await t.close();
});

// ---- GPU busy refusal -------------------------------------------------------------------------------------------

test('game-busy and held GPU refusals throw 409 with the plain message and post nothing', async () => {
  for (const reason of ['busy-external', 'held'] as const) {
    const t = await setup({ arbiter: { refuseReason: reason } });
    await assert.rejects(
      t.service.generate({ prompt: 'mountain lake', width: 512, height: 512 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'COMFYUI_GPU_BUSY');
        assert.equal(error.message, 'The desktop GPU is busy (a game or another job)');
        return true;
      },
    );
    assert.equal(t.unloadCalls(), 0, `${reason}: must not unload Ollama when GPU is busy`);
    assert.equal(t.fake.requests.length, 0, `${reason}: nothing may be posted to ComfyUI`);
    await t.close();
  }
});

// ---- cleanup on every failure mode ------------------------------------------------------------------------------

test('lease is released and /free {unload_models:true} is posted on upstream, PNG, and unload failures', async () => {
  const failureCases: Array<{
    name: string;
    behavior?: FakeComfyuiBehavior;
    unloadImpl?: () => Promise<void>;
    expectedCode: string;
  }> = [
    { name: 'prompt 500', behavior: { promptStatus: 500 }, expectedCode: 'COMFYUI_UPSTREAM' },
    { name: 'workflow error in history', behavior: { historyWorkflowError: true }, expectedCode: 'COMFYUI_UPSTREAM' },
    { name: 'view 500', behavior: { pollsBeforeDone: 0, viewStatus: 500 }, expectedCode: 'COMFYUI_UPSTREAM' },
    {
      name: 'non-PNG bytes from /view',
      behavior: { pollsBeforeDone: 0, viewBytes: Buffer.from('JFIF-not-a-png-file') },
      expectedCode: 'COMFYUI_INVALID_IMAGE',
    },
    {
      name: 'non-PNG filename in history',
      behavior: { pollsBeforeDone: 0, outputFilename: 'bad.webp' },
      expectedCode: 'COMFYUI_INVALID_IMAGE',
    },
    {
      name: 'unloadOllama failure (with /free also failing 500)',
      behavior: { freeStatus: 500 },
      unloadImpl: async () => {
        throw new Error('ollama down');
      },
      expectedCode: 'COMFYUI_UNLOAD_FAILED',
    },
  ];

  for (const scenario of failureCases) {
    const t = await setup({ behavior: scenario.behavior, unloadImpl: scenario.unloadImpl });
    await assert.rejects(
      t.service.generate({ prompt: 'forest', width: 512, height: 512 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `${scenario.name} must throw AppError`);
        assert.equal(error.code, scenario.expectedCode, scenario.name);
        return true;
      },
    );
    assert.equal(t.stub.acquired.length, 1, `${scenario.name}: lease was acquired`);
    assert.deepEqual(t.stub.released, ['lease-1'], `${scenario.name}: lease must be released`);
    assert.equal(t.stub.activeLeases.size, 0, `${scenario.name}: no active lease left behind`);
    const freeCalls = t.fake.requests.filter((req) => req.path === '/free');
    assert.equal(freeCalls.length, 1, `${scenario.name}: /free must be called once`);
    assert.deepEqual(freeCalls[0].body, { unload_models: true }, `${scenario.name}: /free body`);
    await t.close();
  }
});

// ---- timeout & heartbeat preemption -----------------------------------------------------------------------------

test('timeout aborts polling, posts /interrupt, posts /free, and releases the lease', async () => {
  const t = await setup({
    behavior: { neverComplete: true },
    config: { timeoutMs: 90, pollIntervalMs: 20 },
  });

  await assert.rejects(
    t.service.generate({ prompt: 'slow render', width: 512, height: 512 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMFYUI_TIMEOUT');
      assert.equal(error.statusCode, 504);
      return true;
    },
  );

  const interruptIdx = t.events.indexOf('POST /interrupt');
  const freeIdx = t.events.indexOf('POST /free');
  const releaseIdx = t.events.indexOf('release:lease-1');
  assert.ok(interruptIdx > 0, `expected POST /interrupt on timeout: ${t.events.join(' -> ')}`);
  assert.ok(interruptIdx < freeIdx && freeIdx < releaseIdx, `expected interrupt -> /free -> release: ${t.events.join(' -> ')}`);
  assert.equal(t.stub.activeLeases.size, 0);
  await t.close();
});

test('heartbeat renews every 30 s, and a false heartbeat aborts, posts /interrupt, posts /free, and releases the lease', async () => {
  const t = await setup();
  t.fake.setBehavior({
    neverComplete: true,
    onHistoryPoll: (pollCount) => {
      // Advance injected clock by 30 s per poll: heartbeat 1 succeeds, heartbeat 2 fails.
      t.advanceClock(30_000);
      if (pollCount >= 2) t.stub.setHeartbeat(false);
    },
  });

  await assert.rejects(
    t.service.generate({ prompt: 'preempted render', width: 512, height: 512 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMFYUI_LEASE_LOST');
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  assert.equal(t.stub.heartbeats.length, 2, 'should heartbeat once at 30 s (ok) and once at 60 s (false)');
  assert.ok(t.events.includes('POST /interrupt'), 'must POST /interrupt when heartbeat returns false');
  assert.ok(t.events.includes('POST /free'), 'must POST /free after preemption');
  assert.deepEqual(t.stub.released, ['lease-1']);
  await t.close();
});

// ---- status() ---------------------------------------------------------------------------------------------------

test('status() probes /system_stats with timeout and combines {configured, online} with arbiter.state()', async () => {
  const t = await setup({ behavior: { systemStatsDelayMs: 0 } });
  assert.deepEqual(await t.service.status(), {
    configured: true,
    online: true,
    state: 'idle',
    leases: [],
  });

  // Slow /system_stats past statusTimeoutMs reports online: false without throwing.
  t.fake.setBehavior({ systemStatsDelayMs: 250 });
  const slowService = createComfyuiService({
    config: { baseUrl: t.fake.baseUrl, configured: true, imagesDir: t.imagesDir, statusTimeoutMs: 60 },
    arbiter: t.stub.arbiter,
    unloadOllama: async () => undefined,
  });
  assert.equal((await slowService.status()).online, false);

  // Unconfigured service does not probe ComfyUI at all.
  const requestsBefore = t.fake.requests.length;
  const unconfigured = createComfyuiService({
    config: { baseUrl: t.fake.baseUrl, configured: false, imagesDir: t.imagesDir },
    arbiter: t.stub.arbiter,
    unloadOllama: async () => undefined,
  });
  assert.deepEqual(await unconfigured.status(), {
    configured: false,
    online: false,
    state: 'idle',
    leases: [],
  });
  assert.equal(t.fake.requests.length, requestsBefore);

  await t.close();
});
