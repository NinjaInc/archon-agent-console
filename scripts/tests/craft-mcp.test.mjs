// Tests for scripts/craft-mcp.sh: ArtCraft MCP servers are switched on per project, not globally.
// A stub `claude` records every call (and the folder it ran in), so nothing touches a real Claude config.
// Author: Josh Neufield (Archon Tech)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'craft-mcp.sh');

function setup(apps = ['photo', 'pdf']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftmcp-'));
  const root = path.join(dir, 'artcraft');
  for (const app of apps) {
    const bin = path.join(root, `${app}craft`, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, `${app}craft-cli`), '#!/bin/sh\n', { mode: 0o755 });
  }
  const stubDir = path.join(dir, 'stub');
  fs.mkdirSync(stubDir);
  const log = path.join(dir, 'claude.log');
  fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n`, { mode: 0o755 });
  const project = path.join(dir, 'proj');
  fs.mkdirSync(project);
  const claudeJson = path.join(dir, 'claude.json');
  const env = { ...process.env, CRAFT_ROOT: root, CLAUDE_CONFIG_FILE: claudeJson, PATH: `${stubDir}:${process.env.PATH}` };
  const run = (args, cwd = dir) => spawnSync('bash', [script, ...args], { cwd, env, encoding: 'utf8' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, root, project, claudeJson, run, calls, real: (p) => fs.realpathSync(p), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('on registers for ONE project (local scope, from inside that folder), never globally', () => {
  const t = setup();
  const result = t.run(['on', 'photo', '--project', t.project]);
  assert.equal(result.status, 0, result.stderr);
  const adds = t.calls().filter((line) => line.includes('mcp add'));
  assert.equal(adds.length, 1);
  assert.ok(adds[0].startsWith(`${t.real(t.project)}|`), 'must run inside the project folder');
  assert.match(adds[0], /mcp add --scope local photocraft -- .*photocraft\/bin\/photocraft-cli mcp$/);
  assert.equal(t.calls().some((line) => line.includes('--scope user')), false);
  assert.match(result.stdout, /on:\s+photocraft/);
  t.cleanup();
});

test('on defaults to the current folder and handles several apps', () => {
  const t = setup();
  assert.equal(t.run(['on', 'photo', 'pdf'], t.project).status, 0);
  const adds = t.calls().filter((line) => line.includes('mcp add'));
  assert.equal(adds.length, 2);
  assert.ok(adds.every((line) => line.startsWith(`${t.real(t.project)}|`)));
  t.cleanup();
});

test('on all switches on every installed app and nothing else', () => {
  const t = setup(['photo', 'pdf', 'word']);
  assert.equal(t.run(['on', 'all', '--project', t.project]).status, 0);
  const names = t.calls().filter((line) => line.includes('mcp add')).map((line) => line.match(/--scope local (\w+)/)[1]).sort();
  assert.deepEqual(names, ['pdfcraft', 'photocraft', 'wordcraft']);
  t.cleanup();
});

test('--user is the explicit, global option', () => {
  const t = setup();
  assert.equal(t.run(['on', 'photo', '--user']).status, 0);
  assert.ok(t.calls().some((line) => /mcp add --scope user photocraft/.test(line)));
  assert.equal(t.calls().some((line) => line.includes('--scope local')), false);
  t.cleanup();
});

test('off removes from one project, from the user scope, or everywhere', () => {
  const t = setup();
  assert.equal(t.run(['off', 'photo', '--project', t.project]).status, 0);
  assert.ok(t.calls().some((line) => line.startsWith(`${t.real(t.project)}|`) && /mcp remove photocraft --scope local/.test(line)));

  assert.equal(t.run(['off', 'photo', '--user']).status, 0);
  assert.ok(t.calls().some((line) => /mcp remove photocraft --scope user/.test(line)));

  // --everywhere reads the projects Claude knows about and removes from each one that still exists.
  const other = path.join(t.dir, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(t.claudeJson, JSON.stringify({ projects: { [other]: { mcpServers: { photocraft: {} } }, '/gone/away': { mcpServers: { photocraft: {} } } } }));
  assert.equal(t.run(['off', 'photo', '--everywhere']).status, 0);
  const removals = t.calls().filter((line) => /mcp remove photocraft --scope local/.test(line));
  assert.ok(removals.some((line) => line.startsWith(`${t.real(other)}|`)));
  assert.equal(removals.some((line) => line.includes('/gone/away')), false, 'a project folder that no longer exists is skipped');
  t.cleanup();
});

test('status lists what is installed and where each is switched on, without running claude', () => {
  const t = setup();
  fs.writeFileSync(t.claudeJson, JSON.stringify({ mcpServers: { photocraft: {} }, projects: { '/work/site': { mcpServers: { pdfcraft: {}, other: {} } } } }));
  const result = t.run(['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /photocraft/);
  assert.match(result.stdout, /EVERY project \(user scope\): photocraft/);
  assert.match(result.stdout, /\/work\/site: pdfcraft/);
  assert.equal(result.stdout.includes('other'), false, 'non-ArtCraft servers are not listed');
  assert.equal(t.calls().length, 0, 'status only reads the config file');
  t.cleanup();
});

test('bad input is refused before claude is ever run', () => {
  const t = setup();
  for (const args of [
    ['on'], ['on', 'Photo'], ['on', 'photo;rm'], ['on', '../x'], ['on', 'photo', '--project', path.join(t.dir, 'nope')],
    ['on', 'unknown'], ['on', 'all', 'photo'], ['frob', 'photo'], ['on', 'photo', '--wat'], ['on', 'photo', '--everywhere'],
  ]) {
    const result = t.run(args);
    assert.notEqual(result.status, 0, `should refuse: ${args.join(' ')}`);
  }
  assert.equal(t.calls().length, 0, 'nothing may reach claude for a refused request');
  t.cleanup();
});
