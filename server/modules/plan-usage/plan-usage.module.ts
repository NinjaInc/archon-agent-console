import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import { createPlanUsageRouter } from './plan-usage.routes.js';
import { createPlanUsageService } from './plan-usage.service.js';

const run = promisify(execFile);

// Fixed argument lists, no shell, run from the temp directory so no project settings or hooks are picked up.
// /usage is answered by each CLI itself and makes no model request; Claude is told not to save a session.
async function report(command: string, args: string[]): Promise<string> {
  const { stdout } = await run(command, args, { cwd: os.tmpdir(), timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } });
  return stdout;
}

const service = createPlanUsageService({
  runClaude: () => report('claude', ['-p', '/usage', '--no-session-persistence']),
  runAgy: () => report('agy', ['-p=/usage', '--print-timeout', '20s']),
});

/** Plan usage router assembled for the authenticated server mount. */
export const planUsageRoutes = createPlanUsageRouter(service);
