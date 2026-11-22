// Runs the desktop status script's Python tests as part of `npm run test:scripts` (skipped when python3 is missing).
// Author: Josh Neufield (Archon Tech)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('desktop gpu-status.py: parsers, no-shell commands, read-only allow-listed HTTP', { skip: python.status !== 0 && 'python3 is not installed' }, () => {
  const result = spawnSync('python3', ['-B', '-I', '-m', 'unittest', 'discover', '-s', dir, '-p', 'test_*.py'], { encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /OK/);
});
