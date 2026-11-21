/**
 * A tiny fake Ollama server for tests: real HTTP on 127.0.0.1, so timeouts, stalls, refused connections and a host
 * that disappears mid-test behave exactly as they do against the real thing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeBehavior = {
  /** Silence before the first token (a cold model load). */
  firstTokenDelayMs?: number;
  tokens?: string[];
  thinking?: string[];
  tokenGapMs?: number;
  /** Stop sending after this many tokens but keep the connection open (a stalled reply). */
  stallAfter?: number;
  /** Answer with an error status and body instead of streaming. */
  status?: number;
  errorBody?: string;
  /** Delay before /api/generate (warm-up) answers. */
  warmDelayMs?: number;
};

export type RecordedRequest = { method: string; path: string; body: any };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeOllama(options: { models?: string[]; loaded?: string[]; behavior?: FakeBehavior } = {}) {
  const requests: RecordedRequest[] = [];
  const state = { behavior: options.behavior ?? {}, models: options.models ?? ['qwen3:8b'], loaded: options.loaded ?? [], aborted: 0 };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ method: req.method ?? 'GET', path, body });

    let closed = false;
    res.on('close', () => { if (!res.writableEnded) state.aborted += 1; closed = true; });
    const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const b = state.behavior;

    if (path === '/api/tags') return json({ models: state.models.map((name) => ({ name, size: 5_000_000_000, details: { parameter_size: '8.2B' } })) });
    if (path === '/api/ps') return json({ models: state.loaded.map((name) => ({ name })) });
    if (path === '/api/generate') {
      await sleep(b.warmDelayMs ?? 0);
      if (b.status && b.status >= 400) { res.writeHead(b.status); return res.end(b.errorBody ?? ''); }
      return json({ model: body?.model, response: '', done: true, done_reason: 'load' });
    }

    const isNative = path === '/api/chat';
    const isOpenAi = path === '/v1/chat/completions';
    if (!isNative && !isOpenAi) { res.writeHead(404); return res.end('not found'); }
    if (b.status && b.status >= 400) { res.writeHead(b.status); return res.end(b.errorBody ?? ''); }

    res.writeHead(200, { 'content-type': isNative ? 'application/x-ndjson' : 'text/event-stream' });
    await sleep(b.firstTokenDelayMs ?? 0);
    const write = (value: unknown) => { if (!closed) res.write(isNative ? `${JSON.stringify(value)}\n` : `data: ${JSON.stringify(value)}\n\n`); };
    for (const thought of b.thinking ?? []) {
      write(isNative ? { message: { role: 'assistant', content: '', thinking: thought }, done: false } : { choices: [{ delta: { content: '', reasoning: thought } }] });
    }
    const tokens = b.tokens ?? ['Hello', ' world'];
    for (let index = 0; index < tokens.length; index += 1) {
      if (b.stallAfter !== undefined && index >= b.stallAfter) return; // leave the connection open and silent
      write(isNative ? { message: { role: 'assistant', content: tokens[index] }, done: false } : { choices: [{ delta: { content: tokens[index] } }] });
      await sleep(b.tokenGapMs ?? 0);
    }
    if (isNative) write({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 12, eval_count: tokens.length, eval_duration: 500_000_000 });
    else { write({ choices: [], usage: { prompt_tokens: 12, completion_tokens: tokens.length } }); if (!closed) res.write('data: [DONE]\n\n'); }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    state,
    setBehavior(next: FakeBehavior) { state.behavior = next; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
