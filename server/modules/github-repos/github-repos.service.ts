import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** One GitHub repository as the console shows it. */
export type GithubRepoView = {
  nameWithOwner: string;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  isFork: boolean;
  language: string | null;
  pushedAt: string | null;
  url: string;
  /** Where the clone lives (or would live) on this machine. */
  localPath: string;
  cloned: boolean;
};

type RawRepo = {
  nameWithOwner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  isFork: boolean;
  primaryLanguage: { name: string } | null;
  pushedAt: string | null;
  url: string;
};

export type GithubReposDependencies = {
  /** Lists the signed-in GitHub user's repositories through the `gh` CLI's own login. */
  listRepositories: () => Promise<RawRepo[]>;
  /** `gh repo clone <nameWithOwner> <targetPath>`; rejects on failure. */
  cloneRepository: (nameWithOwner: string, targetPath: string) => Promise<void>;
  /** True when `<dir>/.git` exists. */
  isGitCheckout: (directoryPath: string) => Promise<boolean>;
  /** Folder repos are cloned under: `<cloneRoot>/<owner>/<name>`. */
  cloneRoot: string;
  registerProject: (projectPath: string, displayName: string) => Promise<{ project: Record<string, unknown> }>;
  now?: () => number;
};

const CACHE_MS = 60_000;
// GitHub owner and repository names: letters, digits, '.', '_' and '-'. No separators or traversal.
const REPO_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** Lists the user's GitHub repositories with their local clone state, and opens or clones them as projects. */
export function createGithubReposService(dependencies: GithubReposDependencies) {
  const now = dependencies.now ?? Date.now;
  let cache: { at: number; repos: RawRepo[] } | null = null;

  async function repositories(forceRefresh: boolean): Promise<RawRepo[]> {
    if (!forceRefresh && cache && now() - cache.at < CACHE_MS) {
      return cache.repos;
    }
    const repos = await dependencies.listRepositories();
    cache = { at: now(), repos };
    return repos;
  }

  function localPathFor(nameWithOwner: string): string {
    const [owner, name] = nameWithOwner.split('/');
    return path.join(dependencies.cloneRoot, owner, name);
  }

  /** Only repositories that appear in the user's own list may be opened or cloned. */
  async function requireKnownRepository(reference: unknown): Promise<RawRepo> {
    if (typeof reference !== 'string' || !REPO_REFERENCE.test(reference) || reference.includes('..')) {
      throw new AppError('A repository like owner/name is required', { code: 'GITHUB_REPO_INVALID', statusCode: 400 });
    }
    const known = (await repositories(false)).find((repo) => repo.nameWithOwner.toLowerCase() === reference.toLowerCase());
    if (!known) {
      throw new AppError('That repository is not in your GitHub account', { code: 'GITHUB_REPO_UNKNOWN', statusCode: 404 });
    }
    return known;
  }

  async function register(repo: RawRepo) {
    const localPath = localPathFor(repo.nameWithOwner);
    try {
      return await dependencies.registerProject(localPath, repo.name);
    } catch (error) {
      // Already a project: hand the caller the existing one rather than failing.
      if ((error as { code?: string }).code === 'PROJECT_ALREADY_EXISTS') {
        return { project: { alreadyRegistered: true, fullPath: localPath, path: localPath } };
      }
      throw error;
    }
  }

  return {
    async list(options: { refresh?: boolean } = {}): Promise<GithubRepoView[]> {
      const repos = await repositories(Boolean(options.refresh));
      return Promise.all(
        repos.map(async (repo) => {
          const localPath = localPathFor(repo.nameWithOwner);
          return {
            nameWithOwner: repo.nameWithOwner,
            name: repo.name,
            owner: repo.nameWithOwner.split('/')[0],
            description: repo.description ?? '',
            isPrivate: repo.isPrivate,
            isFork: repo.isFork,
            language: repo.primaryLanguage?.name ?? null,
            pushedAt: repo.pushedAt,
            url: repo.url,
            localPath,
            cloned: await dependencies.isGitCheckout(localPath),
          };
        }),
      );
    },

    /** Registers an existing local clone as a console project. */
    async open(reference: unknown) {
      const repo = await requireKnownRepository(reference);
      if (!(await dependencies.isGitCheckout(localPathFor(repo.nameWithOwner)))) {
        throw new AppError('This repository is not cloned yet', { code: 'GITHUB_REPO_NOT_CLONED', statusCode: 409 });
      }
      return register(repo);
    },

    /** Clones the repository (unless it is already here) and registers it as a project. */
    async clone(reference: unknown) {
      const repo = await requireKnownRepository(reference);
      const localPath = localPathFor(repo.nameWithOwner);
      if (!(await dependencies.isGitCheckout(localPath))) {
        await dependencies.cloneRepository(repo.nameWithOwner, localPath);
      }
      return register(repo);
    },
  };
}
