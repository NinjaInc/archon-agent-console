import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type { FileTreeFileSystem } from '@/shared/types.js';

/**
 * Path traversal and symlink escape tests against the REAL file system and the
 * real File Tree service (no fakes for path handling).
 *
 * Layout under one temp dir:
 *   roots/projects/app          the project
 *   roots/projects/app-evil     sibling whose name starts with the project's
 *   outside/secret.txt          a file nobody may touch
 */

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-tree-safety-')));
const rootsDir = path.join(sandbox, 'roots');
const projectsDir = path.join(rootsDir, 'projects');
const project = path.join(projectsDir, 'app');
const sibling = path.join(projectsDir, 'app-evil');
const outside = path.join(sandbox, 'outside');
const secret = path.join(outside, 'secret.txt');
const notAllowedProject = path.join(sandbox, 'elsewhere', 'proj');

for (const directory of [project, sibling, outside, notAllowedProject]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(secret, 'TOP SECRET');
fs.writeFileSync(path.join(sibling, 'loot.txt'), 'sibling');
fs.writeFileSync(path.join(project, 'ok.txt'), 'fine');
fs.symlinkSync(secret, path.join(project, 'link-to-secret.txt'));
fs.symlinkSync(outside, path.join(project, 'link-to-outside-dir'));
fs.symlinkSync(path.join(outside, 'not-created-yet.txt'), path.join(project, 'dangling.txt'));
fs.symlinkSync(path.join(project, 'ok.txt'), path.join(project, 'link-inside.txt'));

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

const projectPaths: Record<string, string> = { app: project, elsewhere: notAllowedProject };
const service = createFileTreeService({
  fileSystem: realFileSystem,
  projects: { getProjectPathById: (id) => projectPaths[id] ?? null },
  workspace: {
    rootPath: projectsDir,
    rootPaths: [projectsDir],
    validatePath: async (p) => ({ valid: true, resolvedPath: p }),
    resolveReadOnlyRootPath: async () => null,
  },
  resolveMimeType: () => 'text/plain',
  fileSystemConcurrency: 4,
  logger: { error: () => undefined },
});

const forbidden = (code: string) => (error: unknown) =>
  (error as { statusCode?: number; code?: string }).statusCode === 403 && (error as { code?: string }).code === code;

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test('a normal write inside the project works, including into directories that do not exist yet', async () => {
  await service.saveTextFile('app', 'ok.txt', 'changed');
  assert.equal(fs.readFileSync(path.join(project, 'ok.txt'), 'utf8'), 'changed');
  const created = await service.createEntry({ projectId: 'app', parentPath: project, type: 'file', name: 'new.txt' });
  assert.ok(fs.existsSync(created.path));
});

test('.. traversal and absolute paths outside the project are refused', async () => {
  await assert.rejects(() => service.saveTextFile('app', '../../../outside/secret.txt', 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  await assert.rejects(() => service.saveTextFile('app', secret, 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  await assert.rejects(() => service.saveTextFile('app', '/etc/passwd', 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP SECRET');
});

test('a sibling folder that merely starts with the project name is not inside it', async () => {
  await assert.rejects(() => service.saveTextFile('app', '../app-evil/loot.txt', 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  await assert.rejects(() => service.saveTextFile('app', path.join(sibling, 'loot.txt'), 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  assert.equal(fs.readFileSync(path.join(sibling, 'loot.txt'), 'utf8'), 'sibling');
});

test('writing through a symlink that points outside the project is refused and changes nothing', async () => {
  await assert.rejects(() => service.saveTextFile('app', 'link-to-secret.txt', 'pwned'), forbidden('PATH_OUTSIDE_PROJECT'));
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP SECRET');
});

test('creating or uploading under a symlinked directory that points outside is refused', async () => {
  await assert.rejects(
    () => service.createEntry({ projectId: 'app', parentPath: path.join(project, 'link-to-outside-dir'), type: 'file', name: 'planted.txt' }),
    forbidden('PATH_OUTSIDE_PROJECT'),
  );
  await assert.rejects(() => service.saveTextFile('app', 'link-to-outside-dir/planted.txt', 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  assert.equal(fs.existsSync(path.join(outside, 'planted.txt')), false);
});

test('a dangling symlink cannot be used to create a file outside the project', async () => {
  await assert.rejects(() => service.saveTextFile('app', 'dangling.txt', 'x'), forbidden('PATH_OUTSIDE_PROJECT'));
  assert.equal(fs.existsSync(path.join(outside, 'not-created-yet.txt')), false);
});

test('a symlink that stays inside the project is fine', async () => {
  await service.saveTextFile('app', 'link-inside.txt', 'via inside link');
  assert.equal(fs.readFileSync(path.join(project, 'ok.txt'), 'utf8'), 'via inside link');
});

test('reading through an escaping symlink is refused too', async () => {
  await assert.rejects(() => service.readTextFile('app', 'link-to-secret.txt'), forbidden('PATH_OUTSIDE_PROJECT'));
});

test('deleting an escaping symlink removes the link, never its target', async () => {
  await service.deleteEntry({ projectId: 'app', targetPath: path.join(project, 'link-to-secret.txt') });
  assert.equal(fs.existsSync(path.join(project, 'link-to-secret.txt')), false);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP SECRET');

  await service.deleteEntry({ projectId: 'app', targetPath: path.join(project, 'link-to-outside-dir') });
  assert.ok(fs.existsSync(secret), 'deleting the directory link must not delete what it points at');
});

test('rename cannot move an entry out of the project', async () => {
  await assert.rejects(
    () => service.renameEntry({ projectId: 'app', oldPath: path.join(project, 'ok.txt'), newName: '../../outside/stolen.txt' }),
    (error) => (error as { statusCode?: number }).statusCode === 400 || (error as { statusCode?: number }).statusCode === 403,
  );
  assert.equal(fs.existsSync(path.join(outside, 'stolen.txt')), false);
});

test('a project registered outside the allowed roots cannot be browsed or written', async () => {
  await assert.rejects(() => service.saveTextFile('elsewhere', 'a.txt', 'x'), forbidden('PROJECT_OUTSIDE_ROOTS'));
  await assert.rejects(() => service.listProjectFiles('elsewhere', {} as never), forbidden('PROJECT_OUTSIDE_ROOTS'));
  assert.equal(fs.existsSync(path.join(notAllowedProject, 'a.txt')), false);
});
