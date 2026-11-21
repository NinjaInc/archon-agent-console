// @ts-nocheck -- web-push does not provide declarations in this project.
import webPush from 'web-push';

import { getConnection } from '../database/index.js';

let cachedKeys = null;
const db = getConnection();

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get();
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  // The VAPID subject tells push services who is sending. Use VAPID_SUBJECT, else this console's own https
  // address (APP_ORIGIN); a made-up mailto: on a .local domain is rejected by some push services.
  const origin = process.env.APP_ORIGIN || '';
  const subject = process.env.VAPID_SUBJECT || (/^https:\/\//.test(origin) ? origin : 'mailto:noreply@claudecodeui.local');
  webPush.setVapidDetails(
    subject,
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
