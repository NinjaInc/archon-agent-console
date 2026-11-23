#!/usr/bin/env node
/**
 * search-mcp - an MCP server (stdio) with two read-only tools, web_search and web_read, for Claude Code and Antigravity.
 * Author: Josh Neufield (Archon Tech)
 *
 * It runs the console's own guarded Web search code (compiled in dist-server), so it needs `npm run build` once and the
 * private search service (scripts/install-searxng.sh). Switch it on per project with scripts/search-tool.sh.
 * Nothing is written to stdout except protocol messages; problems go to stderr.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-server', 'server', 'modules', 'web-search');
const load = (name) => import(pathToFileURL(path.join(root, name)).href);

let modules;
try {
  modules = await Promise.all(['web-search.config.js', 'web-search.net.js', 'web-search.service.js', 'web-search.mcp.js'].map(load));
} catch (error) {
  console.error('search-mcp: the compiled search code was not found. Run `npm run build` in the console repository first.');
  console.error(String(error?.message ?? error).split('\n')[0]);
  process.exit(1);
}
const [{ loadWebSearchConfig }, { createPageFetcher }, { createWebSearchService }, { runStdio }] = modules;

const config = loadWebSearchConfig(process.env);
if (config.problem) console.error(`search-mcp: ${config.problem}`);
const service = createWebSearchService({ config, fetchPage: createPageFetcher().fetchPage });
await runStdio({ search: service.search, read: service.read });
