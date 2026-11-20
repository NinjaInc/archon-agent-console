import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProdClaudeRouter } from './prod-claude.routes.js';
import { loadProdClaude, type ProdClaudeLaunch } from './prod-claude.service.js';

// Private to this machine and this user: ~/.config/archon-console/prod-claude (mode 0700), created by
// scripts/setup-prod-claude.sh. Nothing in here is ever sent to the browser.
const directory = process.env.PROD_CLAUDE_DIR || path.join(os.homedir(), '.config', 'archon-console', 'prod-claude');

const files = {
  directory,
  async readFile(filePath: string) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async exists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

/** Prod Claude status router assembled for the authenticated server mount. */
export const prodClaudeRoutes = createProdClaudeRouter(() => loadProdClaude(files));

/** The ssh launch for the Prod Claude terminal, or null when it is not set up or not ready (key and pinned host key). */
export async function getProdClaudeLaunch(): Promise<ProdClaudeLaunch | null> {
  const loaded = await loadProdClaude(files);
  return loaded && loaded.keyPresent && loaded.hostKeyPinned ? loaded.launch : null;
}
