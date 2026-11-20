// Tests for scripts/git-hooks/append-coauthor.sh, the prepare-commit-msg helper that adds a Co-Authored-By
// trailer exactly once. Uses a fake trailer and throwaway repositories; no real address appears anywhere.
// Author: Josh Neufield (Archon Tech)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'git-hooks', 'append-coauthor.sh');
const TRAILER = 'Co-Authored-By: Test Person <test@example.com>';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coauthor-'));
  const trailerFile = path.join(dir, 'trailer');
  fs.writeFileSync(trailerFile, `${TRAILER}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'dev@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Dev']);
  return { dir, trailerFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, file, source, trailerFile) {
  const result = spawnSync('sh', [helper, file, source].filter((arg) => arg !== undefined), { cwd: dir, env: { ...process.env, COAUTHOR_TRAILER_FILE: trailerFile }, encoding: 'utf8' });
  return result;
}

const count = (text) => text.split('\n').filter((line) => line === TRAILER).length;

test('adds the trailer once, in the trailer block after the body', () => {
  const w = workspace();
  const file = path.join(w.dir, 'msg');
  fs.writeFileSync(file, 'feat: one\n\nbody line\n');
  assert.equal(run(w.dir, file, 'message', w.trailerFile).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), `feat: one\n\nbody line\n\n${TRAILER}\n`);
  w.cleanup();
});

test('running it again (amend, rebase, a second hook run) never duplicates the trailer', () => {
  const w = workspace();
  const file = path.join(w.dir, 'msg');
  fs.writeFileSync(file, 'feat: one\n');
  for (let i = 0; i < 3; i += 1) run(w.dir, file, 'message', w.trailerFile);
  assert.equal(count(fs.readFileSync(file, 'utf8')), 1);
  w.cleanup();
});

test('a message that already has the trailer (typed by hand) is left as it is', () => {
  const w = workspace();
  const file = path.join(w.dir, 'msg');
  const original = `feat: two\n\n${TRAILER}\n`;
  fs.writeFileSync(file, original);
  run(w.dir, file, 'message', w.trailerFile);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  w.cleanup();
});

test('merge and squash messages are not touched', () => {
  const w = workspace();
  for (const source of ['merge', 'squash']) {
    const file = path.join(w.dir, `msg-${source}`);
    fs.writeFileSync(file, 'Merge branch x\n');
    run(w.dir, file, source, w.trailerFile);
    assert.equal(count(fs.readFileSync(file, 'utf8')), 0, source);
  }
  w.cleanup();
});

test('a missing or malformed trailer file is a harmless no-op, never a failed commit', () => {
  const w = workspace();
  const file = path.join(w.dir, 'msg');
  fs.writeFileSync(file, 'feat: three\n');
  assert.equal(run(w.dir, file, 'message', path.join(w.dir, 'does-not-exist')).status, 0);
  fs.writeFileSync(w.trailerFile, 'not a trailer line\n');
  assert.equal(run(w.dir, file, 'message', w.trailerFile).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'feat: three\n');
  assert.equal(run(w.dir, path.join(w.dir, 'no-such-file'), 'message', w.trailerFile).status, 0);
  w.cleanup();
});

test('works from a relative path, which is how git calls a hook', () => {
  const w = workspace();
  fs.writeFileSync(path.join(w.dir, 'msg'), 'feat: four\n');
  run(w.dir, 'msg', 'message', w.trailerFile);
  assert.equal(count(fs.readFileSync(path.join(w.dir, 'msg'), 'utf8')), 1);
  w.cleanup();
});

test('end to end: a real commit and an amend through a prepare-commit-msg hook carry the trailer exactly once', () => {
  const w = workspace();
  const hook = path.join(w.dir, '.git', 'hooks', 'prepare-commit-msg');
  fs.writeFileSync(hook, `#!/usr/bin/env sh\nsh '${helper}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(w.dir, 'a.txt'), 'a\n');
  const env = { ...process.env, COAUTHOR_TRAILER_FILE: w.trailerFile };
  execFileSync('git', ['-C', w.dir, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', w.dir, 'commit', '-q', '-m', 'feat: real commit'], { env });
  execFileSync('git', ['-C', w.dir, 'commit', '-q', '--amend', '--no-edit'], { env });
  execFileSync('git', ['-C', w.dir, 'commit', '-q', '--amend', '-m', 'feat: reworded'], { env });
  const message = execFileSync('git', ['-C', w.dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.match(message, /^feat: reworded/);
  assert.equal(count(message), 1);
  w.cleanup();
});
