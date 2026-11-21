import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createProject } from '@/modules/projects/index.js';
import { AppError } from '@/shared/utils.js';

import { createGithubReposRouter } from './github-repos.routes.js';
import { createGithubReposService } from './github-repos.service.js';

const run = promisify(execFile);
// Repos are cloned under <GITHUB_CLONE_ROOT>/<owner>/<name>; the default matches the gh-clone-all layout.
const cloneRoot = path.resolve(process.env.GITHUB_CLONE_ROOT || path.join(os.homedir(), 'projects'));

/** Runs `gh` with an argument array (never a shell). Its own stored login is used; no token passes through here. */
async function gh(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await run('gh', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT') {
      throw new AppError('The GitHub CLI (gh) is not installed on the server', { code: 'GH_NOT_INSTALLED', statusCode: 503 });
    }
    throw new AppError('GitHub request failed. Is `gh auth login` done on the server?', {
      code: 'GH_FAILED',
      statusCode: 502,
      details: (failure.stderr ?? '').split('\n')[0]?.slice(0, 200),
    });
  }
}

const githubReposService = createGithubReposService({
  cloneRoot,
  async listRepositories() {
    const output = await gh(['repo', 'list', '--limit', '500', '--json', 'name,nameWithOwner,description,isPrivate,isFork,primaryLanguage,pushedAt,url'], 60_000);
    return JSON.parse(output);
  },
  async cloneRepository(nameWithOwner, targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await gh(['repo', 'clone', nameWithOwner, targetPath], 10 * 60_000);
  },
  async isGitCheckout(directoryPath) {
    try {
      await fs.access(path.join(directoryPath, '.git'));
      return true;
    } catch {
      return false;
    }
  },
  registerProject: (projectPath, displayName) => createProject({ projectPath, customName: displayName }),
});

/** GitHub repositories router assembled for the authenticated server mount. */
export const githubReposRoutes = createGithubReposRouter(githubReposService);
