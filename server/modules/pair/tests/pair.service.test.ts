import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { PairAgents } from '../pair.agents.js';
import { pairGit } from '../pair.git.js';
import { createPairService } from '../pair.service.js';

import { tempRepo } from './helpers.js';

function setup(options: { verdicts?: string[]; testsPass?: boolean; hang?: boolean } = {}) {
  const { root, repo } = tempRepo();
  const verdicts = options.verdicts ?? ['VERDICT: READY'];
  const calls: string[] = [];
  let edits = 0;
  const agents: PairAgents = {
    plan: async (_prompt, _repo, signal) => {
      if (options.hang) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('killed'))));
      return 'the plan';
    },
    execute: async (_prompt, directory) => {
      calls.push('execute');
      edits += 1;
      fs.writeFileSync(path.join(directory, 'a.txt'), `edit ${edits}\n`);
      return 'done';
    },
    test: async () => { calls.push('test'); return { passed: options.testsPass ?? true, output: 'out' }; },
    review: async () => { calls.push('review'); return verdicts.shift() ?? 'VERDICT: FIX'; },
  };
  const dependencies = { directory: path.join(root, 'data'), git: pairGit, agents, detectTests: async () => ['npm', 'test'], resolveProjectDir: async () => repo };
  const service = createPairService(dependencies);
  const input = { projectId: 'p', task: 'change a', model: 'm' };
  const toDiff = async () => {
    const { id } = await service.start(1, input);
    await service.settled(id);
    service.approvePlan(1, id);
    await service.settled(id);
    return id;
  };
  const approve = async (id: string) => {
    await service.approveDiff(1, id, service.get(1, id).diff!.hash);
    await service.settled(id);
    return service.get(1, id);
  };
  return { service, dependencies, calls, toDiff, approve, input, repo };
}

test('nothing edits before the plan is approved and nothing runs before the change is approved', async () => {
  const { service, calls, toDiff, approve } = setup();
  const id = await toDiff();
  assert.equal(service.get(1, id).status, 'diff-ready');
  assert.deepEqual(calls, ['execute']);
  const done = await approve(id);
  assert.deepEqual(calls, ['execute', 'test', 'review']);
  assert.equal(done.verdict, 'ready');
  const kept = await service.keep(1, id);
  assert.equal(kept.branch, `pair/${id}`);
});

test('a wrong hash or a change made after viewing runs nothing', async () => {
  const { service, calls, toDiff, dependencies } = setup();
  const id = await toDiff();
  const hash = service.get(1, id).diff!.hash;
  await assert.rejects(service.approveDiff(1, id, 'nope'), /not the one you looked at/);
  fs.writeFileSync(path.join(dependencies.directory, 'worktrees', id, 'sneaky.js'), 'x\n');
  await assert.rejects(service.approveDiff(1, id, hash), /not the one you looked at/);
  assert.deepEqual(calls, ['execute']);
  assert.ok(service.get(1, id).diff!.files.includes('sneaky.js'));
});

test('fix rounds need approval each time, stop after two, and end as needs-work', async () => {
  const { service, calls, toDiff, approve } = setup({ verdicts: ['VERDICT: FIX', 'VERDICT: FIX', 'VERDICT: FIX'] });
  const id = await toDiff();
  assert.equal((await approve(id)).status, 'diff-ready');
  assert.equal((await approve(id)).status, 'diff-ready');
  const last = await approve(id);
  assert.equal(last.status, 'done');
  assert.equal(last.verdict, 'needs-work');
  assert.equal(calls.filter((call) => call === 'execute').length, 3);
  await assert.rejects(service.approveDiff(1, id, last.diff!.hash), /not possible/);
});

test('failing tests outrank a READY review, and a review without a verdict is unclear', async () => {
  const failing = setup({ testsPass: false });
  assert.equal((await failing.approve(await failing.toDiff())).verdict, 'needs-work');
  const vague = setup({ verdicts: ['looks fine'] });
  assert.equal((await vague.approve(await vague.toDiff())).verdict, 'unclear');
});

test('runs are private to their user, one works at a time, stop ends it, and secrets are refused', async () => {
  const { service, input } = setup({ hang: true });
  await assert.rejects(service.start(1, { ...input, task: `use ${'ghp_'}${'a1B2'.repeat(9)}` }), /Not started/);
  const { id } = await service.start(1, input);
  assert.throws(() => service.get(2, id), /not found/);
  await assert.rejects(service.start(1, input), /Another pair run/);
  service.stop(1, id);
  await service.settled(id);
  assert.equal(service.get(1, id).error, 'Stopped.');
  assert.equal((await service.discard(1, id)).status, 'discarded');
});

test('a restart marks working runs failed and keeps finished ones', async () => {
  const { service, input, dependencies } = setup({ hang: true });
  const { id } = await service.start(1, input);
  const again = createPairService(dependencies);
  assert.equal(again.get(1, id).status, 'failed');
  service.stop(1, id);
  await service.settled(id);
});
