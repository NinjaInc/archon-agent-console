import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadComfyuiConfig } from '../comfyui.config.js';

test('defaults: unconfigured until COMFYUI_BASE_URL is set, loopback fallback, images dir outside the repo', () => {
  const config = loadComfyuiConfig({});
  assert.equal(config.baseUrl, 'http://127.0.0.1:8188');
  assert.equal(config.configured, false);
  assert.equal(config.problem, undefined);
  assert.equal(config.imagesDir, path.join(os.homedir(), '.local', 'share', 'archon-agent-console', 'images'));
  assert.equal(config.timeoutMs, 180_000);
  assert.equal(config.heartbeatIntervalMs, 30_000);
  assert.equal(config.statusTimeoutMs, 3_000);
});

test('accepts loopback and private LAN hosts and strips trailing paths', () => {
  const accepted = [
    'http://127.0.0.1:8188',
    'http://localhost:8188',
    'http://[::1]:8188',
    'http://192.168.1.50:8188/some/subpath/',
    'http://10.0.0.12:8188',
    'http://172.16.4.9:8188',
    'http://desktop-gpu:8188',
    'http://rig.local:8188',
  ];
  for (const raw of accepted) {
    const config = loadComfyuiConfig({ COMFYUI_BASE_URL: raw });
    assert.equal(config.problem, undefined, raw);
    assert.equal(config.configured, true, raw);
  }
  assert.equal(
    loadComfyuiConfig({ COMFYUI_BASE_URL: 'http://192.168.1.50:8188/some/subpath/' }).baseUrl,
    'http://192.168.1.50:8188',
  );
});

test('refuses public hosts, non-http schemes, embedded credentials, and malformed URLs without throwing', () => {
  const refused = [
    'https://comfy.example.com',
    'http://8.8.8.8:8188',
    'http://1.1.1.1:8188',
    'http://172.32.0.1:8188',
    'http://100.64.0.1:8188',
    'ftp://127.0.0.1:8188',
    'http://user:pass@127.0.0.1:8188',
    'not a valid url',
  ];
  for (const raw of refused) {
    const config = loadComfyuiConfig({ COMFYUI_BASE_URL: raw });
    assert.ok(config.problem, `${raw} must set problem`);
    assert.equal(config.configured, false, `${raw} must remain unconfigured`);
    assert.equal(config.baseUrl, 'http://127.0.0.1:8188', `${raw} must keep safe loopback default`);
  }
});

test('resolves custom COMFYUI_IMAGES_DIR and rejects traversal in COMFYUI_CHECKPOINT without throwing', () => {
  const custom = loadComfyuiConfig({
    COMFYUI_BASE_URL: 'http://127.0.0.1:8188',
    COMFYUI_IMAGES_DIR: '~/custom-images',
  });
  assert.equal(custom.imagesDir, path.join(os.homedir(), 'custom-images'));

  const badCheckpoint = loadComfyuiConfig({
    COMFYUI_BASE_URL: 'http://127.0.0.1:8188',
    COMFYUI_CHECKPOINT: '../etc/passwd',
  });
  assert.ok(badCheckpoint.problem);
  assert.equal(badCheckpoint.configured, false);
});
