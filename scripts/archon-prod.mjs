#!/usr/bin/env node
/**
 * archon-prod - a small, auditable command-line tool for a production Docker host managed by Portainer.
 *
 * Author: Josh Neufield (Archon Tech)
 *
 * Why this exists: an AI agent that can run arbitrary `docker` or `ssh` commands on production can do
 * anything to it. This tool exposes only a few verbs, and every change needs an explicit `--yes`:
 *
 *   archon-prod status                     environments, stacks and containers (read-only)
 *   archon-prod logs <container> [--tail N]
 *   archon-prod redeploy <stack> [--yes]   pull the stack's git repo + images and redeploy (git stacks only)
 *   archon-prod create-stack <name> --repo <https-url> [--ref refs/heads/main] [--compose docker-compose.yml]
 *                            [--env KEY=VALUE ...] [--credential-id N] [--yes]
 *   archon-prod trust [--yes]              show / pin the Portainer TLS certificate fingerprint
 *
 * What it deliberately cannot do: delete or stop anything, prune volumes, run arbitrary commands, or
 * deploy from a repository outside the allow-list in the config. Without --yes a changing verb only
 * prints its plan. Every action is appended to an audit log (no secrets).
 *
 * Config  ~/.config/archon-prod/config.json   { "url": "https://host:9443", "endpointId": 1,
 *                                               "certSha256": "AB:CD:...", "redeployAllow": ["*"],
 *                                               "allowedRepoPrefixes": ["https://github.com/<you>/"] }
 * Token   ~/.config/archon-prod/portainer.token   (Portainer: My account > Access tokens), mode 0600
 * Audit   ~/.local/state/archon-prod/audit.log
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CONFIG_DIR = process.env.ARCHON_PROD_CONFIG_DIR || path.join(HOME, '.config', 'archon-prod');
const AUDIT_FILE = process.env.ARCHON_PROD_AUDIT_FILE || path.join(HOME, '.local', 'state', 'archon-prod', 'audit.log');

const STACK_NAME = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ENV = 50;
const MAX_LOG_TAIL = 2000;

export class UsageError extends Error {}

//----------------- pure helpers (unit tested) ------------

/** Splits argv into positionals and flags; `--env` may repeat, `--yes` and `--json` are booleans. */
export function parseArgs(argv) {
  const positionals = [];
  const flags = { env: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '--json') {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      i += 1;
      if (name === 'env') flags.env.push(value);
      else flags[name] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function validateStackName(name) {
  if (typeof name !== 'string' || !STACK_NAME.test(name)) {
    throw new UsageError('A stack name is 2-41 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit');
  }
  return name;
}

/** Only https repositories under an explicitly allowed prefix may be deployed. */
export function checkRepoAllowed(repoUrl, prefixes) {
  let parsed;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new UsageError('--repo must be a full https URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new UsageError('--repo must be an https URL without embedded credentials');
  }
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new UsageError('No allowedRepoPrefixes are configured, so new stacks are refused. Add e.g. "https://github.com/<you>/" to the config.');
  }
  const normalised = `${parsed.origin}${parsed.pathname}`.replace(/\.git$/, '');
  // Match on a path boundary: the prefix ".../NinjaInc" must not also admit ".../NinjaInc-evil/x".
  const withBoundary = (prefix) => `${prefix.replace(/\.git$/, '').replace(/\/+$/, '')}/`.toLowerCase();
  if (!prefixes.some((prefix) => `${normalised.toLowerCase()}/`.startsWith(withBoundary(prefix)))) {
    throw new UsageError(`That repository is outside the allowed prefixes (${prefixes.join(', ')})`);
  }
  return repoUrl;
}

export function validateComposePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').includes('..') || /[\0\\]/.test(value)) {
    throw new UsageError('--compose must be a relative path inside the repository');
  }
  return value;
}

export function parseEnvPairs(pairs) {
  if (pairs.length > MAX_ENV) throw new UsageError(`At most ${MAX_ENV} --env values`);
  return pairs.map((pair) => {
    const index = pair.indexOf('=');
    const name = index > 0 ? pair.slice(0, index) : '';
    if (!ENV_NAME.test(name)) throw new UsageError(`Bad --env name in "${name || pair}"; use KEY=VALUE`);
    return { name, value: pair.slice(index + 1) };
  });
}

