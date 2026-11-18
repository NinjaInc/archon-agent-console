import { AppError } from '@/shared/utils.js';

type AgyFileSystem = {
  readFile(path: string): Promise<string | null>;
  /** Writes with owner-only permissions (0600), creating parent directories. */
  writeSecretFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
};

type AgyDependencies = {
  fileSystem: AgyFileSystem;
  /** `~/.gemini/antigravity-cli/settings.json` - agy's own settings file. */
  settingsPath: string;
  /** App-owned owner-only file holding the API key (never agy's settings.json). */
  apiKeyPath: string;
  /** agy's OAuth token file; only its existence is ever inspected. */
  oauthTokenPath: string;
};

const API_KEY_PATTERN = /^[A-Za-z0-9_\-]{20,256}$/;

function parseSettings(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A hand-edited, invalid settings file is left for the user to repair.
    throw new AppError('agy settings.json is not valid JSON; fix it before changing auth.', {
      code: 'AGY_SETTINGS_INVALID',
      statusCode: 409,
    });
  }
}

/**
 * Creates the Antigravity auth service. Secrets are written only to an
 * owner-only file and are never returned, logged, or placed in an error.
 */
export function createAgyService(dependencies: AgyDependencies) {
  const { fileSystem } = dependencies;

  return {
    /** Reports how agy is authenticated without revealing any credential. */
    async getStatus() {
      const settings = parseSettings(await fileSystem.readFile(dependencies.settingsPath));
      return {
        apiKeyConfigured: await fileSystem.exists(dependencies.apiKeyPath),
        modelProvider: typeof settings.modelProvider === 'string' ? settings.modelProvider : null,
        oauthSignedIn: await fileSystem.exists(dependencies.oauthTokenPath),
      };
    },

    /** Stores the Gemini API key and selects the gemini model provider in agy's settings. */
    async setApiKey(apiKeyInput: unknown) {
      const apiKey = typeof apiKeyInput === 'string' ? apiKeyInput.trim() : '';
      if (!API_KEY_PATTERN.test(apiKey)) {
        // The submitted value is deliberately not echoed back.
        throw new AppError('API key has an unexpected format.', {
          code: 'AGY_API_KEY_INVALID',
          statusCode: 400,
        });
      }

      const settings = parseSettings(await fileSystem.readFile(dependencies.settingsPath));
      await fileSystem.writeSecretFile(dependencies.apiKeyPath, `GEMINI_API_KEY=${apiKey}\n`);
      await fileSystem.writeSecretFile(
        dependencies.settingsPath,
        `${JSON.stringify({ ...settings, modelProvider: 'gemini' }, null, 2)}\n`,
      );
      return this.getStatus();
    },

    /** Removes the stored key and, if we selected the gemini provider, unsets it so OAuth applies again. */
    async clearApiKey() {
      await fileSystem.removeFile(dependencies.apiKeyPath);
      const settings = parseSettings(await fileSystem.readFile(dependencies.settingsPath));
      if (settings.modelProvider === 'gemini') {
        delete settings.modelProvider;
        await fileSystem.writeSecretFile(dependencies.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      }
      return this.getStatus();
    },

    /** Environment to add to an agy PTY only; empty when no API key is configured. */
    async getLaunchEnvironment(): Promise<Record<string, string>> {
      const raw = await fileSystem.readFile(dependencies.apiKeyPath);
      const match = raw?.match(/^GEMINI_API_KEY=(.+)$/m);
      return match?.[1] ? { GEMINI_API_KEY: match[1].trim() } : {};
    },
  };
}
