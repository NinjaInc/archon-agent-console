#!/usr/bin/env node
/**
 * mcp-probe - start an MCP server over stdio, initialise it and count its tools.
 *
 * Author: Josh Neufield (Archon Tech)
 *
 * Usage: node scripts/mcp-probe.mjs <command> [args...]
 * Prints `<server name> <version> tools=<n>` on success and exits 0; exits 1 on any failure.
 * The child gets a minimal environment (no tokens, no API keys).
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: mcp-probe.mjs <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' } });
let buffer = '';
let stderr = '';
let nextId = 0;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch {
      // Not JSON (a log line): ignore.
    }
    newline = buffer.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-600); });

const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 45_000);
  });

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-probe', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await call('tools/list', {});
  const count = tools.result?.tools?.length ?? 0;
  if (count === 0) throw new Error('the server listed no tools');
  console.log(`${init.result?.serverInfo?.name ?? '?'} ${init.result?.serverInfo?.version ?? '?'} tools=${count}`);
  child.kill();
  process.exit(0);
} catch (error) {
  console.error(`probe failed: ${error.message}${stderr ? `\n${stderr}` : ''}`);
  child.kill();
  process.exit(1);
}
