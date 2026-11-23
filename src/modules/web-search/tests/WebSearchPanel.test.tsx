import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import WebSearchPanel from '@/modules/web-search/WebSearchPanel';

const mocks = vi.hoisted(() => ({ status: vi.fn(), search: vi.fn(), read: vi.fn(), answer: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: { ...original.api, webSearch: { status: mocks.status, search: mocks.search, read: mocks.read, answer: mocks.answer } } };
});
vi.mock('@/modules/chat', () => ({ Markdown: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div> }));
vi.mock('@/modules/agy-chat', () => ({ blockRemoteImages: (text: string) => text }));

const ok = (body: object) => Response.json(body);
const fail = (status: number, code: string, message: string) => Response.json({ success: false, error: { code, message } }, { status });
const sse = (events: object[]) => new Response(new ReadableStream({
  start(controller) { const encoder = new TextEncoder(); for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const RESULTS = [
  { title: 'MCP docs', url: 'https://modelcontextprotocol.io/intro', snippet: 'The Model Context Protocol.', engines: ['brave', 'duckduckgo'], published: '2026-11-01' },
  { title: 'Intro to MCP', url: 'https://www.example.org/mcp', snippet: 'A guide.', engines: ['duckduckgo'] },
];
const type = (text: string) => fireEvent.change(screen.getByLabelText('Search'), { target: { value: text } });

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(ok({ search: 'online', answers: true }));
  mocks.search.mockReset().mockResolvedValue(ok({ query: 'mcp', results: RESULTS }));
  mocks.read.mockReset();
  mocks.answer.mockReset();
});

test('shows the search service as online and the local-model answer button as available', async () => {
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('mcp');
  assert.equal((screen.getByRole('button', { name: /Answer with sources/ }) as HTMLButtonElement).disabled, false);
});

test('when the search service is down it says how to start it and does not allow searching', async () => {
  mocks.status.mockResolvedValue(ok({ search: 'offline', answers: false }));
  render(<WebSearchPanel />);
  await screen.findByText('Search service not running');
  assert.match(screen.getByRole('alert').textContent ?? '', /scripts\/install-searxng\.sh/);
  type('mcp');
  assert.equal((screen.getByRole('button', { name: /^Search$/ }) as HTMLButtonElement).disabled, true);
});

test('searching lists results with safe external links, the site, the date and the engines', async () => {
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('mcp');
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  const link = await screen.findByRole('link', { name: /MCP docs/ });
  assert.equal(link.getAttribute('href'), 'https://modelcontextprotocol.io/intro');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel') ?? '', /noopener/);
  assert.match(link.getAttribute('rel') ?? '', /noreferrer/);
  assert.ok(screen.getByText(/modelcontextprotocol\.io · 2026-11-01 · brave, duckduckgo/));
  assert.ok(screen.getByText('2 results for “mcp”'));
  assert.deepEqual(mocks.search.mock.calls[0], ['mcp', { limit: 10, category: 'general', timeRange: undefined }]);
});

test('the kind of search and the time range are passed on', async () => {
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('react hooks');
  fireEvent.change(screen.getByLabelText('Kind of search'), { target: { value: 'it' } });
  fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'week' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  await waitFor(() => assert.equal(mocks.search.mock.calls.length, 1));
  assert.deepEqual(mocks.search.mock.calls[0], ['react hooks', { limit: 10, category: 'it', timeRange: 'week' }]);
});

test('a refused or failed search shows the server message and no stale results', async () => {
  mocks.search.mockResolvedValue(fail(422, 'WEB_SEARCH_SECRETS_REFUSED', 'Not searched: this looks like it contains a GitHub token.'));
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('ghp_x');
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  await screen.findByText(/Not searched: this looks like it contains a GitHub token/);
  assert.equal(screen.queryByLabelText('Results'), null);
});

test('previewing a result shows its cleaned text, and a second click hides it; a failure is shown on that result', async () => {
  mocks.read.mockResolvedValueOnce(ok({ title: 'MCP docs', text: 'Clean page text here.' })).mockResolvedValueOnce(fail(400, 'WEB_URL_BLOCKED', 'That address is on a private network, so it is not read.'));
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('mcp');
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  await screen.findByRole('link', { name: /MCP docs/ });
  const [first, second] = screen.getAllByRole('button', { name: /Preview text/ });
  fireEvent.click(first);
  await screen.findByText('Clean page text here.');
  assert.deepEqual(mocks.read.mock.calls[0], ['https://modelcontextprotocol.io/intro']);
  fireEvent.click(screen.getByRole('button', { name: /Hide preview/ }));
  assert.equal(screen.queryByText('Clean page text here.'), null);
  fireEvent.click(second);
  await screen.findByText(/private network/);
});

test('without the local model the answer button is disabled and explains why', async () => {
  mocks.status.mockResolvedValue(ok({ search: 'online', answers: false }));
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('mcp');
  const button = screen.getByRole('button', { name: /Answer with sources/ }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.match(button.title, /local model/i);
});

test('a cited answer streams in, marks itself a draft, links every [n] to its source and lists the sources', async () => {
  mocks.answer.mockResolvedValue(sse([
    { type: 'meta', task: 'web-answer', draft: true, sources: [{ n: 1, title: 'MCP docs', url: 'https://modelcontextprotocol.io/intro' }, { n: 2, title: 'Intro to MCP', url: 'https://www.example.org/mcp' }] },
    { type: 'status', state: 'generating' },
    { type: 'text', text: 'MCP connects apps to tools [1]' },
    { type: 'text', text: ' over JSON-RPC [2].' },
    { type: 'done' },
  ]));
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('what is mcp');
  fireEvent.click(screen.getByRole('button', { name: /Answer with sources/ }));
  const markdown = await screen.findByTestId('markdown');
  await waitFor(() => assert.equal(markdown.textContent, 'MCP connects apps to tools [[1]](https://modelcontextprotocol.io/intro) over JSON-RPC [[2]](https://www.example.org/mcp).'));
  assert.ok(screen.getByText('Draft'));
  const sourceLinks = screen.getAllByRole('link');
  assert.deepEqual(sourceLinks.map((a) => a.getAttribute('href')), ['https://modelcontextprotocol.io/intro', 'https://www.example.org/mcp']);
  assert.ok(screen.getByRole('button', { name: 'Copy answer' }));
  assert.deepEqual(mocks.answer.mock.calls[0][0], { query: 'what is mcp', sources: 4 });
  await waitFor(() => assert.equal(screen.queryByRole('status', { name: '' }) && screen.queryByText(/Writing the answer/), null));
});

test('an answer that cannot be produced (model offline, no sources) shows the server message', async () => {
  mocks.answer.mockResolvedValue(fail(503, 'OLLAMA_OFFLINE', 'Local LLM offline'));
  render(<WebSearchPanel />);
  await screen.findByText('Private search online');
  type('mcp');
  fireEvent.click(screen.getByRole('button', { name: /Answer with sources/ }));
  await screen.findByText('Local LLM offline');
  assert.equal(screen.queryByText('Draft') === null, false, 'the answer card is shown with its error');
});
