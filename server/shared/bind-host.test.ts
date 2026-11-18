import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBindHost, isPrivateIPv4 } from './bind-host.js';

const local = () => ['127.0.0.1', '192.168.1.84'];

test('loopback is always allowed', () => {
  for (const h of ['127.0.0.1', '::1', 'localhost']) assert.deepEqual(evaluateBindHost(h, {}, local), { ok: true, lan: false });
});

test('wildcards, hostnames and public addresses are refused even with the opt-in', () => {
  const env = { ALLOW_LAN_BIND: 'true' };
  for (const h of ['0.0.0.0', '::', '', 'example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '300.1.1.1']) {
    assert.equal(evaluateBindHost(h, env, local).ok, false, h);
  }
});

test('a LAN address needs the explicit opt-in', () => {
  assert.equal(evaluateBindHost('192.168.1.84', {}, local).ok, false);
  assert.equal(evaluateBindHost('192.168.1.84', { ALLOW_LAN_BIND: 'yes' }, local).ok, false);
  assert.deepEqual(evaluateBindHost('192.168.1.84', { ALLOW_LAN_BIND: 'true' }, local), { ok: true, lan: true });
});

test('a LAN address must belong to this machine', () => {
  assert.equal(evaluateBindHost('192.168.1.99', { ALLOW_LAN_BIND: 'true' }, local).ok, false);
});

test('private range detection', () => {
  assert.ok(isPrivateIPv4('10.0.0.1') && isPrivateIPv4('172.16.5.5') && isPrivateIPv4('192.168.0.1'));
  assert.ok(!isPrivateIPv4('172.15.0.1') && !isPrivateIPv4('1.2.3.4'));
});
