import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { projectsDb } from '@/modules/database/index.js';
import { AppError, DENIED_PATHS, WORKSPACE_ROOTS, resolvePathUnderRoots } from '@/shared/utils.js';

import { loadOllamaConfig } from './ollama.config.js';
import { inputBudgetChars } from './ollama.diff.js';
import { createOllamaRouter } from './ollama.routes.js';
import { createOllamaService } from './ollama.service.js';

const run = promisify(execFile);

const config = loadOllamaConfig(process.env);
if (config.problem) console.warn(`[ollama] local model is off: ${config.problem}`);

const service = createOllamaService({ config, audit: (message) => console.log(`[ollama] ${message}`) });
const enabled = config.configured && !config.problem;
if (enabled) service.startHealthPolling();

/**
 * Reads the project's git diff for the local-only tasks. No shell: git is started with an argument list. The diff only
 * goes through the filter and secret guard in the routes before anything reaches the model. Read-only.
 */
async function readGitDiff(directory: string, staged: boolean): Promise<string> {
  const args = ['-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : ['HEAD']), '--'];
  try {
    const { stdout } = await run('git', args, { cwd: directory, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new AppError('The diff is far too big for the local model. Nothing was sent. Stage or explain a smaller piece.', { code: 'OLLAMA_INPUT_TOO_LARGE', statusCode: 413 });
    }
    throw new AppError('Could not read the git diff here. Is this project a git repository with at least one commit?', { code: 'OLLAMA_BAD_REQUEST', statusCode: 422 });
  }
}

/**
 * The one Ollama service (and its health poll), shared so other modules do not start a second poller.
 * Used by the web-search module to stream cited answers from the local model.
 */
export const ollamaService = service;

/** True when OLLAMA_BASE_URL is set and valid. Used by the web-search module to decide whether cited answers are available. */
export const ollamaEnabled = enabled;

/** Character budget of the model's context window (inputs beyond it are refused, never cut). Used by the web-search module to size answer prompts. */
export const ollamaInputBudgetChars = inputBudgetChars(config.numCtx);

/** Local (Ollama) router assembled for the authenticated server mount. */
export const ollamaRoutes = createOllamaRouter({
  service,
  numCtx: config.numCtx,
  configured: enabled,
  async resolveProjectDir(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    return projectPath ? resolvePathUnderRoots(projectPath, WORKSPACE_ROOTS, DENIED_PATHS) : null;
  },
  readGitDiff,
});
