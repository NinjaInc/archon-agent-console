import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** Where this server connects to find the Claude Code that runs on the production host. */
export type ProdClaudeConfig = {
  host: string;
  user: string;
  port: number;
  /** What to start on the remote host. A single token (usually an absolute path to `claude`). */
  remoteCommand: string;
  label: string;
};

export type ProdClaudeLaunch = { file: string; args: string[]; env: Record<string, string> };

export type ProdClaudeFiles = {
  /** Folder holding config.json, id_ed25519 and known_hosts. */
  directory: string;
  readFile: (filePath: string) => Promise<string | null>;
  exists: (filePath: string) => Promise<boolean>;
};

// These values end up on an ssh command line, so they must not be able to look like an option or contain
// shell/ssh syntax. (A host of "-oProxyCommand=..." is the classic ssh option-injection.)
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const REMOTE_COMMAND = /^[A-Za-z0-9_./~-]{1,120}$/;

export function parseProdClaudeConfig(raw: unknown): ProdClaudeConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const bad = (what: string) => new AppError(`Prod Claude config: ${what}`, { code: 'PROD_CLAUDE_CONFIG_INVALID', statusCode: 500 });
  if (typeof config.host !== 'string' || !HOST.test(config.host)) throw bad('host must be a hostname or IP address');
  if (typeof config.user !== 'string' || !USER.test(config.user)) throw bad('user must be a plain login name');
  const port = config.port === undefined ? 22 : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('port must be 1-65535');
  const remoteCommand = config.remoteCommand === undefined ? 'claude' : config.remoteCommand;
  if (typeof remoteCommand !== 'string' || !REMOTE_COMMAND.test(remoteCommand) || remoteCommand.startsWith('-')) {
    throw bad('remoteCommand must be one path or command name, for example /home/you/.local/bin/claude');
  }
  const label = typeof config.label === 'string' && config.label.trim() ? config.label.trim().slice(0, 40) : 'Prod Claude';
  return { host: config.host, user: config.user, port, remoteCommand, label };
}

/**
 * The ssh command that opens Claude Code on the production host.
 *
 * Isolation is the point: no ssh agent, no forwarding, no config files, no inherited environment (so none of this
 * server's tokens or API keys reach the other machine), and the host key must match the one that was pinned.
 */
export function buildProdClaudeLaunch(config: ProdClaudeConfig, directory: string): ProdClaudeLaunch {
  const options = [
    'BatchMode=yes',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${path.join(directory, 'known_hosts')}`,
    'GlobalKnownHostsFile=/dev/null',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
    'ServerAliveInterval=30',
    'ServerAliveCountMax=3',
  ].flatMap((option) => ['-o', option]);
  return {
    file: 'ssh',
    args: ['-tt', '-F', '/dev/null', '-i', path.join(directory, 'id_ed25519'), ...options, '-p', String(config.port), `${config.user}@${config.host}`, config.remoteCommand],
    // Nothing from this process's environment is passed on: only what a terminal and ssh need.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  };
}

/** Reads the config; null when Prod Claude has not been set up (the tab then stays hidden). */
export async function loadProdClaude(files: ProdClaudeFiles): Promise<{ config: ProdClaudeConfig; launch: ProdClaudeLaunch; keyPresent: boolean; hostKeyPinned: boolean } | null> {
  const text = await files.readFile(path.join(files.directory, 'config.json'));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('Prod Claude config is not valid JSON', { code: 'PROD_CLAUDE_CONFIG_INVALID', statusCode: 500 });
  }
  const config = parseProdClaudeConfig(raw);
  return {
    config,
    launch: buildProdClaudeLaunch(config, files.directory),
    keyPresent: await files.exists(path.join(files.directory, 'id_ed25519')),
    hostKeyPinned: await files.exists(path.join(files.directory, 'known_hosts')),
  };
}
