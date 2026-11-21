// cfAccessGate: used by the server entrypoint as the first HTTP middleware to require a valid Cloudflare Access assertion.
export { cfAccessGate } from './cf-access.module.js';
// verifyCfAccessUpgrade: used by WebSocket setup to apply the same requirement to upgrades.
export { verifyCfAccessUpgrade } from './cf-access.module.js';
// isCfAccessRequired: used by the server entrypoint to log whether Access verification is enforced.
export { isCfAccessRequired } from './cf-access.module.js';
