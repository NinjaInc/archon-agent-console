import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_NUM_CTX, isPrivateHost, loadOllamaConfig } from '../ollama.config.js';

test('defaults: loopback address, qwen3:8b, 8192 context, 120 s first-token wait, 30 s idle, native API, off until configured', () => {
  const config = loadOllamaConfig({});
  assert.equal(config.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(config.model, 'qwen3:8b');
  assert.equal(config.numCtx, 8192);
  assert.equal(config.timeoutMs, 120_000);
  assert.equal(config.idleTimeoutMs, 30_000);
  assert.equal(config.api, 'native');
  assert.equal(config.keepAlive, '5m');
  assert.equal(config.configured, false);
  assert.equal(config.problem, undefined);
});

test('setting OLLAMA_BASE_URL (or OLLAMA_ENABLED) turns the backend on', () => {
  assert.equal(loadOllamaConfig({ OLLAMA_BASE_URL: 'http://10.0.0.5:11434' }).configured, true);
  assert.equal(loadOllamaConfig({ OLLAMA_ENABLED: 'true' }).configured, true);
  assert.equal(loadOllamaConfig({ OLLAMA_ENABLED: 'yes' }).configured, false);
});

test('private and LAN addresses are accepted, trailing slashes and paths are dropped', () => {
  for (const url of ['http://192.168.1.50:11434', 'http://10.1.2.3:11434/', 'http://172.20.0.9:11434', 'http://gaming-pc:11434', 'http://desk.local:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
    const config = loadOllamaConfig({ OLLAMA_BASE_URL: url });
    assert.equal(config.problem, undefined, url);
  }
  assert.equal(loadOllamaConfig({ OLLAMA_BASE_URL: 'http://192.168.1.50:11434/some/path/' }).baseUrl, 'http://192.168.1.50:11434');
});

test('public hosts, other schemes and embedded credentials are refused and the backend stays on the safe default', () => {
  for (const url of ['http://8.8.8.8:11434', 'https://ollama.example.com', 'http://172.32.0.1:11434', 'ftp://192.168.1.5', 'http://user:pw@192.168.1.5:11434', 'not a url']) {
    const config = loadOllamaConfig({ OLLAMA_BASE_URL: url });
    assert.ok(config.problem, `${url} should be refused`);
    assert.equal(config.baseUrl, 'http://127.0.0.1:11434', 'a refused value must never become the target');
  }
});

test('isPrivateHost covers the ranges that matter', () => {
  assert.equal(isPrivateHost('192.168.0.1'), true);
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.31.255.255'), true);
  assert.equal(isPrivateHost('172.15.0.1'), false);
  assert.equal(isPrivateHost('100.64.0.1'), false);
  assert.equal(isPrivateHost('1.1.1.1'), false);
  assert.equal(isPrivateHost('999.1.1.1'), false);
  assert.equal(isPrivateHost('fd12:3456::1'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('the context window can be lowered but never reaches 32k, whatever the environment says', () => {
  assert.equal(loadOllamaConfig({ OLLAMA_NUM_CTX: '4096' }).numCtx, 4096);
  assert.equal(loadOllamaConfig({ OLLAMA_NUM_CTX: '32768' }).numCtx, MAX_NUM_CTX);
  assert.ok(MAX_NUM_CTX < 32768);
  assert.equal(loadOllamaConfig({ OLLAMA_NUM_CTX: '100' }).numCtx, 2048);
  assert.equal(loadOllamaConfig({ OLLAMA_NUM_CTX: 'abc' }).numCtx, 8192);
});

test('timeouts, keep-alive, API mode and model are read and sanitised', () => {
  const config = loadOllamaConfig({ OLLAMA_TIMEOUT_MS: '180000', OLLAMA_IDLE_TIMEOUT_MS: '45000', OLLAMA_KEEP_ALIVE: '10m', OLLAMA_API: 'openai', OLLAMA_MODEL: 'llama3.2:3b' });
  assert.deepEqual([config.timeoutMs, config.idleTimeoutMs, config.keepAlive, config.api, config.model], [180_000, 45_000, '10m', 'openai', 'llama3.2:3b']);
  assert.equal(loadOllamaConfig({ OLLAMA_KEEP_ALIVE: '-1' }).keepAlive, '5m', 'keeping the model in VRAM forever is not allowed');
  assert.equal(loadOllamaConfig({ OLLAMA_TIMEOUT_MS: '5' }).timeoutMs, 10_000);
  assert.ok(loadOllamaConfig({ OLLAMA_MODEL: 'bad model; rm -rf' }).problem);
});
