import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgyChatService, type AgyChatEvent, type AgyProcess } from '../agy-chat.service.js';

type Row = { chat_id: string; project_path: string; title: string; model: string | null; agy_conversation_id: string | null; created_at: number; updated_at: number };

const CONVO = 'c0ffee00-0000-4000-8000-000000000001';
const ev = (o: unknown) => `${JSON.stringify(o)}\n`;
const initLine = ev({ event: 'init', conversation_id: CONVO, init: { model: 'gemini-3.8-flash-low', cwd: '/work/app' } });
const textLine = (t: string) => ev({ event: 'step_update', step_update: { conversation_id: CONVO, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: t } });
const toolRun = ev({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } });
const toolDone = ev({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a\nb\n' } } });
const usageLine = ev({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 3 } } });
const resultLine = ev({ event: 'result', result: { conversation_id: CONVO, status: 'SUCCESS', response: 'x' } });

function setup(options: { chunks?: string[]; exitCode?: number | null; stderr?: string; hang?: boolean; allowFullAccess?: boolean } = {}) {
  const chats = new Map<string, Row>();
  const messages: { chat_id: string; role: string; content: string }[] = [];
  const spawned: { args: string[]; cwd: string }[] = [];
  let killed = 0;
  const audits: string[] = [];
  let ids = 0;
  const service = createAgyChatService({
    allowFullAccess: options.allowFullAccess,
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
    spawnAgy: (args, cwd): AgyProcess => {
      spawned.push({ args, cwd });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      return {
        stdout: (async function* () {
          for (const chunk of options.chunks ?? []) yield chunk;
          if (options.hang) await gate;
        })(),
        exited: options.hang ? gate.then(() => null) : Promise.resolve(options.exitCode ?? 0),
        stderrText: () => options.stderr ?? '',
        kill: () => { killed += 1; release(); },
      };
    },
  });
  return { service, chats, messages, spawned, audits, killed: () => killed };
}

const collect = () => { const events: AgyChatEvent[] = []; return { events, emit: (e: AgyChatEvent) => { events.push(e); } }; };

test('a turn streams text and tool steps, saves them in order, and remembers the agy conversation', async () => {
  const { service, messages, spawned, chats } = setup({ chunks: [initLine, textLine('Hel'), textLine('lo'), toolRun, toolDone, textLine(' done'), usageLine, resultLine] });
  const { chat } = { chat: await service.createChat({ projectId: 'p1' }) };
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'hi there' }, emit);

  assert.ok(spawned[0].args[0].startsWith('-p=[Console note:') && spawned[0].args[0].endsWith('\n\nhi there'), 'the prompt is the no-shell note plus exactly what was typed');
  assert.equal(spawned[0].args[1], '--output-format');
  assert.equal(spawned[0].cwd, '/work/app');
  assert.ok(!spawned[0].args.includes('--conversation'));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text), ['Hel', 'lo', ' done']);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => (e as { state: string }).state), ['running', 'done']);
  assert.deepEqual(events.at(-1), { type: 'done', status: 'SUCCESS' });
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(JSON.parse(messages[1].content).text, 'Hello');
  assert.equal(chats.get(chat.chatId)!.agy_conversation_id, CONVO);
  assert.equal(chats.get(chat.chatId)!.title, 'hi there');
});

test('the second message resumes the same agy conversation and passes the model and mode', async () => {
  const { service, spawned } = setup({ chunks: [initLine, textLine('ok'), resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: 'one' }, () => undefined);
  await service.sendMessage(chat.chatId, { text: 'two', model: 'claude-sonnet-5-5-medium', mode: 'auto' }, () => undefined);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--mode') + 1], 'accept-edits', 'the default is the safe mode, never agy\'s own default');
  assert.deepEqual(spawned[1].args.slice(spawned[1].args.indexOf('--conversation'), spawned[1].args.indexOf('--conversation') + 2), ['--conversation', CONVO]);
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--mode') + 1], 'auto');
  assert.ok(!spawned.some((entry) => entry.args.includes('--dangerously-skip-permissions')), 'the blanket skip flag is never used');
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--model') + 1], 'claude-sonnet-5-5-medium');
});

test('events split across stdout chunks are reassembled', async () => {
  const line = textLine('split');
  const { service } = setup({ chunks: [initLine.slice(0, 20), initLine.slice(20) + line.slice(0, 15), line.slice(15), resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: 'split' }]);
});

test('a failing agy reports its first stderr line and saves it', async () => {
  const { service, messages } = setup({ chunks: [], exitCode: 1, stderr: '\nQuota exceeded for model\nmore' });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  assert.deepEqual(events, [{ type: 'error', message: 'Quota exceeded for model' }, { type: 'done', status: 'ERROR' }]);
  assert.equal(messages.at(-1)!.role, 'error');
});

