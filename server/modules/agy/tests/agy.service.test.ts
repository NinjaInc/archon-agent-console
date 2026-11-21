import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgyService } from '../agy.service.js';

function memoryService(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const modes: string[] = [];
  const service = createAgyService({
    settingsPath: '/h/settings.json',
    apiKeyPath: '/h/agy.env',
    oauthTokenPath: '/h/oauth',
    fileSystem: {
      readFile: async (p) => files.get(p) ?? null,
      writeSecretFile: async (p, c) => { files.set(p, c); modes.push(p); },
      removeFile: async (p) => { files.delete(p); },
      exists: async (p) => files.has(p),
    },
  });
  return { service, files, modes };
}

const KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE_12345';

test('setApiKey stores the key privately and merges modelProvider without losing settings', async () => {
  const { service, files } = memoryService({ '/h/settings.json': '{"colorScheme":"tokyo night"}' });
  const status = await service.setApiKey(KEY);

  assert.deepEqual(status, { apiKeyConfigured: true, modelProvider: 'gemini', oauthSignedIn: false });
  assert.deepEqual(JSON.parse(files.get('/h/settings.json')!), { colorScheme: 'tokyo night', modelProvider: 'gemini' });
  assert.ok(!files.get('/h/settings.json')!.includes(KEY), 'key must not be written to agy settings.json');
  assert.deepEqual(await service.getLaunchEnvironment(), { GEMINI_API_KEY: KEY });
});

test('status and errors never contain the key', async () => {
  const { service } = memoryService();
  await service.setApiKey(KEY);
  assert.ok(!JSON.stringify(await service.getStatus()).includes(KEY));

  await assert.rejects(
    () => service.setApiKey(`bad key ${KEY}`),
    (error: Error) => !error.message.includes(KEY),
  );
});

test('malformed keys are rejected before anything is written', async () => {
  const { service, files } = memoryService();
  for (const bad of ['', 'short', 'has space in the middle of the key 123456', 42, null]) {
    await assert.rejects(() => service.setApiKey(bad), /unexpected format/);
  }
  assert.equal(files.size, 0);
});

test('an invalid settings.json is not overwritten', async () => {
  const { service, files } = memoryService({ '/h/settings.json': '{not json' });
  await assert.rejects(() => service.setApiKey(KEY), /not valid JSON/);
  assert.equal(files.get('/h/settings.json'), '{not json');
  assert.equal(files.has('/h/agy.env'), false);
});

test('clearApiKey removes the key and unsets the provider it set', async () => {
  const { service, files } = memoryService({ '/h/settings.json': '{"colorScheme":"x"}' });
  await service.setApiKey(KEY);
  const status = await service.clearApiKey();

  assert.deepEqual(status, { apiKeyConfigured: false, modelProvider: null, oauthSignedIn: false });
  assert.deepEqual(JSON.parse(files.get('/h/settings.json')!), { colorScheme: 'x' });
  assert.deepEqual(await service.getLaunchEnvironment(), {});
});

// ---- allowed commands (agy permissions.allow) ----

function permissionsHarness(initial: Record<string, unknown> | null) {
  const files = new Map<string, string>();
  if (initial) files.set('/settings.json', JSON.stringify(initial));
  const service = createAgyService({
    settingsPath: '/settings.json',
    apiKeyPath: '/agy.env',
    oauthTokenPath: '/oauth',
    fileSystem: {
      readFile: async (p) => files.get(p) ?? null,
      writeSecretFile: async (p, c) => { files.set(p, c); },
      removeFile: async (p) => { files.delete(p); },
      exists: async (p) => files.has(p),
    },
  });
  return { service, read: () => JSON.parse(files.get('/settings.json') ?? '{}') };
}

test('allowed commands are saved as command(<line>) rules and keep every other setting and rule', async () => {
  const { service, read } = permissionsHarness({ model: 'x', trustedWorkspaces: ['/a'], permissions: { allow: ['read(**)'], deny: ['command(rm -rf /)'] } });
  const result = await service.setAllowedCommands(['npm test', 'git status', 'npm test']);
  assert.deepEqual(result, { commands: ['npm test', 'git status'], otherRules: 1 });
  assert.deepEqual(read().permissions, { allow: ['read(**)', 'command(npm test)', 'command(git status)'], deny: ['command(rm -rf /)'] });
  assert.equal(read().model, 'x');
  assert.deepEqual(read().trustedWorkspaces, ['/a']);
  assert.deepEqual((await service.setAllowedCommands([])).commands, []);
  assert.deepEqual(read().permissions.allow, ['read(**)']);
});

test('only plain exact command lines are accepted: no shell syntax, wildcards, quotes or empties', async () => {
  const { service, read } = permissionsHarness(null);
  const bad = ['', '  ', 'npm test; rm -rf ~', 'a && b', 'a | b', 'a > b', 'echo $(id)', 'echo `id`', 'touch *', 'ls ?', "echo 'x'", 'echo "x"', 'a\nb', 'a  b', 'x'.repeat(201), '(ls)', 'a\\b'];
  for (const line of bad) {
    await assert.rejects(service.setAllowedCommands([line]), { code: 'AGY_COMMAND_INVALID' }, JSON.stringify(line));
  }
  await assert.rejects(service.setAllowedCommands('npm test'), { code: 'AGY_COMMANDS_INVALID' });
  await assert.rejects(service.setAllowedCommands(Array.from({ length: 51 }, (_, i) => `cmd${i}`)), { code: 'AGY_COMMANDS_INVALID' });
  assert.deepEqual(read(), {});
});

test('reading allowed commands tolerates a missing file and other rule types', async () => {
  assert.deepEqual(await permissionsHarness(null).service.getAllowedCommands(), { commands: [], otherRules: 0 });
  const { service } = permissionsHarness({ permissions: { allow: ['command(ls -la)', 'write(/tmp/**)', 42] } });
  assert.deepEqual(await service.getAllowedCommands(), { commands: ['ls -la'], otherRules: 1 });
});
