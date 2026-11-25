import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopCheck, judgeDesktop } from '../gpu-arbiter.desktop.js';

const quiet = { gpu: { utilization_percent: 1 }, games_running: [], launchers_running: [], non_ours_vram_mb: 300 };

test('quiet desktop is free; a game or heavy foreign VRAM is busy', () => {
  assert.equal(judgeDesktop(quiet), false);
  assert.equal(judgeDesktop({ ...quiet, games_running: ['eldenring.exe'] }), true);
  assert.equal(judgeDesktop({ ...quiet, non_ours_vram_mb: 1500 }), true);
});

test('a launcher counts only while the GPU is working', () => {
  assert.equal(judgeDesktop({ ...quiet, launchers_running: ['steam.exe'] }), false);
  assert.equal(judgeDesktop({ ...quiet, launchers_running: ['steam.exe'], gpu: { utilization_percent: 40 } }), true);
});

test('incomplete facts mean cannot tell', () => {
  assert.equal(judgeDesktop({ ...quiet, non_ours_vram_mb: null }), null);
  assert.equal(judgeDesktop({ ...quiet, gpu: null }), null);
  assert.equal(judgeDesktop({}), null);
});

test('no URL, a failed request and a bad status all return null', async () => {
  assert.equal(await createDesktopCheck(null)(), null);
  assert.equal(await createDesktopCheck('http://127.0.0.1:1/gpu', async () => { throw new Error('x'); })(), null);
  assert.equal(await createDesktopCheck('http://x/gpu', async () => new Response('no', { status: 500 }))(), null);
  assert.deepEqual(await createDesktopCheck('http://x/gpu', async () => Response.json(quiet))(), { externalBusy: false });
});
