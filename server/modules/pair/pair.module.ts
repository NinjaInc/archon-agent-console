import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { DENIED_PATHS, WORKSPACE_ROOTS, resolvePathUnderRoots } from '@/shared/utils.js';

import { detectTestCommand, pairAgents } from './pair.agents.js';
import { pairGit } from './pair.git.js';
import { createPairRouter } from './pair.routes.js';
import { createPairService } from './pair.service.js';

const service = createPairService({
  directory: path.join(os.homedir(), '.local', 'share', 'archon-agent-console', 'pair'),
  git: pairGit,
  agents: pairAgents,
  detectTests: detectTestCommand,
  async resolveProjectDir(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    return projectPath ? resolvePathUnderRoots(projectPath, WORKSPACE_ROOTS, DENIED_PATHS) : null;
  },
  audit: (message) => console.log(`[pair] ${message}`),
});

/** Pair mode router assembled for the authenticated server mount. */
export const pairRoutes = createPairRouter(service);
