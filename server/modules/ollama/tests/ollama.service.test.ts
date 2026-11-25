import assert from 'node:assert/strict';
import test from 'node:test';

import type { OllamaConfig } from '../ollama.config.js';
import { OllamaError, buildChatRequest, createOllamaService, parseNativeLine, parseOpenAiLine, type OllamaEvent } from '../ollama.service.js';

import { startFakeOllama } from './fake-ollama.js';

const baseConfig = (baseUrl: string, extra: Partial<OllamaConfig> = {}): OllamaConfig => ({
  baseUrl, configured: true, model: 'qwen3:8b', timeoutMs: 3000, idleTimeoutMs: 500, numCtx: 8192, keepAlive: '5m', api: 'native', healthIntervalMs: 30_000, ...extra,
});
const messages = [{ role: 'user' as const, content: 'hi' }];

async function collect(service: ReturnType<typeof createOllamaService>, request = { messages }, signal?: AbortSignal) {
  const events: Array<OllamaEvent & { at: number }> = [];
  await service.streamChat(request, (event) => events.push({ ...event, at: Date.now() }), signal);
  return events;
}
const types = (events: OllamaEvent[]) => events.map((event) => event.type);
const textOf = (events: OllamaEvent[]) => events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('');

// ---- health and the offline path --------------------------------------------------------------------------------

test('health check lists the installed models, and goes red then green when the host stops and returns', async () => {
  const fake = await startFakeOllama({ models: ['qwen3:8b', 'llama3.2:3b'] });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const online = await service.checkHealth();
  assert.equal(online.status, 'online');
  assert.deepEqual(online.models.map((model) => model.name), ['qwen3:8b', 'llama3.2:3b']);
  assert.equal(service.getStatus().configured, true);

  await fake.close();
  const down = await service.checkHealth();
  assert.equal(down.status, 'offline');
  assert.deepEqual(down.models, []);
  assert.equal(service.getStatus().status, 'offline');
});

