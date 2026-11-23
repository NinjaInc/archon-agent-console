import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parseSlashCommand, readEventStream, selectHistory, suggestCommands } from '@/modules/ollama/utils/ollamaChat';
import type { OllamaStreamEvent } from '@/shared/types';

test('slash commands: a known task with and without text, an unknown command, and plain chat', () => {
  assert.deepEqual(parseSlashCommand('/commit-msg'), { kind: 'task', name: 'commit-msg', text: '' });
  assert.deepEqual(parseSlashCommand('/summarise-logs ERROR a\nERROR b'), { kind: 'task', name: 'summarise-logs', text: 'ERROR a\nERROR b' });
  assert.deepEqual(parseSlashCommand('  /Explain-Diff  '), { kind: 'task', name: 'explain-diff', text: '' });
  assert.deepEqual(parseSlashCommand('/rm -rf /'), { kind: 'unknown', command: '/rm' });
  assert.deepEqual(parseSlashCommand('what does /commit-msg do?'), { kind: 'chat' });
  assert.deepEqual(parseSlashCommand('hello'), { kind: 'chat' });
  assert.deepEqual(parseSlashCommand('/usr/bin/env is a path'), { kind: 'chat' }, 'a pasted path is just chat');
});

test('suggestions follow what has been typed and disappear once there is a space', () => {
  assert.deepEqual(suggestCommands('/'), ['/summarise-logs', '/explain-diff', '/commit-msg', '/boilerplate']);
  assert.deepEqual(suggestCommands('/ex'), ['/explain-diff']);
  assert.deepEqual(suggestCommands('/commit-msg '), []);
  assert.deepEqual(suggestCommands('hello'), []);
});

test('history keeps the newest turns that fit, drops the oldest first, and starts on a user turn', () => {
  const items = [
    { role: 'user' as const, text: 'a'.repeat(400) },
    { role: 'assistant' as const, text: 'b'.repeat(400) },
    { role: 'user' as const, text: 'c'.repeat(400) },
    { role: 'assistant' as const, text: 'd'.repeat(400) },
    { role: 'user' as const, text: 'e'.repeat(100) },
  ];
  const all = selectHistory(items, 10_000);
  assert.equal(all.messages.length, 5);
  assert.equal(all.trimmed, false);

  const trimmed = selectHistory(items, 1000);
  assert.equal(trimmed.trimmed, true);
  assert.equal(trimmed.messages[0].role, 'user');
  assert.equal(trimmed.messages.at(-1)?.content, 'e'.repeat(100));
  assert.ok(trimmed.messages.reduce((sum, message) => sum + message.content.length, 0) <= 1000);

  // The newest message is always kept, even when it alone is over the limit (the server then refuses it clearly).
  assert.equal(selectHistory([{ role: 'user', text: 'x'.repeat(5000) }], 100).messages.length, 1);
});

test('the event stream reader delivers each frame as it arrives, even when a frame is split across chunks', async () => {
  const encoder = new TextEncoder();
  const frame = (event: OllamaStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
  const whole = frame({ type: 'meta', draft: true }) + ': ping\n\n' + frame({ type: 'text', text: 'Hel' }) + 'data: {broken json\n\n' + frame({ type: 'text', text: 'lo' }) + frame({ type: 'done' });
  const cut = whole.indexOf('"Hel"') + 2; // inside a frame
  const chunks = [whole.slice(0, cut), whole.slice(cut, cut + 7), whole.slice(cut + 7)];
  const response = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }));
  const events: OllamaStreamEvent[] = [];
  await readEventStream(response, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ['meta', 'text', 'text', 'done']);
  assert.equal(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join(''), 'Hello');
});
