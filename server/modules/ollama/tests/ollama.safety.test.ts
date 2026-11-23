import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, findSecrets } from '@/shared/utils.js';

import { classifyPath, inputBudgetChars, prepareDiff } from '../ollama.diff.js';

// ---- secret guard ------------------------------------------------------------------------------------------------

test('obvious secrets are found, and only the kind is reported, never the value', () => {
  const samples: Array<[string, string]> = [
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', 'a private key'],
    ['aws = AKIAIOSFODNN7EXAMPLE', 'an AWS access key'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'a GitHub token'],
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'an API key (sk-...)'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'a bearer token'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'a JSON web token'],
    ['postgres://admin:hunter2pass@db.internal:5432/app', 'a URL with a password in it'],
    ['DATABASE_PASSWORD=hunter2hunter2', 'an environment secret (NAME=value)'],
    ['+export STRIPE_API_KEY=abcd1234efgh5678', 'an environment secret (NAME=value)'],
    ['{"password": "correct-horse-battery"}', 'a quoted secret value'],
    ["const apiKey = 'abcdef1234567890';", 'a quoted secret value'],
  ];
  for (const [text, kind] of samples) {
    const found = findSecrets(text);
    assert.ok(found.includes(kind), `expected "${kind}" in ${JSON.stringify(found)} for: ${text.slice(0, 40)}`);
    for (const value of ['hunter2hunter2', 'AKIAIOSFODNN7EXAMPLE', 'correct-horse-battery']) assert.equal(JSON.stringify(found).includes(value), false);
  }
});

test('ordinary code and prose that merely mention secrets are not blocked', () => {
  const clean = [
    'const token = request.headers.authorization;',
    'if (!password) throw new Error("password required");',
    'function verifyToken(token: string): boolean { return token.length > 0; }',
    'The API key is stored in the settings screen.',
    'password: string;',
    'Run `export API_KEY` before starting.',
    'git commit -m "fix: refresh token on expiry"',
    'GET /api/users?limit=20 200 12ms',
  ];
  for (const text of clean) assert.deepEqual(findSecrets(text), [], text);
});

// ---- diff preparation --------------------------------------------------------------------------------------------

const file = (name: string, body = '+added line\n') => `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,2 @@\n context\n${body}`;
const binary = (name: string) => `diff --git a/${name} b/${name}\nindex 111..222 100644\nBinary files a/${name} and b/${name} differ\n`;

test('lockfiles, secret files and binaries are dropped and reported; source files stay', () => {
  const diff = file('src/app.ts') + file('package-lock.json', '+x\n') + file('.env', '+A=b\n') + file('.env.production', '+A=b\n') + binary('logo.png') + file('deploy/server.pem') + file('yarn.lock') + file('docs/readme.md');
  const result = prepareDiff(diff, 100_000);
  assert.deepEqual(result.included, ['src/app.ts', 'docs/readme.md']);
  assert.deepEqual(result.excluded.map((entry) => `${entry.path}:${entry.reason}`).sort(), ['.env.production:secret file', '.env:secret file', 'deploy/server.pem:secret file', 'logo.png:binary file', 'package-lock.json:lockfile', 'yarn.lock:lockfile']);
  assert.equal(result.text.includes('package-lock.json'), false);
  assert.equal(result.text.includes('A=b'), false);
});

test('.env.example style templates are kept, real .env files are not', () => {
  assert.equal(classifyPath('.env'), 'secret file');
  assert.equal(classifyPath('apps/web/.env.local'), 'secret file');
  assert.equal(classifyPath('.env.example'), null);
  assert.equal(classifyPath('config/.env.sample'), null);
  assert.equal(classifyPath('Cargo.lock'), 'lockfile');
  assert.equal(classifyPath('go.sum'), 'lockfile');
  assert.equal(classifyPath('src/lock.ts'), null);
});

test('a diff made only of excluded files is refused with the reasons, not sent empty', () => {
  assert.throws(() => prepareDiff(file('package-lock.json') + file('.env'), 10_000), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'OLLAMA_NOTHING_TO_SEND');
    assert.match(error.message, /package-lock\.json: lockfile/);
    return true;
  });
});

test('a diff that does not fit the 8k context is refused with its size, never silently truncated', () => {
  const budget = inputBudgetChars(8192);
  assert.equal(budget, 18_432);
  const big = file('src/big.ts', `${'+const line = 1;\n'.repeat(2000)}`);
  assert.throws(() => prepareDiff(big, budget), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'OLLAMA_INPUT_TOO_LARGE');
    assert.equal(error.statusCode, 413);
    assert.match(error.message, /Nothing was sent/);
    assert.match(error.message, /too big/);
    return true;
  });
  assert.doesNotThrow(() => prepareDiff(file('src/small.ts'), budget));
});

test('excluding a huge lockfile is what lets a real change fit', () => {
  const budget = inputBudgetChars(8192);
  const lock = file('package-lock.json', `${'+    "resolved": "https://registry.example/pkg.tgz",\n'.repeat(3000)}`);
  const result = prepareDiff(file('src/small.ts') + lock, budget);
  assert.deepEqual(result.included, ['src/small.ts']);
});

test('the budget shrinks with the context window and never goes below a floor', () => {
  assert.equal(inputBudgetChars(4096), 6144);
  assert.equal(inputBudgetChars(2048), 1000);
});