/** Body for Portainer's git redeploy: keep the stack's own settings, pull images, never prune. */
export function buildRedeployBody(stack) {
  const git = stack.GitConfig;
  return {
    env: (stack.Env ?? []).map((entry) => ({ name: entry.name, value: entry.value })),
    prune: false,
    pullImage: true,
    repositoryReferenceName: git.ReferenceName,
    repositoryAuthentication: Boolean(git.Authentication),
    ...(git.Authentication?.GitCredentialID ? { repositoryGitCredentialID: git.Authentication.GitCredentialID } : {}),
  };
}

export function buildCreateBody({ name, repo, ref, compose, env, credentialId }) {
  return {
    name,
    repositoryURL: repo,
    repositoryReferenceName: ref,
    composeFile: compose,
    repositoryAuthentication: credentialId !== undefined,
    ...(credentialId !== undefined ? { repositoryGitCredentialID: Number(credentialId) } : {}),
    env,
  };
}

/** Docker's log stream is framed: 8-byte header (stream, 0, 0, 0, uint32 length) then the payload. */
export function demuxDockerLogs(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (buffer[offset] > 2 || buffer[offset + 1] !== 0 || offset + 8 + size > buffer.length) {
      return buffer.toString('utf8'); // not framed (a TTY container): the bytes are already plain text
    }
    lines.push(buffer.subarray(offset + 8, offset + 8 + size).toString('utf8'));
    offset += 8 + size;
  }
  return lines.join('');
}

export function pickEndpoint(endpoints, wanted) {
  if (wanted !== undefined && wanted !== null) {
    const found = endpoints.find((endpoint) => endpoint.Id === Number(wanted));
    if (!found) throw new UsageError(`Portainer has no environment with id ${wanted}`);
    return found;
  }
  const usable = endpoints.filter((endpoint) => endpoint.Status === 1);
  if (usable.length !== 1) throw new UsageError(`Set "endpointId" in the config (found ${usable.length} usable environments)`);
  return usable[0];
}

//----------------- config, token and transport ------------

function readConfig() {
  const file = path.join(CONFIG_DIR, 'config.json');
  if (!fs.existsSync(file)) throw new UsageError(`No config at ${file}. See docs/prod-access.md`);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof config.url !== 'string' || !/^https:\/\//.test(config.url)) throw new UsageError('config.url must be an https Portainer URL');
  return config;
}

function readToken() {
  const file = path.join(CONFIG_DIR, 'portainer.token');
  if (!fs.existsSync(file)) throw new UsageError(`No token at ${file}. Create one in Portainer (My account > Access tokens).`);
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new UsageError(`${file} must be readable only by you (chmod 600)`);
  return fs.readFileSync(file, 'utf8').trim();
}

