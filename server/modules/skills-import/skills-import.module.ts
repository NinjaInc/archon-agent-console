import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { DENIED_PATHS, WORKSPACE_ROOTS, resolvePathUnderRoots } from '@/shared/utils.js';

import { createSkillsImportRouter } from './skills-import.routes.js';
import { createSkillsImportService } from './skills-import.service.js';

// Deliberately the one place that writes under ~/.claude and ~/.gemini: those folders are denied to the
// file explorer, but skills are meant to live there and the service only ever writes <root>/<name>/SKILL.md.
const skillsImportService = createSkillsImportService({
  homeDir: os.homedir(),
  async resolveProjectDir(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    return projectPath ? resolvePathUnderRoots(projectPath, WORKSPACE_ROOTS, DENIED_PATHS) : null;
  },
  fileSystem: {
    async exists(targetPath) {
      try {
        await fs.access(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(filePath) {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    async writeFile(filePath, data, options) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // 'wx' fails if anything (a planted symlink included) is already there; 0644, never executable.
      await fs.writeFile(filePath, data, { flag: options.exclusive ? 'wx' : 'w', mode: 0o644 });
    },
    async listDirectories(directoryPath) {
      try {
        return (await fs.readdir(directoryPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    removeDirectory: (directoryPath) => fs.rm(directoryPath, { recursive: true, force: true }),
    async isSymlink(targetPath) {
      try {
        return (await fs.lstat(targetPath)).isSymbolicLink();
      } catch {
        return null;
      }
    },
  },
});

/** Skills import router assembled for the authenticated server mount. */
export const skillsImportRoutes = createSkillsImportRouter(skillsImportService);
