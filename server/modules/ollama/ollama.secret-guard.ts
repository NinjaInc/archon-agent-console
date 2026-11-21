/**
 * Refuses text that looks like it holds a secret, before anything is sent to the local model.
 * Author: Josh Neufield (Archon Tech)
 *
 * The local model sits on another machine, so the rule is simple: if it looks like a key, a token or a password,
 * it is not sent. This reports WHAT kind of secret was found, never the value, so the message is safe to show and log.
 * It errs towards refusing obvious secrets only; ordinary code such as `const token = request.headers.authorization`
 * is allowed, because a quoted value or an env-style line is what a real leak looks like.
 */

type Pattern = { kind: string; test: RegExp };

const SECRET_WORDS = '(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|credential)';

const PATTERNS: Pattern[] = [
  { kind: 'a private key', test: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'an AWS access key', test: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'a GitHub token', test: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { kind: 'an API key (sk-...)', test: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'a Google API key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'a Slack token', test: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'a JSON web token', test: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'a bearer token', test: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { kind: 'a URL with a password in it', test: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  // KEY=value on its own line, the way an .env file or a shell export looks (also inside a diff's +/- lines).
  { kind: 'an environment secret (NAME=value)', test: new RegExp(`^[+\\- ]?\\s*(?:export\\s+)?[A-Za-z][A-Za-z0-9_]*${SECRET_WORDS}[A-Za-z0-9_]*\\s*=\\s*[^\\s#]{8,}`, 'im') },
  // "password": "hunter2hunter2" or token = 'abcdef123456' (a quoted literal, not a variable name).
  { kind: 'a quoted secret value', test: new RegExp(`${SECRET_WORDS}["']?\\s*[:=]\\s*["'][^"'\\s]{8,}["']`, 'i') },
];

/** Kinds of secret found in the text (empty when it looks clean). Never returns the values themselves. */
export function findSecrets(text: string): string[] {
  const kinds: string[] = [];
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) kinds.push(pattern.kind);
  }
  return kinds;
}
