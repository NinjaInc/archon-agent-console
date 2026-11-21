import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UsageError, buildCreateBody, buildRedeployBody, checkRepoAllowed, demuxDockerLogs, parseArgs,
  parseEnvPairs, pickEndpoint, runVerb, validateComposePath, validateStackName,
} from '../archon-prod.mjs';

const PREFIXES = ['https://github.com/NinjaInc/'];

test('parseArgs separates positionals from flags and collects repeated --env', () => {
  const { positionals, flags } = parseArgs(['mystack', '--repo', 'https://x/y', '--env', 'A=1', '--env', 'B=2', '--yes']);
  assert.deepEqual(positionals, ['mystack']);
  assert.equal(flags.repo, 'https://x/y');
  assert.deepEqual(flags.env, ['A=1', 'B=2']);
  assert.equal(flags.yes, true);
  assert.throws(() => parseArgs(['--repo']), UsageError);
});

test('stack names are restricted to a safe pattern', () => {
  for (const ok of ['ironarmada', 'iron-armada_2']) assert.equal(validateStackName(ok), ok);
  for (const bad of ['', 'a', 'Iron', '../x', 'a b', '-x', 'x;rm', undefined, 'x'.repeat(60)]) assert.throws(() => validateStackName(bad), UsageError, String(bad));
});

test('only https repositories under an allowed prefix may be deployed', () => {
  assert.equal(checkRepoAllowed('https://github.com/NinjaInc/IronArmada', PREFIXES), 'https://github.com/NinjaInc/IronArmada');
  assert.ok(checkRepoAllowed('https://github.com/ninjainc/IronArmada.git', PREFIXES));
  for (const bad of ['https://github.com/someone-else/x', 'http://github.com/NinjaInc/x', 'https://github.com/NinjaInc-evil/x', 'https://evil.com/github.com/NinjaInc/x', 'https://user:pw@github.com/NinjaInc/x', 'git@github.com:NinjaInc/x.git', 'not a url']) {
    assert.throws(() => checkRepoAllowed(bad, PREFIXES), UsageError, bad);
  }
  assert.throws(() => checkRepoAllowed('https://github.com/NinjaInc/x', []), /No allowedRepoPrefixes/);
});

test('a prefix without a trailing slash still cannot admit a look-alike owner', () => {
  assert.ok(checkRepoAllowed('https://github.com/NinjaInc/x', ['https://github.com/NinjaInc']));
  assert.throws(() => checkRepoAllowed('https://github.com/NinjaInc-evil/x', ['https://github.com/NinjaInc']), UsageError);
});

test('compose paths must stay inside the repository', () => {
  assert.equal(validateComposePath('deploy/docker-compose.prod.yml'), 'deploy/docker-compose.prod.yml');
  for (const bad of ['/etc/passwd', '../x.yml', 'a/../../b.yml', 'a\\b.yml', '']) assert.throws(() => validateComposePath(bad), UsageError, bad);
});

test('env pairs are validated and bounded', () => {
  assert.deepEqual(parseEnvPairs(['APP_ENV=production', 'X=a=b']), [{ name: 'APP_ENV', value: 'production' }, { name: 'X', value: 'a=b' }]);
  for (const bad of ['=1', '1A=x', 'A B=1', 'novalue']) assert.throws(() => parseEnvPairs([bad]), UsageError, bad);
  assert.throws(() => parseEnvPairs(Array.from({ length: 51 }, (_, i) => `K${i}=v`)), UsageError);
});

test('redeploy keeps the stack\'s own settings, pulls images and never prunes', () => {
  const body = buildRedeployBody({ Env: [{ name: 'A', value: '1', extra: 'x' }], GitConfig: { ReferenceName: 'refs/heads/main', Authentication: { GitCredentialID: 7 } } });
  assert.deepEqual(body, { env: [{ name: 'A', value: '1' }], prune: false, pullImage: true, repositoryReferenceName: 'refs/heads/main', repositoryAuthentication: true, repositoryGitCredentialID: 7 });
  assert.equal(buildRedeployBody({ GitConfig: { ReferenceName: 'refs/heads/x' } }).repositoryAuthentication, false);
});

test('create body never carries passwords, only a saved credential id', () => {
  const body = buildCreateBody({ name: 's', repo: 'https://github.com/NinjaInc/s', ref: 'refs/heads/main', compose: 'docker-compose.yml', env: [], credentialId: '3' });
  assert.equal(body.repositoryAuthentication, true);
  assert.equal(body.repositoryGitCredentialID, 3);
  assert.ok(!('repositoryPassword' in body) && !('repositoryUsername' in body));
});

