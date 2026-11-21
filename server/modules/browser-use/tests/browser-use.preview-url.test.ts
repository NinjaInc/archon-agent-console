import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePreviewUrl } from '@/modules/browser-use/browser-use.service.js';

test('a bare local address opens over http, anything else over https', () => {
  assert.equal(normalizePreviewUrl('localhost:5173'), 'http://localhost:5173/');
  assert.equal(normalizePreviewUrl('127.0.0.1:8000/app'), 'http://127.0.0.1:8000/app');
  assert.equal(normalizePreviewUrl('10.0.0.5:4321'), 'http://10.0.0.5:4321/');
  assert.equal(normalizePreviewUrl('10.1.2.3:80'), 'http://10.1.2.3/');
  assert.equal(normalizePreviewUrl('example.com'), 'https://example.com/');
});

test('an explicit scheme is kept; only http and https are allowed', () => {
  assert.equal(normalizePreviewUrl('http://example.com:81/x'), 'http://example.com:81/x');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', 'data:text/html,hi', 'chrome://settings']) {
    assert.throws(() => normalizePreviewUrl(bad), /./, bad);
  }
});

test('credentials in the URL, empty input and absurd lengths are refused', () => {
  assert.throws(() => normalizePreviewUrl('http://user:pw@localhost:3000'), /credentials/);
  assert.throws(() => normalizePreviewUrl('   '));
  assert.throws(() => normalizePreviewUrl(`http://example.com/${'a'.repeat(2100)}`), /too long/);
});