/** HTTPS to Portainer, pinning the certificate fingerprint (Portainer's default cert is self-signed). */
export function createTransport({ url, token, certSha256 }) {
  const base = new URL(url);
  return (method, apiPath, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const request = https.request(
        {
          host: base.hostname,
          port: base.port || 443,
          path: apiPath,
          method,
          rejectUnauthorized: false,
          headers: { ...(token ? { 'X-API-Key': token } : {}), Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
          timeout: 60_000,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      request.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          const fingerprint = socket.getPeerCertificate()?.fingerprint256;
          if (certSha256 && fingerprint !== certSha256.toUpperCase()) {
            request.destroy(new Error(`Portainer certificate changed (${fingerprint}). Refusing to send the token. Run: archon-prod trust`));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Portainer did not answer in 60s')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
}

function jsonOf(response, what) {
  if (response.status < 200 || response.status >= 300) {
    let detail = '';
    try {
      const parsed = JSON.parse(response.body.toString('utf8'));
      detail = parsed.details || parsed.message || '';
    } catch {
      detail = response.body.toString('utf8').slice(0, 200);
    }
    throw new Error(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.body.length ? JSON.parse(response.body.toString('utf8')) : null;
}

function audit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), user: os.userInfo().username, ...record })}\n`, { mode: 0o600 });
  } catch {
    // A full disk must not stop a read-only look at production.
  }
}

//----------------- verbs ------------

async function loadWorld(call, config) {
  const endpoints = jsonOf(await call('GET', '/api/endpoints'), 'Listing environments');
  const endpoint = pickEndpoint(endpoints, config.endpointId);
  const stacks = jsonOf(await call('GET', '/api/stacks'), 'Listing stacks');
  return { endpoints, endpoint, stacks };
}

function findStack(stacks, endpoint, name) {
  const matches = stacks.filter((stack) => stack.Name.toLowerCase() === name.toLowerCase() && stack.EndpointId === endpoint.Id);
  if (matches.length !== 1) throw new UsageError(`Stack "${name}" not found in environment ${endpoint.Name}. Known: ${stacks.map((s) => s.Name).join(', ') || 'none'}`);
  return matches[0];
}

export async function runVerb(verb, args, { call, config, out }) {
  const { positionals, flags } = parseArgs(args);

  if (verb === 'status') {
    const { endpoints, endpoint, stacks } = await loadWorld(call, config);
    const containers = jsonOf(await call('GET', `/api/endpoints/${endpoint.Id}/docker/containers/json?all=1`), 'Listing containers');
    if (flags.json) {
      out(JSON.stringify({ endpoint: { id: endpoint.Id, name: endpoint.Name }, stacks: stacks.map((s) => ({ id: s.Id, name: s.Name, status: s.Status, git: s.GitConfig ? `${s.GitConfig.URL}@${s.GitConfig.ReferenceName}` : null })), containers: containers.map((c) => ({ name: (c.Names?.[0] ?? '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status })) }, null, 2));
    } else {
      out(`Environment: ${endpoint.Name} (id ${endpoint.Id}); ${endpoints.length} environment(s) known`);
      out(`\nStacks (${stacks.length}):`);
      for (const stack of stacks.filter((s) => s.EndpointId === endpoint.Id)) {
        out(`  ${stack.Name.padEnd(24)} ${stack.Status === 1 ? 'active  ' : 'inactive'} ${stack.GitConfig ? `git ${stack.GitConfig.URL} @ ${stack.GitConfig.ReferenceName}` : '(not from git: cannot be redeployed with this tool)'}`);
      }
      out(`\nContainers (${containers.length}):`);
      for (const c of containers) out(`  ${(c.Names?.[0] ?? '').replace(/^\//, '').padEnd(30)} ${String(c.State).padEnd(10)} ${c.Image}  [${c.Status}]`);
    }
    audit({ verb, outcome: 'ok' });
    return 0;
  }

  if (verb === 'logs') {
    const target = positionals[0];
    if (!target) throw new UsageError('usage: archon-prod logs <container> [--tail N]');
    const tail = Math.min(Math.max(Number(flags.tail ?? 100) || 100, 1), MAX_LOG_TAIL);
    const { endpoint } = await loadWorld(call, config);
    const containers = jsonOf(await call('GET', `/api/endpoints/${endpoint.Id}/docker/containers/json?all=1`), 'Listing containers');
    const match = containers.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === target));
    if (!match) throw new UsageError(`No container named "${target}"`);
    const response = await call('GET', `/api/endpoints/${endpoint.Id}/docker/containers/${match.Id}/logs?stdout=1&stderr=1&tail=${tail}`);
    if (response.status !== 200) throw new Error(`Reading logs failed (HTTP ${response.status})`);
    out(demuxDockerLogs(response.body).trimEnd());
    audit({ verb, target, tail, outcome: 'ok' });
    return 0;
  }

  if (verb === 'redeploy') {
    const name = validateStackName(positionals[0]);
    const { endpoint, stacks } = await loadWorld(call, config);
    const allow = config.redeployAllow ?? [];
    if (!allow.includes('*') && !allow.includes(name)) throw new UsageError(`"${name}" is not in redeployAllow`);
    const stack = findStack(stacks, endpoint, name);
    if (!stack.GitConfig) throw new UsageError(`"${name}" was not created from a git repository, so it cannot be redeployed with this tool`);
    out(`PLAN: redeploy stack "${stack.Name}" in ${endpoint.Name}: pull ${stack.GitConfig.URL} @ ${stack.GitConfig.ReferenceName}, pull images, recreate changed containers. Nothing is deleted or pruned.`);
    if (!flags.yes) {
      out('DRY RUN. Nothing changed. Re-run with --yes to apply.');
      audit({ verb, target: name, outcome: 'dry-run' });
      return 0;
    }
    const response = await call('PUT', `/api/stacks/${stack.Id}/git/redeploy?endpointId=${endpoint.Id}`, buildRedeployBody(stack));
    jsonOf(response, `Redeploying ${name}`);
    out(`Redeploy of "${name}" requested and accepted by Portainer. Check with: archon-prod status`);
    audit({ verb, target: name, outcome: 'applied', status: response.status });
    return 0;
  }

  if (verb === 'create-stack') {
    const name = validateStackName(positionals[0]);
    const repo = checkRepoAllowed(flags.repo, config.allowedRepoPrefixes);
    const compose = validateComposePath(flags.compose ?? 'docker-compose.yml');
    const ref = flags.ref ?? 'refs/heads/main';
    if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/.test(ref)) throw new UsageError('--ref must look like refs/heads/main');
    const env = parseEnvPairs(flags.env);
    const { endpoint, stacks } = await loadWorld(call, config);
    if (stacks.some((stack) => stack.Name.toLowerCase() === name.toLowerCase())) throw new UsageError(`A stack named "${name}" already exists. Use redeploy.`);
    out(`PLAN: create stack "${name}" in ${endpoint.Name} from ${repo} @ ${ref} (${compose}), ${env.length} environment value(s) (names: ${env.map((e) => e.name).join(', ') || 'none'}; values not shown).`);
    if (!flags.yes) {
      out('DRY RUN. Nothing changed. Re-run with --yes to apply.');
      audit({ verb, target: name, repo, outcome: 'dry-run' });
      return 0;
    }
    const response = await call('POST', `/api/stacks/create/standalone/repository?endpointId=${endpoint.Id}`, buildCreateBody({ name, repo, ref, compose, env, credentialId: flags['credential-id'] }));
    const created = jsonOf(response, `Creating ${name}`);
    out(`Created stack "${name}" (id ${created?.Id ?? '?'}). Check with: archon-prod status`);
    audit({ verb, target: name, repo, outcome: 'applied', status: response.status });
    return 0;
  }

  throw new UsageError(`Unknown command "${verb}". Commands: status, logs, redeploy, create-stack, trust`);
}

