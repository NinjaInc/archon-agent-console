import assert from 'node:assert/strict';
import test from 'node:test';

import { createGithubReposService } from '../github-repos.service.js';

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  nameWithOwner: `NinjaInc/${name}`,
  name,
  description: `${name} repo`,
  isPrivate: true,
  isFork: false,
  primaryLanguage: { name: 'TypeScript' },
  pushedAt: '2026-11-18T00:00:00Z',
  url: `https://github.com/NinjaInc/${name}`,
  ...extra,
});

function setup(options: { cloned?: string[]; registerError?: { code: string } } = {}) {
  const calls = { list: 0, clone: [] as string[][], registered: [] as string[][] };
  const cloned = new Set(options.cloned ?? ['/work/NinjaInc/alpha']);
  let clock = 1_000;
  const service = createGithubReposService({
    cloneRoot: '/work',
    now: () => clock,
    listRepositories: async () => { calls.list += 1; return [repo('alpha'), repo('beta', { description: null, primaryLanguage: null })]; },
    isGitCheckout: async (dir) => cloned.has(dir),
    cloneRepository: async (ref, target) => { calls.clone.push([ref, target]); cloned.add(target); },
    registerProject: async (p, name) => {
      calls.registered.push([p, name]);
      if (options.registerError) throw Object.assign(new Error('exists'), options.registerError);
      return { project: { fullPath: p, displayName: name } };
    },
  });
  return { service, calls, tick: (ms: number) => { clock += ms; } };
}

test('lists repositories with local path and clone state', async () => {
  const { service } = setup();
  const repos = await service.list();
  assert.equal(repos.length, 2);
  assert.deepEqual(repos.map((r) => [r.name, r.cloned, r.localPath]), [
    ['alpha', true, '/work/NinjaInc/alpha'],
    ['beta', false, '/work/NinjaInc/beta'],
  ]);
  assert.equal(repos[1].description, '');
  assert.equal(repos[1].language, null);
});

test('the GitHub listing is cached for a minute and refreshable', async () => {
  const { service, calls, tick } = setup();
  await service.list(); await service.list();
  assert.equal(calls.list, 1);
  await service.list({ refresh: true });
  assert.equal(calls.list, 2);
  tick(61_000);
  await service.list();
  assert.equal(calls.list, 3);
});

test('open registers an existing clone as a project', async () => {
  const { service, calls } = setup();
  await service.open('NinjaInc/alpha');
  assert.deepEqual(calls.registered, [['/work/NinjaInc/alpha', 'alpha']]);
});

test('open refuses a repo that is not cloned yet', async () => {
  const { service } = setup();
  await assert.rejects(service.open('NinjaInc/beta'), { code: 'GITHUB_REPO_NOT_CLONED' });
});

test('clone clones a missing repo into <root>/<owner>/<name> and registers it', async () => {
  const { service, calls } = setup();
  await service.clone('NinjaInc/beta');
  assert.deepEqual(calls.clone, [['NinjaInc/beta', '/work/NinjaInc/beta']]);
  assert.deepEqual(calls.registered, [['/work/NinjaInc/beta', 'beta']]);
});

test('clone does not re-clone an existing checkout', async () => {
  const { service, calls } = setup();
  await service.clone('NinjaInc/alpha');
  assert.equal(calls.clone.length, 0);
});

test('only repositories in the account can be cloned or opened', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.clone('someone-else/malware'), { code: 'GITHUB_REPO_UNKNOWN' });
  await assert.rejects(service.open('someone-else/malware'), { code: 'GITHUB_REPO_UNKNOWN' });
  assert.equal(calls.clone.length, 0);
});

test('malformed or traversal references are rejected before anything runs', async () => {
  const { service, calls } = setup();
  for (const bad of [undefined, null, 42, '', 'alpha', '../etc/passwd', 'NinjaInc/..', 'NinjaInc/../x', 'a/b/c', 'NinjaInc/al pha', 'NinjaInc/a;rm -rf /', '-flag/repo']) {
    await assert.rejects(service.clone(bad as never), { code: 'GITHUB_REPO_INVALID' }, String(bad));
  }
  assert.equal(calls.list, 0);
  assert.equal(calls.clone.length, 0);
});

test('a repo that is already a project is returned instead of failing', async () => {
  const { service } = setup({ registerError: { code: 'PROJECT_ALREADY_EXISTS' } });
  const result = await service.open('NinjaInc/alpha');
  assert.equal((result.project as { alreadyRegistered?: boolean }).alreadyRegistered, true);
});