test('only one turn at a time per chat, and Stop kills agy and keeps what streamed', async () => {
  const { service, killed } = setup({ chunks: [initLine, textLine('partial')], hang: true });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  const first = service.sendMessage(chat.chatId, { text: 'long task' }, emit);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(service.sendMessage(chat.chatId, { text: 'again' }, () => undefined), { code: 'AGY_CHAT_BUSY' });
  assert.deepEqual(service.stop(chat.chatId), { stopped: true });
  await first;
  assert.equal(killed(), 1);
  assert.deepEqual(events.at(-1), { type: 'done', status: 'STOPPED' });
  assert.equal(service.getChat(chat.chatId).messages.at(-1)?.role, 'assistant');
  assert.equal(service.getChat(chat.chatId).running, false);
});

test('aborting the stream (browser closed) stops agy', async () => {
  const { service, killed } = setup({ chunks: [initLine], hang: true });
  const chat = await service.createChat({ projectId: 'p1' });
  const controller = new AbortController();
  const turn = service.sendMessage(chat.chatId, { text: 'x' }, () => undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await turn;
  assert.equal(killed(), 1);
});

test('input validation: project, chat id, empty or huge messages, bad model ids', async () => {
  const { service, spawned } = setup();
  await assert.rejects(service.createChat({ projectId: 'nope' }), { code: 'AGY_PROJECT_UNKNOWN' });
  await assert.rejects(service.createChat({ projectId: 42 }), { code: 'AGY_PROJECT_REQUIRED' });
  await assert.rejects(service.createChat({ projectId: 'p1', model: '--dangerously-skip-permissions' }), { code: 'AGY_MODEL_INVALID' });
  assert.throws(() => service.getChat('../../etc/passwd'), { code: 'AGY_CHAT_INVALID' });
  assert.throws(() => service.getChat('00000000-0000-4000-8000-0000000000ff'), { code: 'AGY_CHAT_NOT_FOUND' });
  const chat = await service.createChat({ projectId: 'p1' });
  await assert.rejects(service.sendMessage(chat.chatId, { text: '   ' }, () => undefined), { code: 'AGY_MESSAGE_REQUIRED' });
  await assert.rejects(service.sendMessage(chat.chatId, { text: 'x'.repeat(20_001) }, () => undefined), { code: 'AGY_MESSAGE_TOO_LONG' });
  await assert.rejects(service.sendMessage(chat.chatId, { text: 'x', model: 'a b; rm -rf /' }, () => undefined), { code: 'AGY_MODEL_INVALID' });
  assert.equal(spawned.length, 0);
});

test('a message that looks like a flag is passed as the prompt, not as an option', async () => {
  const { service, spawned } = setup({ chunks: [resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: '--dangerously-skip-permissions' }, () => undefined);
  assert.ok(spawned[0].args[0].startsWith('-p=') && spawned[0].args[0].endsWith('--dangerously-skip-permissions'));
  assert.ok(!spawned[0].args.slice(1).includes('--dangerously-skip-permissions'));
});

test('chats are listed per project and can be deleted', async () => {
  const { service } = setup();
  const a = await service.createChat({ projectId: 'p1' });
  await service.createChat({ projectId: 'p1' });
  assert.equal((await service.listChats('p1')).length, 2);
  assert.deepEqual(service.deleteChat(a.chatId), { deleted: true });
  assert.equal((await service.listChats('p1')).length, 1);
});

test('only the three known modes are accepted, and plan is passed through', async () => {
  const { service, spawned } = setup({ chunks: [resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  for (const bad of ['yolo', '--dangerously-skip-permissions', 'AUTO', 7]) {
    await assert.rejects(service.sendMessage(chat.chatId, { text: 'x', mode: bad as never }, () => undefined), { code: 'AGY_MODE_INVALID' }, String(bad));
  }
  assert.equal(spawned.length, 0);
  await service.sendMessage(chat.chatId, { text: 'x', mode: 'plan' }, () => undefined);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--mode') + 1], 'plan');
});

test('a malformed conversation id from agy is never stored or passed back', async () => {
  const bad = ev({ event: 'init', conversation_id: '../../etc; rm -rf', init: { model: 'm' } });
  const { service, spawned, chats } = setup({ chunks: [bad, textLine('ok'), resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: 'one' }, () => undefined);
  assert.equal(chats.get(chat.chatId)!.agy_conversation_id, null);
  await service.sendMessage(chat.chatId, { text: 'two' }, () => undefined);
  assert.ok(!spawned[1].args.includes('--conversation'));
});

test('a denied tool is reported with agy\'s own hint instead of a silent empty reply', async () => {
  const { service } = setup({ chunks: [initLine, resultLine], stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.' });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'run it' }, emit);
  assert.equal(events.find((e) => e.type === 'error')?.type, 'error');
  assert.deepEqual(events.at(-1), { type: 'done', status: 'DENIED' });
});

test('stored text and tool parameters are bounded', async () => {
  const huge = 'x'.repeat(300_000);
  const bigTool = ev({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Content: huge } } } });
  const { service, messages } = setup({ chunks: [initLine, textLine(huge), bigTool, resultLine] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: 'x' }, () => undefined);
  for (const m of messages) assert.ok(m.content.length < 210_000, `${m.role} is ${m.content.length} bytes`);
  assert.ok(messages.find((m) => m.role === 'tool')!.content.length < 6_000);
});

test('too many chats answering at once are refused', async () => {
  const { service } = setup({ chunks: [initLine], hang: true });
  const chats = await Promise.all([1, 2, 3, 4, 5].map(() => service.createChat({ projectId: 'p1' })));
  const turns = chats.slice(0, 4).map((c) => service.sendMessage(c.chatId, { text: 'x' }, () => undefined));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(service.sendMessage(chats[4].chatId, { text: 'x' }, () => undefined), { code: 'AGY_TOO_MANY' });
  for (const c of chats.slice(0, 4)) service.stop(c.chatId);
  await Promise.all(turns);
});

test('a denied command is reported even though agy marks the tool step done and exits 0', async () => {
  const { service } = setup({ chunks: [initLine, toolRun, toolDone, resultLine], stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule' });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'run it' }, emit);
  assert.ok(events.some((e) => e.type === 'error' && /auto-denied/.test(e.message)));
  assert.deepEqual(events.at(-1), { type: 'done', status: 'DENIED' });
});

const resultWith = (response: string) => ev({ event: 'result', result: { conversation_id: CONVO, status: 'SUCCESS', response } });

test('when nothing was streamed, the closing result text is shown and saved as the reply', async () => {
  const { service, messages } = setup({ chunks: [initLine, toolRun, toolDone, resultWith('Here is the summary.')] });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: 'Here is the summary.' }]);
  assert.equal(messages.at(-1)!.role, 'assistant');
  assert.equal(JSON.parse(messages.at(-1)!.content).text, 'Here is the summary.');
});

test('streamed text is not duplicated by the closing result text', async () => {
  const { service } = setup({ chunks: [initLine, textLine('Answer'), resultWith('Answer')] });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  assert.equal(events.filter((e) => e.type === 'text').length, 1);
});

test('a turn that produced no reply at all says so instead of ending silently', async () => {
  const { service, messages } = setup({ chunks: [initLine, toolRun, toolDone, resultWith('')] });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  const notice = events.find((e) => e.type === 'notice') as { message: string } | undefined;
  assert.match(notice?.message ?? '', /ran 1 step but wrote no reply/);
  assert.ok(messages.some((m) => m.role === 'notice'));
  assert.deepEqual(events.at(-1), { type: 'done', status: 'SUCCESS' });
});

test('a permission denial reports the denial once, not an extra "no reply" notice', async () => {
  const { service } = setup({ chunks: [initLine, resultWith('')], stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.' });
  const chat = await service.createChat({ projectId: 'p1' });
  const { events, emit } = collect();
  await service.sendMessage(chat.chatId, { text: 'x' }, emit);
  assert.ok(!events.some((e) => e.type === 'notice'));
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
});

test('the default mode is accept-edits, full access is audited, and it can be switched off server-side', async () => {
  const { service, spawned, audits } = setup({ chunks: [resultWith('ok')] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: 'a' }, () => undefined);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(audits.length, 0);
  await service.sendMessage(chat.chatId, { text: 'b', mode: 'auto' }, () => undefined);
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--mode') + 1], 'auto');
  assert.equal(audits.length, 1);
  assert.ok(!audits[0].includes('b'), 'the audit line never carries message text');

  const locked = setup({ chunks: [resultWith('ok')], allowFullAccess: false });
  const lockedChat = await locked.service.createChat({ projectId: 'p1' });
  await assert.rejects(locked.service.sendMessage(lockedChat.chatId, { text: 'c', mode: 'auto' }, () => undefined), { code: 'AGY_FULL_ACCESS_DISABLED' });
  assert.equal(locked.spawned.length, 0);
});

test('the no-shell note is added in plan and edit modes but not in full access, and is never saved as the user message', async () => {
  const { service, spawned, messages } = setup({ chunks: [resultWith('ok')] });
  const chat = await service.createChat({ projectId: 'p1' });
  await service.sendMessage(chat.chatId, { text: 'edit mode', mode: 'accept-edits' }, () => undefined);
  await service.sendMessage(chat.chatId, { text: 'plan mode', mode: 'plan' }, () => undefined);
  await service.sendMessage(chat.chatId, { text: 'full mode', mode: 'auto' }, () => undefined);
  assert.match(spawned[0].args[0], /Console note/);
  assert.match(spawned[1].args[0], /Console note/);
  assert.equal(spawned[2].args[0], '-p=full mode');
  assert.deepEqual(messages.filter((m) => m.role === 'user').map((m) => JSON.parse(m.content).text), ['edit mode', 'plan mode', 'full mode']);
});
