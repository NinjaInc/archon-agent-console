import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

import AgyChatPanel from '@/modules/agy-chat/AgyChatPanel';
import type * as ApiModule from '@/shared/api';
import type { Project } from '@/shared/types';

const mocks = vi.hoisted(() => ({ models: vi.fn(), list: vi.fn(), get: vi.fn(), send: vi.fn(), stop: vi.fn(), create: vi.fn(), remove: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: { ...original.api, agyChat: { models: mocks.models, list: mocks.list, get: mocks.get, send: mocks.send, stop: mocks.stop, create: mocks.create, remove: mocks.remove } } };
});
vi.mock('@/modules/chat', () => ({ Markdown: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/agy-chat/AgyAllowedCommands', () => ({ default: () => null }));

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/work/demo' } as unknown as Project;
const ok = (body: object) => Response.json(body);
const chat = { chatId: 'c1', title: 'Review the site', model: 'gemini-flash-medium', updatedAt: 1 };
const userMessage = { id: 1, role: 'user', content: { text: 'make me a logo' } };
const assistantMessage = { id: 2, role: 'assistant', content: { text: 'Here is the logo plan.' } };
const type = (text: string) => fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.models.mockResolvedValue(ok({ models: ['gemini-flash-medium'] }));
  mocks.list.mockResolvedValue(ok({ chats: [chat] }));
  mocks.stop.mockResolvedValue(ok({ stopped: true }));
});

test('opening a chat the server is still working on shows that, blocks a second send, and shows the reply when it lands', async () => {
  mocks.get
    .mockResolvedValueOnce(ok({ chat, messages: [userMessage], running: true })) // opening the chat
    .mockResolvedValue(ok({ chat, messages: [userMessage, assistantMessage], running: false })); // the next poll
  render(<AgyChatPanel selectedProject={project} />);
  await screen.findByText(/still working on your last message/);
  type('another thing');
  assert.ok(screen.getByRole('button', { name: 'Stop' }), 'a running turn offers Stop, not Send');
  assert.equal(screen.queryByRole('button', { name: 'Send' }), null);
  await screen.findByText('Here is the logo plan.', undefined, { timeout: 8000 });
  await waitFor(() => assert.equal(screen.queryByText(/still working on your last message/), null));
  assert.ok(screen.getByRole('button', { name: 'Send' }));
}, 15000);

test('a connection that drops while sending is not reported as a failure when the server is still working; the reply appears later', async () => {
  mocks.get
    .mockResolvedValueOnce(ok({ chat, messages: [], running: false })) // opening the chat
    .mockResolvedValueOnce(ok({ chat, messages: [userMessage], running: true })) // the check after the drop
    .mockResolvedValue(ok({ chat, messages: [userMessage, assistantMessage], running: false })); // the poll
  mocks.send.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<AgyChatPanel selectedProject={project} />);
  await screen.findByLabelText('Message');
  await waitFor(() => assert.equal(mocks.get.mock.calls.length, 1));
  type('make me a logo');
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  await screen.findByText(/still working on your last message/);
  assert.equal(screen.queryByRole('alert'), null, 'no error banner for a drop the server survived');
  await screen.findByText('Here is the logo plan.', undefined, { timeout: 8000 });
}, 15000);

test('a drop after which the server is NOT working is still reported, and a server refusal is shown as the refusal', async () => {
  mocks.get.mockResolvedValue(ok({ chat, messages: [], running: false }));
  mocks.send.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(Response.json({ success: false, error: { code: 'AGY_CHAT_BUSY', message: 'This chat is already answering' } }, { status: 409 }));
  render(<AgyChatPanel selectedProject={project} />);
  await screen.findByLabelText('Message');
  await waitFor(() => assert.equal(mocks.get.mock.calls.length, 1));
  type('first');
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  await screen.findByText(/Failed to fetch/);
  assert.equal(screen.queryByText(/still working on your last message/), null);
  type('second');
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  await screen.findByText('This chat is already answering');
  assert.equal(screen.queryByText(/still working on your last message/), null, 'a refusal is not a running turn');
});

test('Stop on a turn the page is only waiting for asks the server to cancel it', async () => {
  mocks.get.mockResolvedValue(ok({ chat, messages: [userMessage], running: true }));
  render(<AgyChatPanel selectedProject={project} />);
  await screen.findByText(/still working on your last message/);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.deepEqual(mocks.stop.mock.calls[0], ['c1']);
});
