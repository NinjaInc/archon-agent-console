import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type { FileTreeFileSystem } from '@/shared/types.js';
import { isDeniedPath, resolvePathUnderRoots } from '@/shared/utils.js';

/**
 * The home directory is an allowed root, but its credential folders are not.
 *
 *   home/.ssh/id_ed25519        denied
 *   home/code/app/ok.txt        fine
 *   home/code/app/ssh-link      symlink to home/.ssh (must not be a way in)
 */
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-tree-denied-')));
const sshDir = path.join(home, '.ssh');
const app = path.join(home, 'code', 'app');
fs.mkdirSync(sshDir, { recursive: true });
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE KEY');
fs.writeFileSync(path.join(app, 'ok.txt'), 'fine');
fs.writeFileSync(path.join(home, 'notes.txt'), 'notes');
fs.symlinkSync(sshDir, path.join(app, 'ssh-link'));
const denied = [sshDir];

const realFileSystem: FileTreeFileSystem = {
  access: (p) => fsPromises.access(p),
  stat: (p) => fsPromises.stat(p),
  lstat: (p) => fsPromises.lstat(p),
  openDirectory: async function* (directoryPath) { yield* await fsPromises.opendir(directoryPath); },
  realpath: (p) => fsPromises.realpath(p),
  readTextFile: (p) => fsPromises.readFile(p, 'utf8'),
  writeTextFile: (p, content) => fsPromises.writeFile(p, content, 'utf8'),
  makeDirectory: async (p, recursive) => { await fsPromises.mkdir(p, { recursive }); },
  rename: (a, b) => fsPromises.rename(a, b),
  removeDirectory: (p) => fsPromises.rm(p, { recursive: true, force: true }),
  unlink: (p) => fsPromises.unlink(p),
  copyFile: (a, b) => fsPromises.copyFile(a, b),
  createReadStream: (p) => fs.createReadStream(p),
};

const projectPaths: Record<string, string> = { home, app, ssh: sshDir };
const service = createFileTreeService({
  fileSystem: realFileSystem,
  projects: { getProjectPathById: (id) => projectPaths[id] ?? null },
  workspace: {
    rootPath: home,
    rootPaths: [home],
    deniedPaths: denied,
    validatePath: async (p) => ({ valid: true, resolvedPath: p }),
    resolveReadOnlyRootPath: async () => null,
  },
  resolveMimeType: () => 'text/plain',
  fileSystemConcurrency: 4,
  logger: { error: () => undefined },
});

const refused = (error: unknown) => (error as { statusCode?: number }).statusCode === 403;

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the home directory works as a project and ordinary files are readable', async () => {
  assert.equal((await service.readTextFile('home', 'notes.txt') as { content?: string } | string) !== undefined, true);
  assert.ok(await service.listProjectFiles('home', {} as never));
});

test('credential folders are not listed in the tree', async () => {
  const tree = JSON.stringify(await service.listProjectFiles('home', {} as never));
  assert.ok(tree.includes('notes.txt') && tree.includes('code'));
  assert.ok(!tree.includes('.ssh') && !tree.includes('id_ed25519'));
});

test('reading or writing inside a credential folder is refused', async () => {
  await assert.rejects(() => service.readTextFile('home', '.ssh/id_ed25519'), refused);
  await assert.rejects(() => service.saveTextFile('home', '.ssh/authorized_keys', 'ssh-ed25519 AAAA attacker'), refused);
  assert.equal(fs.existsSync(path.join(sshDir, 'authorized_keys')), false);
});

test('an absolute path into a credential folder is refused too, for reading and writing', async () => {
  await assert.rejects(() => service.readTextFile('home', path.join(sshDir, 'id_ed25519')), refused);
  await assert.rejects(() => service.readTextFile('app', path.join(sshDir, 'id_ed25519')), refused);
  await assert.rejects(() => service.saveTextFile('home', path.join(sshDir, 'authorized_keys'), 'x'), refused);
  assert.equal(fs.existsSync(path.join(sshDir, 'authorized_keys')), false);
});

test('a symlink in a project that points into a credential folder is not a way in', async () => {
  await assert.rejects(() => service.readTextFile('app', 'ssh-link/id_ed25519'), refused);
  await assert.rejects(() => service.saveTextFile('app', 'ssh-link/authorized_keys', 'x'), refused);
});

test('a credential folder cannot be opened as a project', async () => {
  await assert.rejects(() => service.listProjectFiles('ssh', {} as never), refused);
});

test('shell start check: home is allowed, credential folders are not, even through a link', async () => {
  assert.equal(await resolvePathUnderRoots(home, [home], denied), home);
  assert.equal(await resolvePathUnderRoots(app, [home], denied), app);
  assert.equal(await resolvePathUnderRoots(sshDir, [home], denied), null);
  assert.equal(await resolvePathUnderRoots(path.join(app, 'ssh-link'), [home], denied), null);
});

test('isDeniedPath matches the folder and its children, not lookalike siblings', () => {
  assert.ok(isDeniedPath(sshDir, denied));
  assert.ok(isDeniedPath(path.join(sshDir, 'id_ed25519'), denied));
  assert.ok(!isDeniedPath(`${sshDir}-backup`, denied));
  assert.ok(!isDeniedPath(path.join(home, 'code'), denied));
});

test('a project opened at a whole root shows a shallow tree without hidden folders', async () => {
  const deep = path.join(home, 'code', 'app', 'l4', 'l5', 'l6');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'deep');
  fs.mkdirSync(path.join(home, '.cache', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cache', 'junk', 'x'), 'x');

  const tree = JSON.stringify(await service.listProjectFiles('home', {} as never));
  assert.ok(tree.includes('"code"') && tree.includes('notes.txt'));
  assert.ok(!tree.includes('.cache'), 'hidden folders are not listed at a whole root');
  assert.ok(!tree.includes('deep.txt'), 'the tree stops after a few levels at a whole root');

  // A normal project inside the root keeps the full-depth tree.
  const appTree = JSON.stringify(await service.listProjectFiles('app', {} as never));
  assert.ok(appTree.includes('deep.txt'));
});
