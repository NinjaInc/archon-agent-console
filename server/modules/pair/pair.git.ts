/**
 * Git for pair runs. The worktree is writable by an agent, so nothing in it is trusted: every command names the git
 * directory recorded when the worktree was made, with hooks, the file-system monitor and diff helpers switched off.
 * Author: Josh Neufield (Archon Tech)
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '@/shared/utils.js';

const run = promisify(execFile);
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const MAX_DIFF_BYTES = 200_000;

export type PairWorkspace = { repo: string; directory: string; gitDir: string; base: string };
export type PairDiff = { tree: string; hash: string; text: string; files: string[]; hasSymlinks: boolean };

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', [...SAFE, ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

const inWorkspace = (workspace: PairWorkspace, args: string[]) =>
  git([`--git-dir=${workspace.gitDir}`, `--work-tree=${workspace.directory}`, ...args], workspace.directory);

/**
 * The git operations a pair run needs. Used by pair.service.ts (injected by pair.module.ts) and tests/pair.git.test.ts.
 */
export const pairGit = {
  /** A detached worktree at the repository's current commit. Uncommitted work in the repository is not included. */
  async create(repo: string, directory: string): Promise<PairWorkspace> {
    let base: string;
    try {
      base = (await git(['rev-parse', '--verify', 'HEAD^{commit}'], repo)).trim();
    } catch {
      throw new AppError('Pair mode needs a git repository with at least one commit.', { code: 'PAIR_NOT_A_REPO', statusCode: 422 });
    }
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await git(['worktree', 'add', '--quiet', '--detach', directory, base], repo);
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'], directory)).trim();
    return { repo, directory, gitDir, base };
  },

  /** Everything that differs from the base, staged into the worktree's own index. Too large is refused, never cut. */
  async diff(workspace: PairWorkspace): Promise<PairDiff> {
    await inWorkspace(workspace, ['add', '-A', '--', '.', ':(exclude)node_modules']);
    const tree = (await inWorkspace(workspace, ['write-tree'])).trim();
    const range = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', workspace.base, tree, '--'];
    const text = await inWorkspace(workspace, ['diff', ...range]);
    if (Buffer.byteLength(text) > MAX_DIFF_BYTES) {
      throw new AppError('The change is too large to review safely. Split the task into smaller ones.', { code: 'PAIR_DIFF_TOO_LARGE', statusCode: 413 });
    }
    const raw = (await inWorkspace(workspace, ['diff', '--raw', '-z', ...range])).split('\0').filter(Boolean);
    const files: string[] = [];
    let hasSymlinks = false;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if (raw[index].split(' ')[1] === '120000') hasSymlinks = true;
      files.push(raw[index + 1]);
    }
    return { tree, hash: createHash('sha256').update(`${tree}\n${text}`).digest('hex'), text, files, hasSymlinks };
  },

  /** Puts exactly the approved tree on a new local branch. Nothing is merged or pushed. */
  async keep(workspace: PairWorkspace, tree: string, branch: string, message: string): Promise<void> {
    const commit = (await git(['commit-tree', tree, '-p', workspace.base, '-m', message], workspace.repo)).trim();
    // The empty old value makes this fail rather than overwrite an existing branch.
    await git(['update-ref', `refs/heads/${branch}`, commit, ''], workspace.repo);
  },

  async remove(workspace: PairWorkspace): Promise<void> {
    await fs.rm(workspace.directory, { recursive: true, force: true });
    await git(['worktree', 'prune'], workspace.repo);
  },
};

export type PairGit = typeof pairGit;
