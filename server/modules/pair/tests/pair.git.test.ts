import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { pairGit } from '../pair.git.js';

import { sh, tempRepo } from './helpers.js';

test('the repository working copy is untouched and keep makes a branch with exactly the approved tree', async () => {
  const { root, repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'my uncommitted work\n');
  const workspace = await pairGit.create(repo, path.join(root, 'wt'));
  fs.writeFileSync(path.join(workspace.directory, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(workspace.directory, 'new.txt'), 'new\n');
  const diff = await pairGit.diff(workspace);
  assert.deepEqual(diff.files.sort(), ['a.txt', 'new.txt']);
  assert.equal(diff.hasSymlinks, false);
  fs.writeFileSync(path.join(workspace.directory, 'late.txt'), 'written after approval\n');
  await pairGit.keep(workspace, diff.tree, 'pair/x', 'pair: change');
  assert.equal(sh(repo, 'ls-tree', '--name-only', 'pair/x'), 'a.txt\nnew.txt\n');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'my uncommitted work\n');
  assert.equal(sh(repo, 'branch', '--show-current'), 'main\n');
  await assert.rejects(pairGit.keep(workspace, diff.tree, 'pair/x', 'again'));
  await pairGit.remove(workspace);
  assert.equal(fs.existsSync(workspace.directory), false);
});

test('a rewritten .git file in the worktree cannot redirect git or run a hook', async () => {
  const { root, repo } = tempRepo();
  const workspace = await pairGit.create(repo, path.join(root, 'wt'));
  const evil = path.join(root, 'evil');
  fs.mkdirSync(evil);
  sh(evil, 'init', '-q');
  const marker = path.join(root, 'ran');
  sh(evil, 'config', 'core.fsmonitor', `touch ${marker}`);
  fs.writeFileSync(path.join(workspace.directory, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
  fs.writeFileSync(path.join(workspace.directory, 'b.txt'), 'b\n');
  const diff = await pairGit.diff(workspace);
  assert.deepEqual(diff.files, ['b.txt']);
  assert.equal(fs.existsSync(marker), false);
});

test('symlinks are flagged, huge changes are refused, and a folder without commits is refused', async () => {
  const { root, repo } = tempRepo();
  const workspace = await pairGit.create(repo, path.join(root, 'wt'));
  fs.symlinkSync('/etc/hostname', path.join(workspace.directory, 'link'));
  assert.equal((await pairGit.diff(workspace)).hasSymlinks, true);
  fs.writeFileSync(path.join(workspace.directory, 'big.txt'), 'x\n'.repeat(150_000));
  await assert.rejects(pairGit.diff(workspace), /too large/);
  await assert.rejects(pairGit.create(root, path.join(root, 'wt2')), /git repository/);
});
