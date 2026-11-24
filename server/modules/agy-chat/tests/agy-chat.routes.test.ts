import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

import express from 'express';

import { createAgyChatRouter } from '../agy-chat.routes.js';
import { createAgyChatService, type AgyProcess } from '../agy-chat.service.js';

type Row = { chat_id: string; project_path: string; title: string; model: string | null; agy_conversation_id: string | null; created_at: number; updated_at: number };

const CONVO = 'c0ffee00-0000-4000-8000-000000000002';
const ev = (o: unknown) => `${JSON.stringify(o)}\n`;
const init = ev({ event: 'init', conversation_id: CONVO, init: { model: 'm', cwd: '/work/app' } });
const text = (t: string) => ev({ event: 'step_update', step_update: { conversation_id: CONVO, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: t } });
const result = ev({ event: 'result', result: { conversation_id: CONVO, status: 'SUCCESS', response: 'x' } });

const closers: Array<() => Promise<void>> = [];
after(async () => { await Promise.all(closers.map((close) => close().catch(() => undefined))); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (response: Response): Promise<any> => response.json();

/** A fake agy whose output is driven by the test: `script` yields chunks, optionally waiting between them. */
async function setup(script: () => AsyncGenerator<string>) {
  const chats = new Map<string, Row>();
  const messages: Array<{ chat_id: string; role: string; content: string }> = [];
  const finished: Array<{ status: string; chatId: string }> = [];
  const audits: string[] = [];
  let killed = 0;
  let ids = 0;
  const service = createAgyChatService({
    audit: (m) => { audits.push(m); },
    store: {
      insertChat: (row) => { chats.set(row.chat_id, { ...row }); },
      getChat: (id) => chats.get(id),
      listChats: (p) => [...chats.values()].filter((c) => c.project_path === p),
      updateChat: (id, fields) => { Object.assign(chats.get(id)!, fields); },
      deleteChat: (id) => chats.delete(id),
      insertMessage: (chat_id, role, content) => { messages.push({ chat_id, role, content }); },
      listMessages: (id) => messages.filter((m) => m.chat_id === id).map((m, i) => ({ message_id: i + 1, role: m.role, content: m.content, created_at: 0 })),
    },
    resolveProjectDir: async (id) => (id === 'p1' ? '/work/app' : null),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => 1000,
    spawnAgy: (): AgyProcess => {
      // A fake process: its output comes from the test's script, it "exits" (code 0) when the output ends, or (null) when killed.
      let exit: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((resolve) => { exit = resolve; });
      let killedFlag = false;
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => { stop = resolve; });
      const generator = script();
      return {
        stdout: (async function* () {
          for (;;) {
            const next = await Promise.race([generator.next(), stopped.then(() => ({ done: true as const, value: undefined }))]);
            if (next.done) { exit(killedFlag ? null : 0); return; }
            yield next.value as string;
          }
        })(),
        exited,
        stderrText: () => '',
        kill: () => { killed += 1; killedFlag = true; stop(); exit(null); },
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: { id: number } }).user = { id: 1 }; next(); }); // the real server sets this from the passkey session
  app.use('/chat', createAgyChatRouter(service, async () => ['m'], async () => [], (turn) => { finished.push({ status: turn.status, chatId: turn.chatId }); }));
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
  const chat = await service.createChat({ projectId: 'p1' });
  return { url, chatId: chat.chatId, messages, finished, audits, killed: () => killed, service };
}

test('a browser that disconnects mid-turn does NOT kill the turn: the reply is still saved and the notification still fires', async () => {
  const t = await setup(async function* () {
    yield init;
    yield text('Hello');
    await sleep(300); // the browser is long gone by now
    yield text(' world');
    yield result;
  });
  const controller = new AbortController();
  const response = await fetch(`${t.url}/${t.chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }), signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read(); // the first frame arrives...
  controller.abort(); // ...then the tab is closed
  await reader.cancel().catch(() => undefined);

  await sleep(700);
  assert.equal(t.killed(), 0, 'the agy process must not be killed by a disconnect');
  const saved = t.messages.filter((m) => m.role === 'assistant').map((m) => JSON.parse(m.content).text).join('');
  assert.equal(saved, 'Hello world', 'the whole reply is saved');
  assert.deepEqual(t.finished.map((f) => f.status), ['SUCCESS'], 'the finished-turn notification still fires');
  assert.equal((await json(await fetch(`${t.url}/${t.chatId}`))).running, false);
  assert.equal(t.audits.some((line) => /stopped/.test(line)), false);
});

test('while a turn is running the chat says so, so a reloaded page can wait for it', async () => {
  const t = await setup(async function* () {
    yield init;
    await sleep(400);
    yield text('late reply');
    yield result;
  });
  const controller = new AbortController();
  void fetch(`${t.url}/${t.chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }), signal: controller.signal }).catch(() => undefined);
  await sleep(100);
  controller.abort(); // the page is reloaded
  assert.equal((await json(await fetch(`${t.url}/${t.chatId}`))).running, true);
  await sleep(700);
  const after = await json(await fetch(`${t.url}/${t.chatId}`));
  assert.equal(after.running, false);
  assert.ok(after.messages.some((m: any) => m.role === 'assistant' && m.content.text === 'late reply'), 'the reply is there when the page looks again');
});

test('only the Stop request cancels a turn, and it says so in the log', async () => {
  const t = await setup(async function* () {
    yield init;
    yield text('working');
    await sleep(5000); // never finishes on its own
    yield result;
  });
  const sent = fetch(`${t.url}/${t.chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'go' }) }).then((r) => r.text()).catch(() => '');
  await sleep(150);
  assert.deepEqual(await json(await fetch(`${t.url}/${t.chatId}/stop`, { method: 'POST' })), { stopped: true });
  const body = await sent;
  assert.match(body, /"status":"STOPPED"/);
  assert.equal(t.killed(), 1);
  assert.ok(t.audits.some((line) => /turn stopped \(chat 00000000, 1 saved part\)/.test(line)));
  assert.deepEqual(t.finished.map((f) => f.status), ['STOPPED']);
});

test('a connected browser still gets the live stream', async () => {
  const t = await setup(async function* () { yield init; yield text('streamed'); yield result; });
  const response = await fetch(`${t.url}/${t.chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"type":"text","text":"streamed"/);
  assert.match(body, /"type":"done","status":"SUCCESS"/);
});
