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
