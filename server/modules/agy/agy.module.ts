import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgyRouter } from './agy.routes.js';
import { createAgyService } from './agy.service.js';

const agyHome = path.join(os.homedir(), '.gemini', 'antigravity-cli');

const agyService = createAgyService({
  settingsPath: path.join(agyHome, 'settings.json'),
  oauthTokenPath: path.join(agyHome, 'antigravity-oauth-token'),
  apiKeyPath: path.join(os.homedir(), '.cloudcli', 'agy.env'),
  fileSystem: {
    async readFile(filePath) {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async writeSecretFile(filePath, content) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Write to a 0600 temp file then rename, so the secret is never briefly world-readable.
      const tempPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, content, { mode: 0o600 });
      await fs.rename(tempPath, filePath);
      await fs.chmod(filePath, 0o600);
    },
    async removeFile(filePath) {
      await fs.rm(filePath, { force: true });
    },
    async exists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  },
});

/** Antigravity auth router assembled for the authenticated server mount. */
export const agyRoutes = createAgyRouter(agyService);

/** Launch-time environment for agy PTYs (GEMINI_API_KEY when configured). */
export const getAgyLaunchEnvironment = (): Promise<Record<string, string>> =>
  agyService.getLaunchEnvironment();
