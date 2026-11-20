import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProdClaudeLaunch, loadProdClaude, parseProdClaudeConfig } from '../prod-claude.service.js';

const good = { host: '192.0.2.10', user: 'deploy', port: 2222, remoteCommand: '/home/deploy/.local/bin/claude' };

test('a valid config is accepted and defaults are filled in', () => {
  assert.deepEqual(parseProdClaudeConfig({ host: 'prod.example.com', user: 'deploy' }), { host: 'prod.example.com', user: 'deploy', port: 22, remoteCommand: 'claude', label: 'Prod Claude' });
  assert.equal(parseProdClaudeConfig({ ...good, label: '  Live  ' }).label, 'Live');
});

test('hosts and users cannot smuggle ssh options or shell syntax', () => {
  for (const host of ['-oProxyCommand=touch /tmp/x', '-J evil', 'a b', 'a;b', 'a$(x)', '', 'host\nname', '.leading', 'trailing-', 'a/b', undefined]) {
    assert.throws(() => parseProdClaudeConfig({ ...good, host }), /host/, String(host));
  }
  for (const user of ['-oProxyCommand=x', 'a b', 'root;id', '', '1digit', 'a@b', undefined]) {
    assert.throws(() => parseProdClaudeConfig({ ...good, user }), /user/, String(user));
  }
});

test('the remote command is one plain path or name, never an option or a pipeline', () => {
  for (const remoteCommand of ['-o', '--help', 'claude; rm -rf /', 'claude && id', '$(id)', 'a b', '', '`id`', '../..;x']) {
    assert.throws(() => parseProdClaudeConfig({ ...good, remoteCommand }), /remoteCommand/, remoteCommand);
  }
  assert.equal(parseProdClaudeConfig({ ...good, remoteCommand: '~/.local/bin/claude' }).remoteCommand, '~/.local/bin/claude');
});

test('ports must be real ports', () => {
  for (const port of [0, 70000, 'x', 22.5, -1]) assert.throws(() => parseProdClaudeConfig({ ...good, port }), /port/, String(port));
});

test('the ssh launch isolates the session: pinned host key, own key only, no agent, no forwarding, no config files', () => {
  const launch = buildProdClaudeLaunch(parseProdClaudeConfig(good), '/cfg/prod');
  const joined = launch.args.join(' ');
  assert.equal(launch.file, 'ssh');
  assert.ok(launch.args.includes('-tt'));
  assert.equal(launch.args[launch.args.indexOf('-F') + 1], '/dev/null');
  assert.equal(launch.args[launch.args.indexOf('-i') + 1], '/cfg/prod/id_ed25519');
  for (const required of ['IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/cfg/prod/known_hosts', 'GlobalKnownHostsFile=/dev/null', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'BatchMode=yes']) {
    assert.ok(joined.includes(required), required);
  }
  assert.equal(launch.args[launch.args.indexOf('-p') + 1], '2222');
  // destination, then the single remote command, last
  assert.deepEqual(launch.args.slice(-2), ['deploy@192.0.2.10', '/home/deploy/.local/bin/claude']);
});

test('nothing from this server\'s environment reaches the remote session', () => {
  process.env.GEMINI_API_KEY = 'secret-gemini';
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
  process.env.ANTHROPIC_API_KEY = 'secret-anthropic';
  try {
    const launch = buildProdClaudeLaunch(parseProdClaudeConfig(good), '/cfg/prod');
    assert.deepEqual(Object.keys(launch.env).sort(), ['LANG', 'PATH']);
    assert.ok(!JSON.stringify(launch).includes('secret-'));
    assert.ok(!('SSH_AUTH_SOCK' in launch.env));
  } finally {
    delete process.env.GEMINI_API_KEY; delete process.env.SSH_AUTH_SOCK; delete process.env.ANTHROPIC_API_KEY;
  }
});

function files(map: Record<string, string>) {
  return { directory: '/cfg/prod', readFile: async (p: string) => map[p] ?? null, exists: async (p: string) => p in map };
}

test('not configured means no tab: loading returns null', async () => {
  assert.equal(await loadProdClaude(files({})), null);
});

test('it reports whether the key and the pinned host key are in place', async () => {
  const cfg = JSON.stringify(good);
  const bare = await loadProdClaude(files({ '/cfg/prod/config.json': cfg }));
  assert.deepEqual([bare?.keyPresent, bare?.hostKeyPinned], [false, false]);
  const ready = await loadProdClaude(files({ '/cfg/prod/config.json': cfg, '/cfg/prod/id_ed25519': 'k', '/cfg/prod/known_hosts': 'h' }));
  assert.deepEqual([ready?.keyPresent, ready?.hostKeyPinned], [true, true]);
});

test('a broken config file is an error, not a silent hidden tab', async () => {
  await assert.rejects(loadProdClaude(files({ '/cfg/prod/config.json': '{nope' })), /not valid JSON/);
  await assert.rejects(loadProdClaude(files({ '/cfg/prod/config.json': JSON.stringify({ host: '-x', user: 'a' }) })), /host/);
});