async function trust(config, flags, out) {
  const url = new URL(config.url);
  const fingerprint = await new Promise((resolve, reject) => {
    const request = https.request({ host: url.hostname, port: url.port || 443, path: '/api/system/status', method: 'GET', rejectUnauthorized: false, timeout: 15_000 }, (response) => response.resume());
    request.on('socket', (socket) => socket.once('secureConnect', () => { resolve(socket.getPeerCertificate().fingerprint256); request.destroy(); }));
    request.on('error', (error) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
    request.end();
  });
  out(`Portainer certificate SHA-256: ${fingerprint}`);
  if (config.certSha256 && config.certSha256.toUpperCase() === fingerprint) {
    out('Already pinned and matching.');
    return 0;
  }
  if (!flags.yes) {
    out(`${config.certSha256 ? `PINNED VALUE DIFFERS (${config.certSha256}). ` : 'Not pinned yet. '}Compare with Portainer (Settings > SSL certificate) if you can, then re-run with --yes to pin it.`);
    return 0;
  }
  const file = path.join(CONFIG_DIR, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...config, certSha256: fingerprint }, null, 2)}\n`, { mode: 0o600 });
  audit({ verb: 'trust', outcome: 'pinned', fingerprint });
  out('Pinned.');
  return 0;
}

export async function main(argv) {
  const [verb, ...rest] = argv;
  const out = (line) => process.stdout.write(`${line}\n`);
  try {
    if (!verb || verb === '--help' || verb === 'help') {
      out('usage: archon-prod status | logs <container> | redeploy <stack> [--yes] | create-stack <name> --repo <url> [--yes] | trust [--yes]');
      return 0;
    }
    const config = readConfig();
    if (verb === 'trust') return await trust(config, parseArgs(rest).flags, out);
    if (!config.certSha256) throw new UsageError('The Portainer certificate is not pinned yet. Run: archon-prod trust');
    const call = createTransport({ url: config.url, token: readToken(), certSha256: config.certSha256 });
    return await runVerb(verb, rest, { call, config, out });
  } catch (error) {
    process.stderr.write(`archon-prod: ${error.message}\n`);
    audit({ verb, outcome: 'error', message: String(error.message).slice(0, 200) });
    return error instanceof UsageError ? 2 : 1;
  }
}

// realpath: the installed command is a symlink to this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
