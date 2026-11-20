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
const MAX_ALLOWED_COMMANDS = 50;
// A rule only ever allows ONE exact, simple command line: words separated by single spaces, no shell
// syntax. agy matches the whole line, so `git status` allows `git status` and nothing chained after it.
const COMMAND_LINE = /^[A-Za-z0-9._/:=@,+-]+( [A-Za-z0-9._/:=@,+-]+)*$/;
const COMMAND_RULE = /^command\((.*)\)$/s;

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

function readAllowRules(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions;
  const allow = typeof permissions === 'object' && permissions !== null ? (permissions as { allow?: unknown }).allow : undefined;
  return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === 'string') : [];
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

    /** The exact command lines agy may run without asking (`permissions.allow` entries of the form command(<line>)). */
    async getAllowedCommands() {
      const settings = parseSettings(await fileSystem.readFile(dependencies.settingsPath));
      const allow = readAllowRules(settings);
      return {
        commands: allow.map((rule) => COMMAND_RULE.exec(rule)?.[1]).filter((line): line is string => typeof line === 'string'),
        otherRules: allow.filter((rule) => !COMMAND_RULE.test(rule)).length,
      };
    },

    /** Replaces the allowed command lines; other kinds of rules in settings.json are kept as they are. */
    async setAllowedCommands(input: unknown) {
      if (!Array.isArray(input) || input.length > MAX_ALLOWED_COMMANDS) {
        throw new AppError(`Send up to ${MAX_ALLOWED_COMMANDS} commands`, { code: 'AGY_COMMANDS_INVALID', statusCode: 400 });
      }
      const commands = [...new Set(input.map((entry) => (typeof entry === 'string' ? entry.trim() : '')))];
      for (const line of commands) {
        if (line.length === 0 || line.length > 200 || !COMMAND_LINE.test(line)) {
          throw new AppError('A command is plain words only: no quotes, pipes, ; & > < $ ` ( ) or wildcards', {
            code: 'AGY_COMMAND_INVALID',
            statusCode: 400,
          });
        }
      }
      const settings = parseSettings(await fileSystem.readFile(dependencies.settingsPath));
      const kept = readAllowRules(settings).filter((rule) => !COMMAND_RULE.test(rule));
      const permissions = typeof settings.permissions === 'object' && settings.permissions !== null && !Array.isArray(settings.permissions)
        ? (settings.permissions as Record<string, unknown>)
        : {};
      await fileSystem.writeSecretFile(
        dependencies.settingsPath,
        `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...kept, ...commands.map((line) => `command(${line})`)] } }, null, 2)}\n`,
      );
      return this.getAllowedCommands();
    },

    /** Environment to add to an agy PTY only; empty when no API key is configured. */
    async getLaunchEnvironment(): Promise<Record<string, string>> {
      const raw = await fileSystem.readFile(dependencies.apiKeyPath);
      const match = raw?.match(/^GEMINI_API_KEY=(.+)$/m);
      return match?.[1] ? { GEMINI_API_KEY: match[1].trim() } : {};
    },
  };
}
