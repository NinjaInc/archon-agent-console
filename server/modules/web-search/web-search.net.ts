/**
 * Safe page fetching for Web search: public internet only, bounded in size, time and type.
 * Author: Josh Neufield (Archon Tech)
 *
 * An agent or a search result can point this at any URL, so the dangerous case is being steered at THIS network:
 * the router, the Portainer on the app server, a cloud metadata address, the console itself. So:
 *  - only http(s), no user:password@, only the usual web ports;
 *  - every address a name resolves to is checked, at connect time, inside the socket's own DNS lookup, so a name that
 *    answers with a public address to a check and a private one to the connection (DNS rebinding) cannot get through;
 *  - redirects are followed by hand (never more than four) and every hop goes through the same checks;
 *  - the body is capped while it streams (compressed and decompressed), the whole request has a deadline, and only text
 *    content types are accepted.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

import type { WebFetchedPage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REDIRECTS = 4;
const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))\b/i;

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['64:ff9b::', 96],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

/**
 * True only for an address on the public internet. IPv4-mapped IPv6 addresses are judged as the IPv4 they wrap.
 * Used inside this module by the URL check and the connect-time lookup, and by tests/web-search.net.test.ts to pin the address rules.
 */
export function isPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const target = mapped ? mapped[1] : address;
  const family = net.isIP(target);
  if (family === 0) return false;
  return !blocked.check(target, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Throws unless the URL is an ordinary public web address. Resolves nothing: names are checked again at connect time.
 * Used by the page fetcher as its default URL check (every hop of a redirect goes through it) and by tests/web-search.net.test.ts.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('That is not a valid URL.', { code: 'WEB_URL_INVALID', statusCode: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('Only http and https addresses can be read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
  if (url.username || url.password) throw new AppError('Addresses with a user name or password are not read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
  if (!ALLOWED_PORTS.has(url.port)) throw new AppError('Only the usual web ports (80, 443, 8080, 8443) can be read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    throw new AppError('That address is on a private network, so it is not read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
  }
  if (net.isIP(host) !== 0 && !isPublicAddress(host)) throw new AppError('That address is on a private network, so it is not read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 });
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * A DNS lookup that refuses to hand the socket any non-public address. Plugged into http.request, so it runs at connect time.
 * Used by the page fetcher as its default lookup and by tests/web-search.net.test.ts.
 */
export function publicOnlyLookup(hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCallback): void {
  const wantAll = typeof options === 'object' && options !== null && options.all === true;
  const family = typeof options === 'number' ? options : (options && typeof options === 'object' ? options.family : 0);
  dns.lookup(hostname, { all: true, family: family === 4 || family === 6 ? family : 0 }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      const refused = new Error(`blocked: ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      refused.code = 'ERR_BLOCKED_ADDRESS';
      return callback(refused);
    }
    return wantAll ? callback(null, list) : callback(null, list[0].address, list[0].family);
  });
}

type PageFetcherOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Injected only by tests; production uses the public-only lookup and URL checks above. */
  lookup?: typeof publicOnlyLookup;
  validateUrl?: (raw: string) => URL;
};

function decoderFor(contentType: string): { decode(input: Uint8Array): string } {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false });
  } catch {
    return new TextDecoder('utf-8', { fatal: false });
  }
}

/**
 * Builds a page fetcher. `fetchPage(url)` returns decoded text (never more than maxBytes of it) or throws an AppError.
 * Used by web-search.module.ts for the console and by scripts/search-mcp.mjs for the agent tools; tests inject permissive checks.
 */
export function createPageFetcher(options: PageFetcherOptions = {}) {
  const maxBytes = options.maxBytes ?? 1_500_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const lookup = options.lookup ?? publicOnlyLookup;
  const validate = options.validateUrl ?? assertFetchableUrl;
  const userAgent = options.userAgent ?? 'ArchonConsole-PageReader/1 (read-only; text only)';

  function once(url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: 'GET',
        lookup: lookup as never,
        headers: { 'User-Agent': userAgent, Accept: 'text/html,text/plain,application/json;q=0.8,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          return resolve({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
        }
        if (status < 200 || status >= 300) {
          // An error page is not worth reading, and its content type says nothing useful: report the status instead.
          response.resume();
          return resolve({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
        }
        const type = String(response.headers['content-type'] ?? '');
        if (!TEXT_TYPES.test(type)) {
          response.resume();
          return reject(new AppError(`That page is not text (${type.split(';')[0] || 'unknown type'}), so it was not read.`, { code: 'WEB_CONTENT_TYPE', statusCode: 415 }));
        }
        const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
        const decoded = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
          : encoding === 'deflate' ? zlib.createInflate()
            : encoding === 'br' ? zlib.createBrotliDecompress()
              : null;
        const source: NodeJS.ReadableStream = decoded ? response.pipe(decoded) : response;
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        source.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - total;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            total = maxBytes;
            truncated = true;
            response.destroy();
            decoded?.destroy();
            return resolve({ status, headers: response.headers, body: Buffer.concat(chunks), truncated: true });
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        source.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks), truncated }));
        source.on('error', () => { if (!truncated) reject(new AppError('The page could not be read (bad encoding).', { code: 'WEB_FETCH_FAILED', statusCode: 502 })); });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ERR_BLOCKED_ADDRESS') return reject(new AppError('That address is on a private network, so it is not read.', { code: 'WEB_URL_BLOCKED', statusCode: 400 }));
        if (error.message === 'timeout') return reject(new AppError('The page took too long to answer.', { code: 'WEB_FETCH_TIMEOUT', statusCode: 504 }));
        return reject(new AppError('The page could not be fetched.', { code: 'WEB_FETCH_FAILED', statusCode: 502 }));
      });
      request.end();
    });
  }

  async function fetchPage(raw: string): Promise<WebFetchedPage> {
    const deadline = Date.now() + timeoutMs;
    let url = validate(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (Date.now() > deadline) throw new AppError('The page took too long to answer.', { code: 'WEB_FETCH_TIMEOUT', statusCode: 504 });
      const result = await once(url);
      if (result.status >= 300 && result.status < 400) {
        const location = result.headers.location;
        if (!location) throw new AppError('The page redirected without saying where.', { code: 'WEB_FETCH_FAILED', statusCode: 502 });
        url = validate(new URL(location, url).toString()); // every hop is checked like the first
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw new AppError(`The page answered with an error (${result.status}).`, { code: 'WEB_FETCH_FAILED', statusCode: 502 });
      const contentType = String(result.headers['content-type'] ?? '');
      return { url: url.toString(), status: result.status, contentType, text: decoderFor(contentType).decode(result.body), truncated: result.truncated };
    }
    throw new AppError('The page redirected too many times.', { code: 'WEB_FETCH_FAILED', statusCode: 502 });
  }

  return { fetchPage };
}
