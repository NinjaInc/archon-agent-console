import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import { AppError } from '@/shared/utils.js';

export type SkillTarget = 'claude' | 'agy';
export type SkillScope = 'user' | 'project';

/** One installed skill as the console lists it. */
export type InstalledSkill = {
  name: string;
  description: string;
  target: SkillTarget;
  scope: SkillScope;
  path: string;
};

/** What the import page shows before anything is written. */
export type SkillPreview = {
  name: string;
  description: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
  /** Things in the skill that can make an agent run commands; importing them needs an explicit acknowledgement. */
  warnings: string[];
};

export type SkillsImportDependencies = {
  homeDir: string;
  /** The real folder of a registered project inside the allowed roots, or null. */
  resolveProjectDir: (projectId: string) => Promise<string | null>;
  fileSystem: {
    exists: (targetPath: string) => Promise<boolean>;
    readFile: (filePath: string) => Promise<string | null>;
    /** Creates parent folders; `exclusive` fails instead of replacing or following an existing entry. */
    writeFile: (filePath: string, data: Buffer, options: { exclusive: boolean }) => Promise<void>;
    listDirectories: (directoryPath: string) => Promise<string[]>;
    removeDirectory: (directoryPath: string) => Promise<void>;
    /** True for a symbolic link, false for anything else, null when the path does not exist. */
    isSymlink: (targetPath: string) => Promise<boolean | null>;
  };
};

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_DEPTH = 6;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TARGETS: readonly SkillTarget[] = ['claude', 'agy'];
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.py', '.rb', '.js', '.mjs', '.cjs', '.ts', '.go', '.rs']);
const ALLOWED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.xml', '.html', '.css', '.sql',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', ...SCRIPT_EXTENSIONS,
]);
const ALLOWED_BARE_NAMES = new Set(['LICENSE', 'README', 'Makefile']);

type IncomingFile = { path: string; content: string; encoding?: string };
type SkillFile = { path: string; data: Buffer };

function badRequest(message: string, code: string): AppError {
  return new AppError(message, { code, statusCode: 400 });
}

