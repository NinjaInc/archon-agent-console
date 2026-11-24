import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { agyChatDb, projectsDb } from '@/modules/database/index.js';
import { getAgyLaunchEnvironment } from '@/modules/agy/index.js';
import { DENIED_PATHS, WORKSPACE_ROOTS, resolvePathUnderRoots } from '@/shared/utils.js';

import { createAgyChatRouter } from './agy-chat.routes.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createAgyChatService, summariseTurnForNotification } from './agy-chat.service.js';
import { parseAgyUsage } from './agy-chat.usage.js';
import type { AgyUsageLimit } from '@/shared/types.js';

const run = promisify(execFile);
const TURN_TIMEOUT_MS = 30 * 60_000;

const agyChatService = createAgyChatService({
  store: agyChatDb,
  // AGY_CHAT_FULL_ACCESS=false removes the "Full access" mode (agy running any command as this user).
  allowFullAccess: process.env.AGY_CHAT_FULL_ACCESS !== 'false',
  audit: (message) => console.log(`[agy-chat] ${message}`),
  async resolveProjectDir(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    return projectPath ? resolvePathUnderRoots(projectPath, WORKSPACE_ROOTS, DENIED_PATHS) : null;
  },
  async spawnAgy(args, cwd) {
    const agyEnvironment = await getAgyLaunchEnvironment().catch(() => ({}));
    // No shell: the message is one argv entry. agy gets its saved API key (if any), like the terminal tab.
    // Own process group, so Stop and the timeout also end the commands agy started, not just agy itself.
    const child = spawn('agy', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...agyEnvironment, NO_COLOR: '1' } });
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 5_000).unref();
    };
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(killGroup, TURN_TIMEOUT_MS);
    const exited = new Promise<number | null>((resolve) => {
      child.on('error', (error) => { stderr += error.message; resolve(1); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    return { stdout: child.stdout, exited, stderrText: () => stderr, kill: killGroup };
  },
});

let modelCache: { at: number; models: string[] } | null = null;
const FALLBACK_MODELS = ['gemini-4-argon-medium', 'gemini-4-hydrogen-medium', 'gemini-3.8-flash-medium', 'claude-sonnet-5-5-medium', 'claude-opus-5-5-medium', 'gpt-oss-120b-medium'];

/** Model ids from `agy models` (cached ten minutes); a built-in list when agy cannot answer. */
async function listModels(): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  try {
    const { stdout } = await run('agy', ['models'], { timeout: 20_000, env: { ...process.env, NO_COLOR: '1' } });
    const models = stdout.split('\n').map((line) => line.split('\t')[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id));
    modelCache = { at: Date.now(), models: models.length > 0 ? models : FALLBACK_MODELS };
  } catch {
    modelCache = { at: Date.now(), models: FALLBACK_MODELS };
  }
  return modelCache.models;
}

let usageCache: { at: number; limits: AgyUsageLimit[] } | null = null;

/** Remaining allowance per model family from `agy -p=/usage` (cached a minute; empty when agy cannot answer). */
async function listUsage(): Promise<AgyUsageLimit[]> {
  if (usageCache && Date.now() - usageCache.at < 60_000) return usageCache.limits;
  try {
    const { stdout } = await run('agy', ['-p=/usage', '--print-timeout', '20s'], { timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } });
    usageCache = { at: Date.now(), limits: parseAgyUsage(stdout) };
  } catch {
    usageCache = { at: Date.now(), limits: [] };
  }
  return usageCache.limits;
}

/** Antigravity chat router assembled for the authenticated server mount. */
export const agyChatRoutes = createAgyChatRouter(agyChatService, listModels, listUsage, (turn) => {
  const summary = summariseTurnForNotification({ ...turn, minSeconds: Number(process.env.AGY_NOTIFY_MIN_SECONDS ?? 20) });
  if (!summary) return;
  const { chat } = agyChatService.getChat(turn.chatId);
  const sessionName = `${chat.projectPath.split('/').filter(Boolean).pop() ?? 'project'} · ${chat.title}`;
  const common = { userId: turn.userId, provider: 'agy', sessionId: turn.chatId, sessionName, extraMeta: { tab: 'agy-chat' } };
  if (summary.kind === 'error') notifyRunFailed({ ...common, error: summary.message });
  else notifyRunStopped({ ...common, stopReason: summary.reason });
});
