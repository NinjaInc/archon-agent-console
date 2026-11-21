#!/usr/bin/env node
/**
 * agy-pty - run Antigravity (`agy`) non-interactively from a pipe.
 *
 * Author: Josh Neufield (Archon Tech)
 *
 * `agy -p "<prompt>"` prints nothing when stdout is not a real TTY, so Claude Code's
 * Bash tool (or any script) cannot read its answer directly. This wrapper runs agy
 * inside a pseudo-terminal (node-pty), strips terminal escape codes, and prints the
 * plain-text result to stdout, passing agy's exit code through.
 *
 * Usage:
 *   scripts/agy-pty.mjs "summarise the README"            # prompt as argument
 *   echo "explain src/index.ts" | scripts/agy-pty.mjs -   # prompt from stdin
 *   scripts/agy-pty.mjs --cwd ~/projects/NinjaInc/foo --model gemini-4-argon-high "fix the lint errors"
 *
 * Options (everything else is forwarded to agy untouched):
 *   --cwd <dir>   working directory for agy (default: current directory)
 *   --timeout <s> kill agy after this many seconds (default 900)
 *
 * Security: no credentials are read, printed or logged here. agy uses its own
 * login/settings. Permissions are NOT auto-approved; pass --dangerously-skip-permissions
 * yourself only if you accept the risk.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// node-pty lives in the app's node_modules, whichever directory this is run from.
const pty = require(path.join(here, '..', 'node_modules', 'node-pty'));

const ANSI = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let timeoutSeconds = 900;
  const forwarded = [];
  let prompt = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cwd') {
      cwd = path.resolve(args[++i] ?? '');
    } else if (arg === '--timeout') {
      timeoutSeconds = Number(args[++i]) || timeoutSeconds;
    } else if (arg === '-') {
      prompt = (await readStdin()).trim();
    } else if (!arg.startsWith('-') && i === args.length - 1) {
      // The final positional argument is the prompt; earlier ones are flag values.
      prompt = arg;
    } else {
      forwarded.push(arg);
    }
  }

  if (!prompt) {
    console.error('agy-pty: a prompt is required (argument, or "-" to read stdin)');
    process.exit(2);
  }

  const child = pty.spawn('agy', ['-p', prompt, ...forwarded], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' },
  });

  let output = '';
  child.onData((chunk) => {
    output += chunk;
  });

  const timer = setTimeout(() => {
    console.error(`agy-pty: timed out after ${timeoutSeconds}s`);
    child.kill();
  }, timeoutSeconds * 1000);

  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    // A pty emits CRLF; normalise and drop escape sequences.
    process.stdout.write(output.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, ''));
    process.exit(exitCode ?? 0);
  });
}

main();