/** Imports, previews, lists and removes skills (a SKILL.md plus optional files) for Claude Code and Antigravity (agy). */
export function createSkillsImportService(dependencies: SkillsImportDependencies) {
  const { homeDir, fileSystem } = dependencies;

  /** Skills folder per agent: Claude reads .claude/skills, agy reads ~/.gemini/config/skills and <project>/.agents/skills. */
  function skillsRoot(target: SkillTarget, scope: SkillScope, projectDir: string | null): string {
    if (scope === 'project') {
      if (!projectDir) throw badRequest('Choose a project for a project skill', 'SKILLS_PROJECT_REQUIRED');
      return target === 'claude' ? path.join(projectDir, '.claude', 'skills') : path.join(projectDir, '.agents', 'skills');
    }
    return target === 'claude' ? path.join(homeDir, '.claude', 'skills') : path.join(homeDir, '.gemini', 'config', 'skills');
  }

  async function projectDirFor(scope: SkillScope, projectId: unknown): Promise<string | null> {
    if (scope !== 'project') return null;
    if (typeof projectId !== 'string' || !projectId) throw badRequest('Choose a project for a project skill', 'SKILLS_PROJECT_REQUIRED');
    const dir = await dependencies.resolveProjectDir(projectId);
    if (!dir) throw badRequest('That project is not available', 'SKILLS_PROJECT_UNKNOWN');
    return dir;
  }

  const readScope = (value: unknown): SkillScope => {
    if (value !== 'user' && value !== 'project') throw badRequest('scope must be "user" or "project"', 'SKILLS_SCOPE_INVALID');
    return value;
  };
  const readTarget = (value: unknown): SkillTarget => {
    if (!TARGETS.includes(value as SkillTarget)) throw badRequest('target must be "claude" or "agy"', 'SKILLS_TARGET_INVALID');
    return value as SkillTarget;
  };
  const readName = (value: unknown): string => {
    if (typeof value !== 'string' || !SKILL_NAME.test(value)) throw badRequest('A skill name is lowercase letters, numbers and hyphens (max 64)', 'SKILLS_NAME_INVALID');
    return value;
  };

  /** Turns the request into validated files. A single `content` string is just a bundle holding only SKILL.md. */
  function readFiles(input: { content?: unknown; files?: unknown }): SkillFile[] {
    const incoming: IncomingFile[] = Array.isArray(input.files)
      ? (input.files as IncomingFile[])
      : typeof input.content === 'string'
        ? [{ path: 'SKILL.md', content: input.content }]
        : [];
    if (incoming.length === 0) throw badRequest('The skill is empty', 'SKILLS_EMPTY');
    if (incoming.length > MAX_FILES) throw badRequest(`A skill can have up to ${MAX_FILES} files`, 'SKILLS_TOO_MANY_FILES');

    const files: SkillFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const entry of incoming) {
      if (typeof entry?.path !== 'string' || typeof entry.content !== 'string') throw badRequest('Each file needs a path and content', 'SKILLS_FILE_INVALID');
      const normalized = entry.path.replace(/^\.\//, '');
      const segments = normalized.split('/');
      if (segments.length > MAX_DEPTH || segments.some((segment) => !PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
        throw badRequest(`"${entry.path.slice(0, 80)}" is not an allowed file path`, 'SKILLS_PATH_INVALID');
      }
      const extension = path.extname(normalized).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension) && !(extension === '' && ALLOWED_BARE_NAMES.has(segments[segments.length - 1]))) {
        throw badRequest(`"${normalized}" is not an allowed file type`, 'SKILLS_FILE_TYPE');
      }
      if (seen.has(normalized.toLowerCase())) throw badRequest(`"${normalized}" appears twice`, 'SKILLS_DUPLICATE_FILE');
      seen.add(normalized.toLowerCase());
      const data = entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64') : Buffer.from(entry.content, 'utf8');
      const limit = normalized === 'SKILL.md' ? MAX_SKILL_MD_BYTES : MAX_FILE_BYTES;
      if (data.length > limit) throw badRequest(`"${normalized}" is too large`, 'SKILLS_TOO_LARGE');
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw badRequest('A skill must be 2 MB or smaller in total', 'SKILLS_TOO_LARGE');
      files.push({ path: normalized, data });
    }

    // A zip or folder upload usually wraps everything in one folder named after the skill; unwrap it.
    if (!files.some((file) => file.path === 'SKILL.md')) {
      const roots = new Set(files.map((file) => file.path.split('/')[0]));
      if (roots.size === 1 && files.some((file) => file.path === `${[...roots][0]}/SKILL.md`)) {
        for (const file of files) file.path = file.path.slice([...roots][0].length + 1);
      }
    }
    if (!files.some((file) => file.path === 'SKILL.md')) throw badRequest('A SKILL.md file is required at the top of the skill', 'SKILLS_NO_SKILL_MD');
    return files;
  }

  /** Validates the SKILL.md and lists anything in the bundle that can make an agent run commands. */
  function inspect(files: SkillFile[]): SkillPreview {
    const skillMd = files.find((file) => file.path === 'SKILL.md')!.data.toString('utf8');
    let data: Record<string, unknown>;
    let body: string;
    try {
      const parsed = parseFrontMatter(skillMd);
      data = parsed.data as Record<string, unknown>;
      body = parsed.content;
    } catch {
      throw badRequest('The skill frontmatter is not valid YAML', 'SKILLS_FRONTMATTER_INVALID');
    }
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (!description) throw badRequest('The skill needs a description in its frontmatter', 'SKILLS_DESCRIPTION_REQUIRED');
    if (description.length > 1024) throw badRequest('The description must be 1024 characters or fewer', 'SKILLS_DESCRIPTION_TOO_LONG');
    const name = readName(data.name);

    const warnings: string[] = [];
    for (const key of ['allowed-tools', 'allowed_tools', 'allowedTools']) {
      if (key in data) warnings.push(`Pre-approves tools without asking (${key}: ${JSON.stringify(data[key]).slice(0, 120)})`);
    }
    if ('hooks' in data) warnings.push('Defines hooks, which run commands on agent events');
    if (/^\s*!`/m.test(body) || /^\s*```!/m.test(body)) warnings.push('Contains lines that run shell commands when the skill loads (!`…`)');
    const scripts = files.filter((file) => SCRIPT_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map((file) => file.path);
    if (scripts.length > 0) warnings.push(`Includes scripts an agent may run: ${scripts.slice(0, 5).join(', ')}${scripts.length > 5 ? ', …' : ''}`);

    return {
      name,
      description,
      files: files.map((file) => ({ path: file.path, bytes: file.data.length })),
      totalBytes: files.reduce((sum, file) => sum + file.data.length, 0),
      warnings,
    };
  }

  /** Refuses to write or delete through a symlink: a repository can commit `.claude -> ~/.claude`. */
  async function assertNoSymlinks(paths: string[]): Promise<void> {
    for (const candidate of paths) {
      if ((await fileSystem.isSymlink(candidate)) === true) throw badRequest('That location contains a symbolic link, so it was not changed', 'SKILLS_PATH_REJECTED');
    }
  }

  /** The folders between a project and its skill: any of them being a link redirects the write. */
  function chainOf(scope: SkillScope, target: SkillTarget, projectDir: string | null, directory: string): string[] {
    if (scope === 'project' && projectDir) {
      const root = skillsRoot(target, scope, projectDir);
      return [path.dirname(root), root, directory];
    }
    return [directory];
  }

  return {
    /** Validates a skill and reports what is in it, without writing anything. */
    preview(input: { content?: unknown; files?: unknown }): SkillPreview {
      return inspect(readFiles(input));
    },

    async list(options: { projectId?: unknown } = {}): Promise<InstalledSkill[]> {
      const projectDir = options.projectId ? await projectDirFor('project', options.projectId) : null;
      const found: InstalledSkill[] = [];
      for (const scope of (projectDir ? ['user', 'project'] : ['user']) as SkillScope[]) {
        for (const target of TARGETS) {
          const root = skillsRoot(target, scope, projectDir);
          for (const folder of (await fileSystem.listDirectories(root)).slice(0, 300)) {
            const text = await fileSystem.readFile(path.join(root, folder, 'SKILL.md'));
            if (text === null) continue;
            let description = '';
            try {
              const data = parseFrontMatter(text).data as Record<string, unknown>;
              description = typeof data.description === 'string' ? data.description.trim().slice(0, 300) : '';
            } catch {
              description = '(unreadable frontmatter)';
            }
            found.push({ name: folder, description, target, scope, path: path.join(root, folder) });
          }
        }
      }
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Installs a skill for every chosen agent. All-or-nothing: a conflict or a refused location writes nothing. */
    async importSkill(input: { content?: unknown; files?: unknown; targets: unknown; scope: unknown; projectId?: unknown; overwrite?: unknown; acknowledgeRisk?: unknown }) {
      const files = readFiles(input);
      const skill = inspect(files);
      const scope = readScope(input.scope);
      const targets = Array.isArray(input.targets) && input.targets.length > 0
        ? [...new Set(input.targets.map(readTarget))]
        : (() => { throw badRequest('Choose at least one agent', 'SKILLS_TARGET_REQUIRED'); })();
      const projectDir = await projectDirFor(scope, input.projectId);

      if (skill.warnings.length > 0 && input.acknowledgeRisk !== true) {
        throw new AppError('This skill can make an agent run commands. Review it and confirm to import it.', {
          code: 'SKILLS_NEEDS_CONFIRMATION',
          statusCode: 409,
          details: skill.warnings,
        });
      }

      const plan = targets.map((target) => {
        const root = skillsRoot(target, scope, projectDir);
        const directory = path.join(root, skill.name);
        return { target, directory, chain: chainOf(scope, target, projectDir, directory) };
      });

      const conflicts: string[] = [];
      for (const item of plan) {
        await assertNoSymlinks(item.chain);
        if (input.overwrite !== true && (await fileSystem.exists(path.join(item.directory, 'SKILL.md')))) conflicts.push(item.directory);
      }
      if (conflicts.length > 0) {
        throw new AppError('A skill with that name is already installed', { code: 'SKILLS_EXISTS', statusCode: 409, details: conflicts });
      }

      for (const item of plan) {
        // A replaced skill is removed first so files the new version no longer has do not linger.
        if (await fileSystem.exists(item.directory)) await fileSystem.removeDirectory(item.directory);
        for (const file of files) {
          await fileSystem.writeFile(path.join(item.directory, file.path), file.data, { exclusive: true });
        }
      }
      return { name: skill.name, description: skill.description, files: skill.files.length, installed: plan.map((item) => ({ target: item.target, scope, path: item.directory })) };
    },

    async remove(input: { target: unknown; scope: unknown; name: unknown; projectId?: unknown }) {
      const target = readTarget(input.target);
      const scope = readScope(input.scope);
      const name = readName(input.name);
      const projectDir = await projectDirFor(scope, input.projectId);
      const directory = path.join(skillsRoot(target, scope, projectDir), name);
      await assertNoSymlinks(chainOf(scope, target, projectDir, directory));
      if (!(await fileSystem.exists(path.join(directory, 'SKILL.md')))) {
        throw new AppError('That skill is not installed', { code: 'SKILLS_NOT_FOUND', statusCode: 404 });
      }
      await fileSystem.removeDirectory(directory);
      return { removed: directory };
    },
  };
}
