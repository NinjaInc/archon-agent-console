import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import zlib from 'node:zlib';

import { AppError } from '@/shared/utils.js';

import { assertFetchableUrl, createPageFetcher, isPublicAddress, publicOnlyLookup } from '../web-search.net.js';

const closers: Array<() => Promise<void>> = [];
after(async () => { await Promise.all(closers.map((close) => close().catch(() => undefined))); });

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
async function serve(handler: Handler) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  closers.push(close);
  return { base: `http://127.0.0.1:${port}`, port, close };
}
const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));
// Tests that exercise fetching, redirects and limits talk to a local server, so they use a permissive validator and lookup.
const permissive = { validateUrl: (raw: string) => new URL(raw), lookup: ((host: string, options: unknown, callback: (e: null, a: string, f: number) => void) => callback(null, '127.0.0.1', 4)) as never };

// ---- the address rules -------------------------------------------------------------------------------------------

test('only public addresses count as public, and IPv4-mapped IPv6 is judged as the IPv4 inside it', () => {
  for (const ok of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1', '100.63.255.255']) assert.equal(isPublicAddress(ok), true, ok);
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.84', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:10.0.0.1', '2002:7f00:1::', '64:ff9b::7f00:1', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(bad), false, bad);
  }
});

test('URLs that point at this network, other protocols, other ports or hidden tricks are refused before any connection', () => {
  const refused = [
    'file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'javascript:alert(1)', 'data:text/html,hi',
    'http://user:pw@example.com/', 'http://localhost/', 'http://LOCALHOST:8080/', 'http://x.localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://192.168.1.84:3001/', 'http://192.168.1.6:9443/',
    'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://printer.local/', 'http://db.internal/', 'http://nas.lan/',
    'http://example.com:22/', 'http://example.com:6379/', 'http://example.com:3001/', 'http://example.com:11434/', 'not a url', '',
  ];
  for (const url of refused) assert.throws(() => assertFetchableUrl(url), AppError, url);
  for (const url of ['https://example.com/a?b=c', 'http://example.com:8080/x', 'https://example.com:8443/', 'http://93.184.216.34/', 'https://sub.docs.example.co.uk/page#frag']) {
    assert.doesNotThrow(() => assertFetchableUrl(url), url);
  }
});

test('the socket-level lookup refuses a name that resolves to a private address (this is what stops DNS rebinding)', async () => {
  for (const options of [{ all: true }, {}, 4] as const) {
    const outcome = await new Promise<{ error?: NodeJS.ErrnoException }>((resolve) => {
      publicOnlyLookup('localhost', options as never, (error) => resolve({ error: error ?? undefined }));
    });
    assert.equal(outcome.error?.code, 'ERR_BLOCKED_ADDRESS', JSON.stringify(options));
  }
});

test('the real fetcher will not connect to a server on this machine, whatever the URL says', async () => {
  let hits = 0;
  const target = await serve((_req, res) => { hits += 1; res.end('secret'); });
  const { fetchPage } = createPageFetcher();
  await assert.rejects(fetchPage(`${target.base}/`), (error) => code(error) === 'WEB_URL_BLOCKED');
  await assert.rejects(fetchPage(`http://localhost:${target.port}/`), (error) => code(error) === 'WEB_URL_BLOCKED');
  assert.equal(hits, 0, 'nothing may reach the local server');
});

// ---- the fetcher's limits ----------------------------------------------------------------------------------------

test('a normal page is fetched and decoded, including a non-UTF-8 charset', async () => {
  const server = await serve((req, res) => {
    if (req.url === '/latin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' }); res.end(Buffer.from('caf\xe9', 'latin1')); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<p>hello</p>');
  });
  const { fetchPage } = createPageFetcher(permissive);
  assert.equal((await fetchPage(`${server.base}/`)).text, '<p>hello</p>');
  assert.equal((await fetchPage(`${server.base}/latin`)).text, 'café');
});

test('gzip and deflate bodies are decoded', async () => {
  const server = await serve((req, res) => {
    const body = Buffer.from('<p>compressed hello</p>');
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(body)); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' }); res.end(zlib.deflateSync(body));
  });
  const { fetchPage } = createPageFetcher(permissive);
  assert.equal((await fetchPage(`${server.base}/gzip`)).text, '<p>compressed hello</p>');
  assert.equal((await fetchPage(`${server.base}/deflate`)).text, '<p>compressed hello</p>');
});

test('content that is not text is refused without being downloaded', async () => {
  const server = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.alloc(100)); });
  const { fetchPage } = createPageFetcher(permissive);
  await assert.rejects(fetchPage(`${server.base}/`), (error) => code(error) === 'WEB_CONTENT_TYPE');
});

test('a huge body is cut at the byte limit instead of being held in memory', async () => {
  const server = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('x'.repeat(5_000_000)); });
  const { fetchPage } = createPageFetcher({ ...permissive, maxBytes: 20_000 });
  const page = await fetchPage(`${server.base}/`);
  assert.equal(page.truncated, true);
  assert.ok(page.text.length <= 20_000);
});

test('a decompression bomb is cut by the same limit (the decompressed size counts, not the download)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(60_000_000, 0x61)); // ~60 MB of "a" that is only ~60 KB on the wire
  assert.ok(bomb.length < 200_000);
  const server = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }); res.end(bomb); });
  const { fetchPage } = createPageFetcher({ ...permissive, maxBytes: 100_000 });
  const started = Date.now();
  const page = await fetchPage(`${server.base}/`);
  assert.equal(page.truncated, true);
  assert.ok(page.text.length <= 100_000);
  assert.ok(Date.now() - started < 3000);
});

test('redirects are followed, but only four of them, and every hop is checked', async () => {
  const server = await serve((req, res) => {
    const match = req.url?.match(/^\/hop\/(\d+)$/);
    if (match) { res.writeHead(302, { Location: Number(match[1]) > 0 ? `/hop/${Number(match[1]) - 1}` : '/end' }); res.end(); return; }
    if (req.url === '/to-private') { res.writeHead(302, { Location: 'http://blocked.test/secret' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('arrived');
  });
  const checked: string[] = [];
  const validateUrl = (raw: string) => { checked.push(raw); if (raw.includes('blocked.test')) throw new AppError('blocked', { code: 'WEB_URL_BLOCKED', statusCode: 400 }); return new URL(raw); };
  const { fetchPage } = createPageFetcher({ ...permissive, validateUrl });
  assert.equal((await fetchPage(`${server.base}/hop/3`)).text, 'arrived');
  await assert.rejects(fetchPage(`${server.base}/hop/9`), (error) => code(error) === 'WEB_FETCH_FAILED');
  await assert.rejects(fetchPage(`${server.base}/to-private`), (error) => code(error) === 'WEB_URL_BLOCKED');
  assert.ok(checked.some((url) => url.includes('blocked.test')), 'the redirect target must go through the same check as the first URL');
});

test('errors, stalls and timeouts become clear errors, not hangs', async () => {
  const server = await serve((req, res) => {
    if (req.url === '/stall') return; // never answers
    res.writeHead(404); res.end('nope');
  });
  const { fetchPage } = createPageFetcher({ ...permissive, timeoutMs: 400 });
  await assert.rejects(fetchPage(`${server.base}/missing`), (error) => code(error) === 'WEB_FETCH_FAILED');
  const started = Date.now();
  await assert.rejects(fetchPage(`${server.base}/stall`), (error) => code(error) === 'WEB_FETCH_TIMEOUT');
  assert.ok(Date.now() - started < 2000);
});