test('docker log frames are demultiplexed, and plain text passes through', () => {
  const frame = (stream, text) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  assert.equal(demuxDockerLogs(Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')])), 'hello\noops\n');
  assert.equal(demuxDockerLogs(Buffer.from('just text from a tty container\n')), 'just text from a tty container\n');
});

test('the environment is picked by id, or when exactly one is usable', () => {
  const eps = [{ Id: 1, Name: 'local', Status: 1 }, { Id: 2, Name: 'down', Status: 2 }];
  assert.equal(pickEndpoint(eps, undefined).Id, 1);
  assert.equal(pickEndpoint(eps, 2).Id, 2);
  assert.throws(() => pickEndpoint(eps, 9), UsageError);
  assert.throws(() => pickEndpoint([{ Id: 1, Status: 1 }, { Id: 2, Status: 1 }], undefined), /endpointId/);
});

// --- verbs against a fake Portainer ---
function fake(overrides = {}) {
  const calls = [];
  const stacks = overrides.stacks ?? [
    { Id: 5, Name: 'ironarmada', EndpointId: 1, Status: 1, Env: [{ name: 'APP_KEY', value: 'SECRET-VALUE' }], GitConfig: { URL: 'https://github.com/NinjaInc/IronArmada', ReferenceName: 'refs/heads/main', Authentication: null } },
    { Id: 6, Name: 'manual', EndpointId: 1, Status: 1, Env: [], GitConfig: null },
  ];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    const json = (value, status = 200) => ({ status, body: Buffer.from(JSON.stringify(value)) });
    if (path === '/api/endpoints') return json([{ Id: 1, Name: 'primary', Status: 1 }]);
    if (path === '/api/stacks') return json(stacks);
    if (path.startsWith('/api/endpoints/1/docker/containers/json')) return json([{ Id: 'abc', Names: ['/ironarmada-web'], Image: 'img:1', State: 'running', Status: 'Up 2 days' }]);
    if (path.includes('/logs')) return { status: 200, body: Buffer.from('log line\n') };
    return json({ Id: 99 });
  };
  const lines = [];
  return { call, calls, lines, ctx: { call, config: { redeployAllow: ['ironarmada'], allowedRepoPrefixes: PREFIXES, ...(overrides.config ?? {}) }, out: (l) => lines.push(l) } };
}
const mutating = (calls) => calls.filter((c) => c.method !== 'GET');

test('status is read-only and never prints environment values', async () => {
  const f = fake();
  assert.equal(await runVerb('status', [], f.ctx), 0);
  assert.equal(mutating(f.calls).length, 0);
  assert.ok(!f.lines.join('\n').includes('SECRET-VALUE'));
  assert.match(f.lines.join('\n'), /ironarmada/);
});

test('redeploy without --yes only prints the plan', async () => {
  const f = fake();
  await runVerb('redeploy', ['ironarmada'], f.ctx);
  assert.equal(mutating(f.calls).length, 0);
  assert.match(f.lines.join('\n'), /DRY RUN/);
});

test('redeploy --yes sends exactly one redeploy request for that stack', async () => {
  const f = fake();
  await runVerb('redeploy', ['ironarmada', '--yes'], f.ctx);
  const writes = mutating(f.calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PUT');
  assert.equal(writes[0].path, '/api/stacks/5/git/redeploy?endpointId=1');
  assert.equal(writes[0].body.prune, false);
});

test('redeploy refuses stacks outside the allow-list and stacks not made from git', async () => {
  await assert.rejects(runVerb('redeploy', ['manual', '--yes'], fake().ctx), /not in redeployAllow/);
  await assert.rejects(runVerb('redeploy', ['manual', '--yes'], fake({ config: { redeployAllow: ['*'] } }).ctx), /not created from a git repository/);
  await assert.rejects(runVerb('redeploy', ['nosuch', '--yes'], fake({ config: { redeployAllow: ['*'] } }).ctx), /not found/);
});

test('create-stack refuses a repo outside the allow-list and an existing name, before any request is made', async () => {
  const a = fake();
  await assert.rejects(runVerb('create-stack', ['newapp', '--repo', 'https://github.com/other/x', '--yes'], a.ctx), UsageError);
  assert.equal(a.calls.length, 0);
  await assert.rejects(runVerb('create-stack', ['ironarmada', '--repo', 'https://github.com/NinjaInc/x', '--yes'], fake().ctx), /already exists/);
});

test('create-stack --yes posts one request and never echoes env values', async () => {
  const f = fake();
  await runVerb('create-stack', ['newapp', '--repo', 'https://github.com/NinjaInc/newapp', '--env', 'DB_PASSWORD=hunter2', '--yes'], f.ctx);
  const writes = mutating(f.calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.deepEqual(writes[0].body.env, [{ name: 'DB_PASSWORD', value: 'hunter2' }]);
  assert.ok(!f.lines.join('\n').includes('hunter2'));
});

test('create-stack dry run changes nothing', async () => {
  const f = fake();
  await runVerb('create-stack', ['newapp', '--repo', 'https://github.com/NinjaInc/newapp'], f.ctx);
  assert.equal(mutating(f.calls).length, 0);
});

test('logs resolves the container by name and clamps the tail', async () => {
  const f = fake();
  await runVerb('logs', ['ironarmada-web', '--tail', '999999'], f.ctx);
  assert.match(f.calls.at(-1).path, /tail=2000/);
  await assert.rejects(runVerb('logs', ['nosuch'], fake().ctx), /No container named/);
});

test('there is no way to delete, stop or run arbitrary commands', async () => {
  for (const verb of ['delete', 'rm', 'stop', 'exec', 'prune', 'down']) await assert.rejects(runVerb(verb, ['x', '--yes'], fake().ctx), /Unknown command/);
});
