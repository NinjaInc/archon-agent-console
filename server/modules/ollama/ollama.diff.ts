/**
 * Prepares a git diff for the local model: drops files that must not leave this machine or are not worth reading,
 * then checks the rest fits the context window.
 * Author: Josh Neufield (Archon Tech)
 *
 * Nothing is ever silently cut. If what is left does not fit, the request is refused with a message that says how
 * big it is and what to do, so the model never answers from half a diff without the user knowing.
 */
import { AppError } from '@/shared/utils.js';

/** Tokens kept free for the instructions and the reply. */
export const RESERVED_TOKENS = 2048;
/** Characters per token, assumed low (code and logs tokenise badly) so the budget is a safe estimate. */
export const CHARS_PER_TOKEN = 3;

export type ExcludedFile = { path: string; reason: 'lockfile' | 'secret file' | 'binary file' };
export type PreparedDiff = { text: string; included: string[]; excluded: ExcludedFile[] };

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock',
  'go.sum', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'mix.lock', 'pubspec.lock',
  'flake.lock', 'podfile.lock', 'packages.lock.json',
]);
const SECRET_FILE_NAMES = new Set(['.npmrc', '.netrc', '.pgpass', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json']);
const SECRET_FILE_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i;
const SAFE_ENV_SUFFIX = /\.(example|sample|template|dist)$/i;

/** Character budget for text sent to the model at this context size. */
export function inputBudgetChars(numCtx: number): number {
  return Math.max(1000, (numCtx - RESERVED_TOKENS) * CHARS_PER_TOKEN);
}

export function classifyPath(filePath: string): ExcludedFile['reason'] | null {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (LOCKFILES.has(name)) return 'lockfile';
  if (name === '.env' || (name.startsWith('.env.') && !SAFE_ENV_SUFFIX.test(name))) return 'secret file';
  if (SECRET_FILE_NAMES.has(name) || SECRET_FILE_EXTENSIONS.test(name)) return 'secret file';
  return null;
}

/** The path a `diff --git a/x b/y` header refers to (the new name), including quoted names. */
function pathFromHeader(header: string): string {
  const match = header.match(/^diff --git (?:"a\/(.*?)"|a\/(.*?)) (?:"b\/(.*)"|b\/(.*))$/);
  return match ? (match[3] ?? match[4] ?? match[1] ?? match[2] ?? '') : header.replace(/^diff --git /, '');
}

function isBinary(chunk: string): boolean {
  return /^Binary files .* differ$/m.test(chunk) || /^GIT binary patch$/m.test(chunk);
}

export function tooLargeError(what: string, chars: number, budget: number): AppError {
  return new AppError(
    `${what} is too big for the local model (${chars.toLocaleString()} characters; the limit is about ${budget.toLocaleString()} at this context size). ` +
      'Nothing was sent. Use a smaller piece, such as one file or one section, or ask Claude Chat instead.',
    { code: 'OLLAMA_INPUT_TOO_LARGE', statusCode: 413 },
  );
}

/** Splits a unified diff by file, removes excluded files, and refuses a result that does not fit `maxChars`. */
export function prepareDiff(diff: string, maxChars: number): PreparedDiff {
  const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.trim() !== '');
  const included: string[] = [];
  const excluded: ExcludedFile[] = [];
  const kept: string[] = [];

  for (const part of parts) {
    const header = part.split('\n', 1)[0];
    const filePath = header.startsWith('diff --git ') ? pathFromHeader(header) : '';
    const reason = filePath ? (classifyPath(filePath) ?? (isBinary(part) ? 'binary file' : null)) : null;
    if (reason) {
      excluded.push({ path: filePath, reason });
    } else {
      kept.push(part);
      if (filePath) included.push(filePath);
    }
  }

  const text = kept.join('');
  if (text.trim() === '') {
    throw new AppError(
      excluded.length > 0
        ? `Nothing left to send: every changed file was excluded (${excluded.map((file) => `${file.path}: ${file.reason}`).join(', ')}).`
        : 'There is no diff to work with.',
      { code: 'OLLAMA_NOTHING_TO_SEND', statusCode: 422 },
    );
  }
  if (text.length > maxChars) throw tooLargeError('This diff', text.length, maxChars);
  return { text, included, excluded };
}
