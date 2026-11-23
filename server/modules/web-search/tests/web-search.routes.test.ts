import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

import express from 'express';

import type { OllamaEvent } from '@/modules/ollama/index.js';
import type { WebSearchResult } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createPageFetcher } from '../web-search.net.js';
import { createWebSearchRouter } from '../web-search.routes.js';
import { createWebSearchService } from '../web-search.service.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { await Promise.all(closers.map((close) => close().catch(() => undefined))); });

const json = async (response: Response): Promise<any> => response.json();
const frames = (text: string): any[] => text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data:'))).filter(Boolean).map((l) => JSON.parse((l as string).slice(5)));

type Setup = { results?: WebSearchResult[]; pages?: Record<string, string>; ollamaEnabled?: boolean; offline?: boolean; searchOnline?: boolean };

async function setup(options: Setup = {}) {
  const searches: string[] = [];
  const chats: Array<{ messages: Array<{ role: string; content: string }>; think?: boolean; model?: string; preamble?: OllamaEvent }> = [];
  const service = createWebSearchService({
    config: { searxngUrl: 'http://127.0.0.1:1', searchTimeoutMs: 1000, maxSources: 4 },
    fetchImpl: (async (url: string) => {
      searches.push(String(url));
      return new Response(JSON.stringify({ results: options.results ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never,
    fetchPage: async (url) => ({ url, status: 200, contentType: 'text/html', text: options.pages?.[url] ?? '<p></p>', truncated: false }),
    ollama: {
      enabled: options.ollamaEnabled ?? true,
      budgetChars: 18_000,
      ensureOnline: async () => { if (options.offline) throw new AppError('Local LLM offline', { code: 'OLLAMA_OFFLINE', statusCode: 503 }); },
      streamChat: (async (request: { messages: any[]; think?: boolean; model?: string; preamble?: OllamaEvent }, emit: (e: OllamaEvent) => void) => {
        chats.push(request);
        if (request.preamble) emit(request.preamble);
        emit({ type: 'status', state: 'generating' });
        emit({ type: 'text', text: 'Answer [1].' });
        emit({ type: 'done' });
      }) as never,
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/s', createWebSearchRouter(service, async () => options.searchOnline ?? true));
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`;
  closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { url, post, searches, chats };
}

const longPage = (word: string) => `<title>${word} page</title><article><p>${`${word} is explained at length here. `.repeat(20)}</p></article>`;

test('status says whether search is up and whether cited answers are available', async () => {
  const t = await setup({ searchOnline: false, ollamaEnabled: false });
  assert.deepEqual(await json(await fetch(`${t.url}/status`)), { search: 'offline', answers: false });
});

test('GET / searches, and bad or secret-looking queries are refused with the structured error', async () => {
  const t = await setup({ results: [{ title: 'A', url: 'https://example.com/a', snippet: 's', engines: [] }] as never });
  const ok = await json(await fetch(`${t.url}/?q=hello&limit=3&category=it&time_range=week`));
  assert.equal(ok.results.length, 1);
  assert.equal((await fetch(`${t.url}/?q=`)).status, 400);
  const secret = await fetch(`${t.url}/?q=${encodeURIComponent('ghp_abcdefghijklmnopqrstuvwxyz0123456789')}`);
  assert.equal(secret.status, 422);
  assert.equal((await json(secret)).error.code, 'WEB_SEARCH_SECRETS_REFUSED');
  assert.equal(t.searches.length, 1, 'only the valid search reached the engine');
});

test('POST /read refuses private and local addresses (the real guard, not a stub)', async () => {
  const { fetchPage } = createPageFetcher();
  const service = createWebSearchService({ config: { searxngUrl: 'http://127.0.0.1:1', searchTimeoutMs: 1000, maxSources: 4 }, fetchPage });
  const app = express();
  app.use(express.json());
  app.use('/s', createWebSearchRouter(service, async () => true));
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`;
  for (const target of ['http://127.0.0.1:3001/api/auth', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.6:9443/', 'file:///etc/passwd', 'http://localhost:11434/']) {
    const response = await fetch(`${url}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) });
    assert.ok([400].includes(response.status), `${target} -> ${response.status}`);
    assert.match((await json(response)).error.code, /^WEB_URL_/);
  }
});

test('a cited answer reads the pages, streams the local model, and says which sources it used', async () => {
  const results = ['a', 'b', 'c'].map((n) => ({ title: `Result ${n}`, url: `https://${n}.example/page`, snippet: '', engines: [] }));
  const t = await setup({ results: results as never, pages: { 'https://a.example/page': longPage('alpha'), 'https://b.example/page': longPage('beta'), 'https://c.example/page': '<p>tiny</p>' } });
  const response = await t.post('/answer', { query: 'what is alpha', sources: 3, think: true, model: 'qwen3:8b' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = frames(await response.text());
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].task, 'web-answer');
  assert.equal(events[0].draft, true);
  assert.deepEqual(events[0].sources.map((s: any) => [s.n, s.url]), [[1, 'https://a.example/page'], [2, 'https://b.example/page']], 'the page too short to use is left out');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Answer [1].');
  const sent = t.chats[0];
  assert.equal(sent.think, true);
  assert.equal(sent.model, 'qwen3:8b');
  assert.match(sent.messages[1].content, /<source id="1"/);
  assert.match(sent.messages[1].content, /alpha is explained/);
  assert.ok(sent.messages[1].content.endsWith('Question: what is alpha'));
  assert.equal('tools' in sent, false);
});

test('an answer is refused cleanly when the model is not set up, is offline, the query is a secret, or nothing readable came back', async () => {
  const off = await setup({ ollamaEnabled: false });
  const notSetUp = await off.post('/answer', { query: 'hello' });
  assert.equal(notSetUp.status, 409);
  assert.equal((await json(notSetUp)).error.code, 'WEB_ANSWER_NEEDS_LOCAL_MODEL');

  const offline = await setup({ offline: true });
  const down = await offline.post('/answer', { query: 'hello' });
  assert.equal(down.status, 503);
  assert.deepEqual((await json(down)).error, { code: 'OLLAMA_OFFLINE', message: 'Local LLM offline' });
  assert.equal(offline.searches.length, 0, 'no searching or fetching while the model is offline');

  const secret = await setup();
  assert.equal((await secret.post('/answer', { query: 'DATABASE_PASSWORD=hunter2hunter2' })).status, 422);
  assert.equal(secret.searches.length, 0);

  const empty = await setup({ results: [{ title: 'x', url: 'https://x.example/', snippet: '', engines: [] }] as never });
  const none = await empty.post('/answer', { query: 'hello' });
  assert.equal(none.status, 422);
  assert.equal((await json(none)).error.code, 'WEB_ANSWER_NO_SOURCES');
  assert.equal(empty.chats.length, 0, 'the model is not asked without sources');
});
