import assert from 'node:assert/strict';

import { test } from 'vitest';

import { hostOf, linkCitations } from '@/modules/web-search/utils/webSearch';

const sources = [
  { n: 1, title: 'A', url: 'https://a.example/page' },
  { n: 2, title: 'B', url: 'https://b.example/x_(y)' },
];

test('citation markers become links to the matching source, including side by side and inside sentences', () => {
  assert.equal(linkCitations('MCP is a protocol [1].', sources), 'MCP is a protocol [[1]](https://a.example/page).');
  assert.equal(linkCitations('Both agree [1][2].', sources), 'Both agree [[1]](https://a.example/page)[[2]](https://b.example/x_(y%29).');
});

test('markers for missing sources, and ordinary brackets, are left exactly as they are', () => {
  assert.equal(linkCitations('Unknown [7] and [x] and [1](already)', sources), 'Unknown [7] and [x] and [1](already)');
  assert.equal(linkCitations('no markers', []), 'no markers');
});

test('only http(s) sources are ever linked', () => {
  assert.equal(linkCitations('see [1]', [{ n: 1, title: 'x', url: 'javascript:alert(1)' }]), 'see [1]');
  assert.equal(linkCitations('see [1]', [{ n: 1, title: 'x', url: 'file:///etc/passwd' }]), 'see [1]');
});

test('hostOf shows a short host and survives garbage', () => {
  assert.equal(hostOf('https://www.docs.example.com/a/b?c=d'), 'docs.example.com');
  assert.equal(hostOf('not a url'), 'not a url');
});
