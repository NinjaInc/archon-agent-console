import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { SERVER_INFO, TOOLS, handleMessage, runStdio, type McpDependencies } from '../web-search.mcp.js';

const calls: Array<{ tool: string; args: unknown[] }> = [];
const deps: McpDependencies = {
  search: async (query, options) => {
    calls.push({ tool: 'search', args: [query, options] });
    if (query === 'secret') throw new AppError('Not searched: this looks like it contains a GitHub token.', { code: 'WEB_SEARCH_SECRETS_REFUSED', statusCode: 422 });
    return { query: String(query), results: [{ title: 'MCP docs', url: 'https://modelcontextprotocol.io/', snippet: 'The protocol.', engines: ['brave'], published: '2026-11-01' }], answers: ['42'], unresponsive: [] };
  },
  read: async (url, maxChars) => {
    calls.push({ tool: 'read', args: [url, maxChars] });
    if (String(url).includes('127.0.0.1')) throw new AppError('That address is on a private network, so it is not read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
    return { url: String(url), title: 'A page', text: 'Body text.', truncated: false };
  },
};

const rpc = (method: string, params?: object, id: number | string = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, deps) as Promise<any>;

test('the handshake agrees on a supported protocol version and advertises tools only', async () => {
  const asked = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } });
  assert.equal(asked.result.protocolVersion, '2025-03-26');
  assert.deepEqual(asked.result.capabilities, { tools: {} });
  assert.deepEqual(asked.result.serverInfo, SERVER_INFO);
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), null);
});

test('exactly two tools, both read-only, and their definitions stay small (they are paid for in every chat)', async () => {
  const { result } = await rpc('tools/list');
  assert.deepEqual(result.tools.map((t: any) => t.name), ['web_search', 'web_read']);
  for (const tool of result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.ok(JSON.stringify(TOOLS).length < 2800, `tool definitions are ${JSON.stringify(TOOLS).length} chars`);
});

test('web_search returns numbered results marked as untrusted, and passes clamped options through', async () => {
  calls.length = 0;
  const { result } = await rpc('tools/call', { name: 'web_search', arguments: { query: 'mcp', max_results: 99, category: 'it', time_range: 'week' } });
  const text = result.content[0].text as string;
  assert.equal(result.isError, undefined);
  assert.match(text, /untrusted web content/);
  assert.match(text, /1\. MCP docs\n\s+https:\/\/modelcontextprotocol\.io\/  \(2026-11-01\)\n\s+The protocol\./);
  assert.match(text, /Direct answer\(s\): 42/);
  assert.deepEqual(calls[0].args, ['mcp', { limit: 10, category: 'it', timeRange: 'week' }]);
  await rpc('tools/call', { name: 'web_search', arguments: { query: 'x' } });
  assert.deepEqual(calls[1].args[1], { limit: 6, category: undefined, timeRange: undefined });
});

test('web_read returns the page text with an untrusted-content marker and a bounded length', async () => {
  calls.length = 0;
  const { result } = await rpc('tools/call', { name: 'web_read', arguments: { url: 'https://example.com/x', max_chars: 999999 } });
  assert.match(result.content[0].text, /Page: A page\nURL: https:\/\/example\.com\/x/);
  assert.match(result.content[0].text, /Untrusted web page text/);
  assert.deepEqual(calls[0].args, ['https://example.com/x', 12000]);
  await rpc('tools/call', { name: 'web_read', arguments: { url: 'https://example.com/y' } });
  assert.equal(calls[1].args[1], 8000);
});

test('a refused query or a private address is an error RESULT the model can read, not a protocol failure', async () => {
  const secret = await rpc('tools/call', { name: 'web_search', arguments: { query: 'secret' } });
  assert.equal(secret.error, undefined);
  assert.equal(secret.result.isError, true);
  assert.match(secret.result.content[0].text, /looks like it contains a GitHub token/);
  const blocked = await rpc('tools/call', { name: 'web_read', arguments: { url: 'http://127.0.0.1:3001/' } });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /private network/);
  const crashing = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_read', arguments: { url: 'x' } } }, { search: deps.search, read: async () => { throw new Error('internal /home/dev/secret/path detail'); } }) as any;
  assert.equal(crashing.result.isError, true);
  assert.equal(JSON.stringify(crashing).includes('/home/dev'), false, 'an unexpected failure must not leak internals');
});

test('unknown tools and methods are proper JSON-RPC errors', async () => {
  assert.equal((await rpc('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('resources/list')).error.code, -32601);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 9 } as never, deps) as any).error.code, -32600);
});

test('stdio framing: split chunks, several messages, a bad line, and notifications that get no reply', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: any[] = [];
  output.on('data', (chunk) => { for (const line of chunk.toString().split('\n')) if (line.trim()) replies.push(JSON.parse(line)); });
  const done = runStdio(deps, input, output);
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  input.write(initialize.slice(0, 20));
  input.write(`${initialize.slice(20)}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })); // no trailing newline, then the stream ends
  input.end();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies.map((r) => r.id ?? null).sort(), [1, 2, 3, null]);
  assert.equal(replies.find((r) => r.id === null).error.code, -32700);
  assert.equal(replies.find((r) => r.id === 2).result.tools.length, 2);
});