test('health polling runs on its interval and stops when told to', async () => {
  const fake = await startFakeOllama();
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { healthIntervalMs: 60 }) });
  const stop = service.startHealthPolling();
  await new Promise((resolve) => setTimeout(resolve, 250));
  stop();
  const polls = fake.requests.filter((request) => request.path === '/api/tags').length;
  assert.ok(polls >= 3, `expected at least 3 health checks, saw ${polls}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.requests.filter((request) => request.path === '/api/tags').length, polls, 'polling must stop after stop()');
  await fake.close();
});

test('offline path: with Ollama stopped a chat fails fast with "Local LLM offline" and never hangs', async () => {
  const fake = await startFakeOllama();
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  await fake.close(); // the desktop is asleep or busy gaming

  const started = Date.now();
  await assert.rejects(collect(service), (error: unknown) => {
    assert.ok(error instanceof OllamaError);
    assert.equal(error.code, 'OLLAMA_OFFLINE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, 'Local LLM offline');
    return true;
  });
  assert.ok(Date.now() - started < 2500, 'offline must be answered quickly');
  await assert.rejects(service.warmUp(), (error: unknown) => error instanceof OllamaError && error.code === 'OLLAMA_OFFLINE');
});

test('offline path: a host that vanishes between the health check and the request becomes an offline event', async () => {
  const fake = await startFakeOllama();
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  await service.checkHealth(); // online and fresh, so streamChat will not re-probe
  await fake.close();
  const events = await collect(service);
  const error = events.find((event) => event.type === 'error') as Extract<OllamaEvent, { type: 'error' }>;
  assert.equal(error.code, 'OLLAMA_OFFLINE');
  assert.equal(error.message, 'Local LLM offline');
  assert.equal(service.getHealth().status, 'offline');
});

// ---- cold start and the two timeouts ----------------------------------------------------------------------------

test('cold start: a long silence before the first token is allowed, shows "loading", then streams', async () => {
  // First token arrives after 700 ms. The idle timeout is only 300 ms, so this passes only because the long
  // first-token timeout applies until tokens start.
  const fake = await startFakeOllama({ loaded: [], behavior: { firstTokenDelayMs: 700, tokens: ['cold', ' start', ' ok'] } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { timeoutMs: 3000, idleTimeoutMs: 300 }) });
  const events = await collect(service);
  assert.deepEqual(types(events).filter((type) => type !== 'text'), ['status', 'status', 'usage', 'done']);
  assert.equal((events[0] as { state: string }).state, 'loading');
  assert.equal((events[1] as { state: string }).state, 'generating');
  assert.equal(textOf(events), 'cold start ok');
  await fake.close();
});

test('a model that is already loaded skips the loading state', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'] });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const events = await collect(service);
  assert.equal(events.some((event) => event.type === 'status' && event.state === 'loading'), false);
  await fake.close();
});

test('first-token timeout: a model that never answers ends with a clear timeout, not a hang', async () => {
  const fake = await startFakeOllama({ behavior: { firstTokenDelayMs: 5000 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { timeoutMs: 400 }) });
  const started = Date.now();
  const events = await collect(service);
  const error = events.find((event) => event.type === 'error') as Extract<OllamaEvent, { type: 'error' }>;
  assert.equal(error.code, 'OLLAMA_TIMEOUT');
  assert.match(error.message, /No reply within/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(types(events).at(-1), 'done');
  await fake.close();
});

test('idle timeout: a reply that stalls after some tokens is cut off, and what arrived is kept', async () => {
  const fake = await startFakeOllama({ behavior: { tokens: ['one', ' two', ' three', ' four'], stallAfter: 2 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { timeoutMs: 5000, idleTimeoutMs: 300 }) });
  const started = Date.now();
  const events = await collect(service);
  const error = events.find((event) => event.type === 'error') as Extract<OllamaEvent, { type: 'error' }>;
  assert.equal(error.code, 'OLLAMA_TIMEOUT');
  assert.match(error.message, /stopped responding/);
  assert.equal(textOf(events), 'one two');
  assert.ok(Date.now() - started < 2500, 'must use the short idle timeout, not the 5 s first-token one');
  await fake.close();
});

test('tokens are passed through as they arrive, not held back until the end', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'], behavior: { tokens: ['a', 'b', 'c'], tokenGapMs: 250 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { idleTimeoutMs: 2000 }) });
  const events = await collect(service);
  const texts = events.filter((event) => event.type === 'text');
  assert.equal(texts.length, 3);
  assert.ok(texts[2].at - texts[0].at >= 400, 'the first token must be emitted well before the last one');
  await fake.close();
});

test('stopping from the browser aborts the upstream request and sends no done event', async () => {
  const fake = await startFakeOllama({ behavior: { tokens: ['a', 'b', 'c', 'd', 'e'], tokenGapMs: 150 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { idleTimeoutMs: 2000 }) });
  const controller = new AbortController();
  const events: OllamaEvent[] = [];
  const running = service.streamChat({ messages }, (event) => { events.push(event); if (event.type === 'text') controller.abort(); }, controller.signal);
  await running;
  assert.equal(events.some((event) => event.type === 'done'), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fake.state.aborted, 1, 'the connection to Ollama must be closed');
  assert.equal(service.activeStreams(), 0);
  await fake.close();
});

// ---- errors with a next step -------------------------------------------------------------------------------------

test('a model that is not installed is refused before anything is sent, with the pull command', async () => {
  const fake = await startFakeOllama({ models: ['qwen3:8b'] });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  await assert.rejects(collect(service, { messages, model: 'mistral:7b' } as never), (error: unknown) => {
    assert.ok(error instanceof OllamaError);
    assert.equal(error.code, 'OLLAMA_MODEL_MISSING');
    assert.match(error.message, /ollama pull mistral:7b/);
    return true;
  });
  assert.equal(fake.requests.some((request) => request.path === '/api/chat'), false);
  await fake.close();
});

test('VRAM exhausted is reported as such, with advice', async () => {
  const fake = await startFakeOllama({ behavior: { status: 500, errorBody: '{"error":"llama runner process has terminated: cudaMalloc failed: out of memory"}' } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const events = await collect(service);
  const error = events.find((event) => event.type === 'error') as Extract<OllamaEvent, { type: 'error' }>;
  assert.equal(error.code, 'OLLAMA_OUT_OF_MEMORY');
  assert.match(error.message, /ran out of memory/);
  assert.match(error.message, /games/);
  await fake.close();
});

test('an upstream 404 for the model is mapped to "not installed"', async () => {
  const fake = await startFakeOllama({ behavior: { status: 404, errorBody: '{"error":"model \\"qwen3:8b\\" not found, try pulling it first"}' } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const events = await collect(service);
  assert.equal((events.find((event) => event.type === 'error') as { code: string }).code, 'OLLAMA_MODEL_MISSING');
  await fake.close();
});

test('only two replies run at once; a third is refused as busy', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'], behavior: { firstTokenDelayMs: 400 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const first = collect(service);
  const second = collect(service);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(collect(service), (error: unknown) => error instanceof OllamaError && error.code === 'OLLAMA_BUSY' && error.statusCode === 429);
  await Promise.all([first, second]);
  assert.equal(service.activeStreams(), 0);
  await fake.close();
});

// ---- what is sent ------------------------------------------------------------------------------------------------

test('native request: pins the 8k context, keeps the model for 5m, thinking off by default, and NEVER sends tools', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'] });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  await collect(service);
  const sent = fake.requests.find((request) => request.path === '/api/chat')!.body;
  assert.equal(sent.model, 'qwen3:8b');
  assert.equal(sent.stream, true);
  assert.equal(sent.think, false);
  assert.equal(sent.keep_alive, '5m');
  assert.equal(sent.options.num_ctx, 8192);
  assert.equal('tools' in sent, false);
  assert.equal('functions' in sent, false);
  assert.equal('tool_choice' in sent, false);

  await collect(service, { messages, think: true } as never);
  assert.equal(fake.requests.filter((request) => request.path === '/api/chat').at(-1)!.body.think, true);
  await fake.close();
});

test('openai request: /v1 with usage streaming, reasoning off unless asked, and NEVER sends tools', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'], behavior: { thinking: ['hmm'], tokens: ['ok'] } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { api: 'openai' }) });
  const events = await collect(service);
  const sent = fake.requests.find((request) => request.path === '/v1/chat/completions')!.body;
  assert.equal(sent.reasoning_effort, 'none');
  assert.equal(sent.stream, true);
  assert.equal('tools' in sent, false);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => (event as { text: string }).text), ['hmm']);
  assert.equal(textOf(events), 'ok');
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', inputTokens: 12, outputTokens: 1, at: (events.find((event) => event.type === 'usage') as { at: number }).at });

  await collect(service, { messages, think: true } as never);
  assert.equal('reasoning_effort' in fake.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)!.body, false);
  await fake.close();
});

test('buildChatRequest never contains a tools field in either mode', () => {
  for (const api of ['native', 'openai'] as const) {
    const { body } = buildChatRequest(baseConfig('http://127.0.0.1:1', { api }), { model: 'qwen3:8b', messages, think: false });
    assert.equal(Object.keys(body).some((key) => /tool|function/i.test(key)), false, `${api} body must not carry tools`);
  }
});

test('native thinking tokens are kept apart from the answer', async () => {
  const fake = await startFakeOllama({ loaded: ['qwen3:8b'], behavior: { thinking: ['let me think'], tokens: ['answer'] } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const events = await collect(service, { messages, think: true } as never);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => (event as { text: string }).text), ['let me think']);
  assert.equal(textOf(events), 'answer');
  await fake.close();
});

test('warm-up loads the model with the same context window and keep-alive chat uses, from an empty prompt', async () => {
  const fake = await startFakeOllama();
  const service = createOllamaService({ config: baseConfig(fake.baseUrl) });
  const result = await service.warmUp();
  assert.equal(result.model, 'qwen3:8b');
  assert.equal(result.alreadyLoaded, false);
  const sent = fake.requests.find((request) => request.path === '/api/generate')!.body;
  assert.equal(sent.prompt, '');
  assert.equal(sent.options.num_ctx, 8192);
  assert.equal(sent.keep_alive, '5m');
  await fake.close();
});

test('warm-up reports a timeout instead of hanging when the model will not load', async () => {
  const fake = await startFakeOllama({ behavior: { warmDelayMs: 3000 } });
  const service = createOllamaService({ config: baseConfig(fake.baseUrl, { timeoutMs: 300 }) });
  await assert.rejects(service.warmUp(), (error: unknown) => error instanceof OllamaError && error.code === 'OLLAMA_TIMEOUT');
  await fake.close();
});

// ---- line parsers ------------------------------------------------------------------------------------------------

test('parsers ignore noise and map in-stream errors', () => {
  assert.deepEqual(parseNativeLine('', 'm'), []);
  assert.deepEqual(parseNativeLine('not json', 'm'), []);
  assert.deepEqual(parseOpenAiLine(': ping', 'm'), []);
  assert.deepEqual(parseOpenAiLine('data: [DONE]', 'm'), []);
  const native = parseNativeLine('{"error":"cuda out of memory"}', 'm')[0];
  assert.equal(native.type === 'error' && native.code, 'OLLAMA_OUT_OF_MEMORY');
  const tokensPerSecond = parseNativeLine('{"done":true,"eval_count":42,"eval_duration":1000000000,"prompt_eval_count":5}', 'm')[0];
  assert.deepEqual(tokensPerSecond, { type: 'usage', inputTokens: 5, outputTokens: 42, tokensPerSecond: 42 });
});

test('unload asks for every loaded model to be released, and does nothing when Ollama cannot be reached', async () => {
  const posted: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/ps')) return Response.json({ models: [{ name: 'a:1' }, { name: 'b:2' }] });
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({});
  }) as typeof fetch;
  await createOllamaService({ config: baseConfig('http://127.0.0.1:1'), fetchImpl }).unload();
  assert.deepEqual(posted, [{ model: 'a:1', keep_alive: 0 }, { model: 'b:2', keep_alive: 0 }]);
  await createOllamaService({ config: baseConfig('http://127.0.0.1:1') }).unload();
});
