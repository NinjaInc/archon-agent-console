// Tests for scripts/search-tool.sh: stub `claude` and `agy` record every call, so no real config is touched.
// Author: Josh Neufield (Archon Tech)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'search-tool.sh');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchtool-'));
  const stub = path.join(dir, 'stub'); fs.mkdirSync(stub);
  const log = path.join(dir, 'calls.log');
  for (const name of ['claude', 'agy']) fs.writeFileSync(path.join(stub, name), `#!/bin/sh\necho "${name}|$PWD|$*" >> "${log}"\nif [ "${name}" = agy ] && [ "$1" = mcp ] && [ "$2" = list ]; then echo "archon-web-search  node  stdio"; fi\n`, { mode: 0o755 });
  const project = path.join(dir, 'proj'); fs.mkdirSync(project);
  const claudeJson = path.join(dir, 'claude.json');
  const env = { ...process.env, CLAUDE_CONFIG_FILE: claudeJson, PATH: `${stub}:${process.env.PATH}` };
  const run = (args, cwd = dir) => spawnSync('bash', [script, ...args], { cwd, env, encoding: 'utf8' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, project, claudeJson, run, calls, real: (p) => fs.realpathSync(p), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('on registers for one project in Claude local scope, from inside that folder, running the MCP launcher with node', () => {
  const t = setup();
  const result = t.run(['on', '--project', t.project]);
  assert.equal(result.status, 0, result.stderr);
  const adds = t.calls().filter((l) => l.startsWith('claude|') && l.includes('mcp add'));
  assert.equal(adds.length, 1);
  assert.ok(adds[0].includes(`|${t.real(t.project)}|`));
  assert.match(adds[0], /mcp add --scope local archon-web-search -- \S*node\S* \S*scripts\/search-mcp\.mjs$/);
  assert.equal(t.calls().some((l) => l.startsWith('agy|')), false, 'Antigravity is only touched when asked');
  assert.equal(t.calls().some((l) => l.includes('--scope user')), false);
  t.cleanup();
});

test('--agy adds Antigravity through its own `agy mcp add`, and --user is the explicit global option for Claude', () => {
  const t = setup();
  assert.equal(t.run(['on', '--agy']).status, 0);
  const agyCalls = t.calls().filter((l) => l.startsWith('agy|'));
  assert.equal(agyCalls.length, 1);
  assert.match(agyCalls[0], /mcp add archon-web-search \S*node\S* \S*search-mcp\.mjs$/);
  assert.equal(t.calls().some((l) => l.startsWith('claude|')), false, '--agy alone must not change Claude');
  assert.equal(t.run(['on', '--user']).status, 0);
  assert.ok(t.calls().some((l) => /^claude\|.*mcp add --scope user archon-web-search/.test(l)));
  t.cleanup();
});

test('off removes from one project, the user scope, Antigravity, or everywhere', () => {
  const t = setup();
  assert.equal(t.run(['off', '--project', t.project]).status, 0);
  assert.ok(t.calls().some((l) => l.startsWith('claude|') && l.includes(t.real(t.project)) && /mcp remove archon-web-search --scope local/.test(l)));
  assert.equal(t.run(['off', '--agy']).status, 0);
  assert.ok(t.calls().some((l) => /^agy\|.*mcp remove archon-web-search/.test(l)));
  const other = path.join(t.dir, 'other'); fs.mkdirSync(other);
  fs.writeFileSync(t.claudeJson, JSON.stringify({ projects: { [other]: { mcpServers: { 'archon-web-search': {} } }, '/gone': { mcpServers: { 'archon-web-search': {} } } } }));
  assert.equal(t.run(['off', '--everywhere']).status, 0);
  const removals = t.calls().filter((l) => /mcp remove archon-web-search --scope local/.test(l));
  assert.ok(removals.some((l) => l.includes(`|${t.real(other)}|`)));
  assert.equal(removals.some((l) => l.includes('/gone')), false);
  t.cleanup();
});

test('status reads Claude config and asks agy, without changing anything', () => {
  const t = setup();
  fs.writeFileSync(t.claudeJson, JSON.stringify({ mcpServers: {}, projects: { '/work/site': { mcpServers: { 'archon-web-search': {}, other: {} } } } }));
  const result = t.run(['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every project \(user scope\): off/);
  assert.match(result.stdout, /per project: \/work\/site/);
  assert.match(result.stdout, /Antigravity: on/);
  assert.equal(t.calls().some((l) => l.includes('mcp add') || l.includes('mcp remove')), false);
  t.cleanup();
});

test('bad input is refused before anything is run', () => {
  const t = setup();
  for (const args of [[], ['frob'], ['on', '--wat'], ['on', '--project', path.join(t.dir, 'nope')], ['on', '--everywhere'], ['on', '--project']]) {
    assert.notEqual(t.run(args).status, 0, args.join(' '));
  }
  assert.equal(t.calls().filter((l) => l.includes('mcp add')).length, 0);
  t.cleanup();
});
