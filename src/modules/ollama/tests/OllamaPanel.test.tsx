import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

import OllamaPanel from '@/modules/ollama/OllamaPanel';
import type { OllamaStatus } from '@/modules/ollama/hooks/useOllamaStatus';
import type * as ApiModule from '@/shared/api';
import type { Project } from '@/shared/types';

const mocks = vi.hoisted(() => ({ warmup: vi.fn(), chat: vi.fn(), task: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: { ...original.api, ollama: { status: vi.fn(), warmup: mocks.warmup, chat: mocks.chat, task: mocks.task } } };
});
vi.mock('@/modules/chat', () => ({ Markdown: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div> }));
vi.mock('@/modules/agy-chat', () => ({ blockRemoteImages: (text: string) => text }));

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/work/demo' } as unknown as Project;
const online = (extra: Partial<OllamaStatus> = {}): OllamaStatus & { refresh: () => Promise<void> } => ({
  configured: true, status: 'online', model: 'qwen3:8b', models: [{ name: 'qwen3:8b', parameterSize: '8.2B' }], numCtx: 8192, checkedAt: 1, refresh: vi.fn(async () => undefined), ...extra,
});

function sse(events: object[], gapMs = 0): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const jsonError = (status: number, code: string, message: string) => Response.json({ success: false, error: { code, message } }, { status });
const type = (text: string) => fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
const enter = () => fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });

beforeEach(() => {
  mocks.warmup.mockReset().mockResolvedValue(Response.json({ ok: true, model: 'qwen3:8b' }));
  mocks.chat.mockReset();
  mocks.task.mockReset();
});

test('online: shows a green status, warms the model up once when the tab opens, and says when it is ready', async () => {
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  assert.ok(screen.getByText('Local LLM online'));
  assert.ok(screen.getByText('8,192-token context'));
  await waitFor(() => assert.equal(mocks.warmup.mock.calls.length, 1));
  assert.deepEqual(mocks.warmup.mock.calls[0], ['qwen3:8b']);
  await screen.findByText('Model loaded and ready.');
});

test('the context choice is fixed: there is no way to pick 32k in the UI', () => {
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  assert.equal(screen.queryByText(/32k|32,768|32768/i), null);
  assert.equal(screen.queryByLabelText(/context/i), null);
});

