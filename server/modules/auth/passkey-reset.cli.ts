#!/usr/bin/env node
/**
 * passkey:reset - server-side recovery.
 *
 * Author: Josh Neufield (Archon Tech)
 *
 * Wipes every registered passkey and login session and prints a fresh one-time
 * bootstrap token (valid 15 minutes). Must be run on the server, as the user
 * that owns the database. There is no email/SMS recovery by design.
 */
// Load .env (DATABASE_PATH etc.) before the database modules are evaluated, as the main CLI does.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

import { initializeDatabase } from '@/modules/database/index.js';

import { resetPasskeyCredentials } from './auth.module.js';

await initializeDatabase();
const { token, expiresAt } = resetPasskeyCredentials();

console.log('');
console.log('All passkeys and sessions have been removed.');
console.log(`New bootstrap token (single use, expires ${new Date(expiresAt).toISOString()}):`);
console.log('');
console.log(`  ${token}`);
console.log('');
process.exit(0);
