import { createRemoteJWKSet } from 'jose';

import { AppError } from '@/shared/utils.js';

import { createCfAccessGate, createCfAccessUpgradeCheck, createCfAccessVerifier } from './cf-access.service.js';

const required = process.env.CF_ACCESS_REQUIRED === 'true';
const teamDomain = (process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const audience = (process.env.CF_ACCESS_AUD || '').trim();

if (required && (!teamDomain || !audience)) {
  // Fail closed: "required" with no way to verify would silently lock everyone out or, worse, be mistaken for protection.
  throw new AppError('CF_ACCESS_REQUIRED=true needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.', { code: 'CF_ACCESS_CONFIG_INVALID' });
}

const verifier = required
  ? createCfAccessVerifier({
      issuer: `https://${teamDomain}`,
      audience,
      // jose caches the key set and refetches it when Cloudflare rotates keys.
      keys: createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)),
    })
  : null;

/** Express middleware: first in the chain, so even static assets need a valid Access assertion when required. */
export const cfAccessGate = createCfAccessGate(verifier, required);

/** Websocket upgrade check used by the websocket gateway. */
export const verifyCfAccessUpgrade = createCfAccessUpgradeCheck(verifier, required);

/** Whether Cloudflare Access verification is enforced (logged at startup). */
export const isCfAccessRequired = required;