test('offline: red status, banner, nothing can be sent, and Claude Chat opens only when the user clicks for it', () => {
  const onOpenClaudeChat = vi.fn();
  render(<OllamaPanel selectedProject={project} ollama={online({ status: 'offline', models: [] })} onOpenClaudeChat={onOpenClaudeChat} />);
  assert.ok(screen.getByText('Local LLM offline', { selector: 'span.font-medium' }));
  assert.ok(screen.getByRole('alert'));
  assert.equal((screen.getByLabelText('Send') as HTMLButtonElement).disabled, true);
  for (const label of ['Summarise logs', 'Explain diff', 'Commit message', 'Boilerplate']) assert.equal((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled, true);
  assert.equal(mocks.warmup.mock.calls.length, 0, 'no warm-up against an offline host');
  assert.equal(onOpenClaudeChat.mock.calls.length, 0, 'it must never switch silently');
  fireEvent.click(screen.getByRole('button', { name: 'Use Claude Chat instead' }));
  assert.equal(onOpenClaudeChat.mock.calls.length, 1);
});

test('"Check again" asks the server for a live check', () => {
  const ollama = online({ status: 'offline', models: [] });
  render(<OllamaPanel selectedProject={project} ollama={ollama} onOpenClaudeChat={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
  assert.equal((ollama.refresh as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test('a host that goes offline during a send shows the error and the Claude Chat offer, without switching', async () => {
  const onOpenClaudeChat = vi.fn();
  const ollama = online();
  mocks.chat.mockResolvedValue(jsonError(503, 'OLLAMA_OFFLINE', 'Local LLM offline'));
  render(<OllamaPanel selectedProject={project} ollama={ollama} onOpenClaudeChat={onOpenClaudeChat} />);
  type('why is the build red?');
  enter();
  await screen.findByText('Local LLM offline', { selector: 'div[role="alert"]' });
  assert.ok(screen.getByRole('button', { name: 'Use Claude Chat instead' }));
  assert.equal(onOpenClaudeChat.mock.calls.length, 0);
  await waitFor(() => assert.equal((ollama.refresh as ReturnType<typeof vi.fn>).mock.calls.length >= 1, true));
});

test('cold start: shows the "loading the model" state, then streams the draft with a Draft badge and a copy button', async () => {
  mocks.chat.mockResolvedValue(sse([
    { type: 'meta', draft: true },
    { type: 'status', state: 'loading', message: 'Loading the model into the GPU. The first reply can take up to a minute.' },
    { type: 'status', state: 'generating' },
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    { type: 'usage', inputTokens: 5, outputTokens: 2, tokensPerSecond: 41.5 },
    { type: 'done' },
  ], 40));
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  type('hi');
  enter();
  await screen.findByText(/Loading the model into the GPU/);
  await screen.findByText('Hello there');
  assert.ok(screen.getByText('Draft'));
  assert.ok(screen.getByRole('button', { name: 'Copy draft' }));
  await screen.findByText('41.5 tok/s');
  await waitFor(() => assert.equal(screen.queryByText(/Loading the model into the GPU/), null));
});

test('Thinking is off by default and the toggle is sent with the request', async () => {
  mocks.chat.mockImplementation(async () => sse([{ type: 'meta', draft: true }, { type: 'text', text: 'ok' }, { type: 'done' }]));
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  type('one');
  enter();
  await waitFor(() => assert.equal(mocks.chat.mock.calls.length, 1));
  assert.equal(mocks.chat.mock.calls[0][0].think, false);
  assert.deepEqual(mocks.chat.mock.calls[0][0].messages, [{ role: 'user', content: 'one' }]);
  await screen.findByText('ok');

  fireEvent.click(screen.getByLabelText('Thinking (slower)'));
  type('two');
  enter();
  await waitFor(() => assert.equal(mocks.chat.mock.calls.length, 2));
  assert.equal(mocks.chat.mock.calls[1][0].think, true);
  assert.equal(mocks.chat.mock.calls[1][0].messages.length, 3, 'earlier turns of this chat are sent along');
});

test('slash commands run the task on the selected project; text tasks without text just prepare the input', async () => {
  mocks.task.mockResolvedValue(sse([
    { type: 'meta', task: 'commit-msg', draft: true, included: ['src/a.ts'], excluded: [{ path: 'package-lock.json', reason: 'lockfile' }] },
    { type: 'text', text: 'feat: add a' },
    { type: 'done' },
  ]));
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);

  type('/summarise-logs');
  enter();
  assert.equal(mocks.task.mock.calls.length, 0);
  assert.equal((screen.getByLabelText('Message') as HTMLTextAreaElement).value, '/summarise-logs ');

  type('/commit-msg');
  enter();
  await screen.findByText('feat: add a');
  assert.equal(mocks.task.mock.calls[0][0], 'commit-msg');
  assert.equal(mocks.task.mock.calls[0][1].projectId, 'p1');
  assert.equal(mocks.task.mock.calls[0][1].text, undefined);
  assert.ok(screen.getByText(/package-lock\.json \(lockfile\)/));
  assert.equal(mocks.chat.mock.calls.length, 0, 'a task is not a chat message');
});

test('task results stay out of the chat history sent with later messages', async () => {
  mocks.task.mockResolvedValue(sse([{ type: 'meta', task: 'commit-msg', draft: true }, { type: 'text', text: 'feat: x' }, { type: 'done' }]));
  mocks.chat.mockImplementation(async () => sse([{ type: 'meta', draft: true }, { type: 'text', text: 'fine' }, { type: 'done' }]));
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  type('/commit-msg');
  enter();
  await screen.findByText('feat: x');
  type('a question');
  enter();
  await waitFor(() => assert.equal(mocks.chat.mock.calls.length, 1));
  assert.deepEqual(mocks.chat.mock.calls[0][0].messages, [{ role: 'user', content: 'a question' }]);
});

test('an unknown slash command is a notice, not a request', () => {
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  type('/delete-everything');
  enter();
  assert.ok(screen.getByText(/Unknown command \/delete-everything/));
  assert.equal(mocks.chat.mock.calls.length + mocks.task.mock.calls.length, 0);
});

test('a refusal from the server (secrets, too big) is shown as the error, with nothing streamed', async () => {
  mocks.chat.mockResolvedValue(jsonError(422, 'OLLAMA_SECRETS_REFUSED', 'Not sent: this looks like it contains a GitHub token.'));
  render(<OllamaPanel selectedProject={project} ollama={online()} onOpenClaudeChat={vi.fn()} />);
  type('here is my token');
  enter();
  await screen.findByText(/Not sent: this looks like it contains a GitHub token/);
  assert.equal(screen.queryByText('Draft'), null);
  assert.equal(screen.queryByRole('button', { name: 'Use Claude Chat instead' }), null, 'only an offline host offers the Claude fallback');
});
