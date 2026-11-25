/**
 * The outside programs a pair run uses: Claude to plan and review, Antigravity to edit, and the project's tests.
 * Author: Josh Neufield (Archon Tech)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 200_000;
const MINUTE = 60_000;

type RunOptions = { cwd: string; input?: string; signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv };
export type ProcessResult = { code: number; stdout: string; stderr: string };

/** No shell; its own process group so Stop and the time limit also end anything it started. Keeps the tail of long output. */
function runProcess(file: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve({ code: 1, stdout: '', stderr: 'stopped' });
    const child = spawn(file, args, { cwd: options.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...(options.env ?? process.env), NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { stderr += '\ntimed out'; kill(); }, options.timeoutMs);
    options.signal.addEventListener('abort', kill, { once: true });
    const finish = (code: number) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr });
    };
    child.on('error', (error) => { stderr += error.message; finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

// --safe-mode ignores hooks, plugins, skills and project instructions; no MCP servers; nothing saved to history.
const CLAUDE_LOCKED = ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'];

async function claude(prompt: string, cwd: string, tools: string, signal: AbortSignal): Promise<string> {
  const result = await runProcess('claude', [...CLAUDE_LOCKED, '--tools', tools], { cwd, input: prompt, signal, timeoutMs: 10 * MINUTE });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Claude did not answer: ${(result.stderr || result.stdout).trim().slice(-300)}`);
  return result.stdout.trim();
}

/** A fixed command for the project's tests, chosen from the ORIGINAL repository, or null when none is recognised. */
export async function detectTestCommand(repo: string): Promise<string[] | null> {
  const read = (name: string) => fs.readFile(path.join(repo, name), 'utf8').catch(() => null);
  const manifest = await read('package.json');
  if (manifest) {
    try {
      const script = (JSON.parse(manifest) as { scripts?: { test?: string } }).scripts?.test;
      if (script && !script.includes('no test specified')) return ['npm', 'test'];
    } catch {
      return null;
    }
  }
  if (await read('go.mod')) return ['go', 'test', './...'];
  if ((await read('pytest.ini')) !== null || (await read('pyproject.toml'))?.includes('[tool.pytest')) return ['python3', '-m', 'pytest', '-q'];
  return null;
}

/** Used by pair.module.ts to give the service its real agents; tests inject fakes instead. */
export const pairAgents = {
  /** Claude reads the project (read-only tools) and writes the plan. */
  plan: (prompt: string, repo: string, signal: AbortSignal) => claude(prompt, repo, 'Read,Grep,Glob', signal),
  /** Claude reviews text it is given. No tools, and run away from the agent-written files. */
  review: (prompt: string, signal: AbortSignal) => claude(prompt, os.tmpdir(), '', signal),
  /** Antigravity edits files in the worktree. Headless agy cannot ask for permission, so anything not pre-allowed is refused. */
  async execute(prompt: string, directory: string, model: string, signal: AbortSignal): Promise<string> {
    const args = [`-p=${prompt}`, '--model', model, '--mode', 'accept-edits', '--sandbox', '--print-timeout', '25m'];
    const result = await runProcess('agy', args, { cwd: directory, signal, timeoutMs: 26 * MINUTE });
    if (result.code !== 0) throw new Error(`Antigravity stopped with an error: ${result.stderr.trim().slice(-300)}`);
    return result.stdout.trim();
  },
  /**
   * Runs approved code in its own transient unit: memory and time limits, and none of the console's environment.
   * It still runs as this user, which is why the diff is approved first.
   */
  async test(command: string[], directory: string, repo: string, signal: AbortSignal): Promise<{ passed: boolean; output: string }> {
    const modules = path.join(directory, 'node_modules');
    const linked = await fs.symlink(path.join(repo, 'node_modules'), modules).then(() => true, () => false);
    const unit = `archon-pair-test-${process.pid}-${Date.now()}`;
    const stop = () => { spawn('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }).on('error', () => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const args = ['--user', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${directory}`,
        '-p', 'MemoryMax=2G', '-p', 'MemorySwapMax=0', '-p', 'RuntimeMaxSec=900', '-p', 'NoNewPrivileges=yes',
        `--setenv=PATH=${process.env.PATH ?? '/usr/bin:/bin'}`, '--setenv=CI=1', '--', ...command];
      const result = await runProcess('systemd-run', args, { cwd: directory, signal, timeoutMs: 16 * MINUTE });
      return { passed: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000) };
    } finally {
      signal.removeEventListener('abort', stop);
      if (linked) await fs.rm(modules, { force: true });
    }
  },
};

export type PairAgents = typeof pairAgents;
