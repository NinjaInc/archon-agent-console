import express from 'express';

import { AppError, findSecrets } from '@/shared/utils.js';

import { inputBudgetChars, prepareDiff, tooLargeError, type PreparedDiff } from './ollama.diff.js';
import { CHAT_SYSTEM, TASKS, isTaskName, wrapInput } from './ollama.tasks.js';
import type { ChatMessage, OllamaError, OllamaEvent, OllamaService } from './ollama.service.js';

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20_000;

export type OllamaRouterDependencies = {
  service: OllamaService;
  numCtx: number;
  configured: boolean;
  /** Real folder of a registered project inside the allowed roots, or null. */
  resolveProjectDir: (projectId: string) => Promise<string | null>;
  /** `git diff` text for a project: staged changes only, or everything since the last commit. No shell is involved. */
  readGitDiff: (directory: string, staged: boolean) => Promise<string>;
};

/** Refuses text that looks like it contains a secret. Says what kind, never the value. */
function assertNoSecrets(text: string): void {
  const kinds = findSecrets(text);
  if (kinds.length > 0) {
    throw new AppError(
      `Not sent: this looks like it contains ${kinds.join(' and ')}. The local model only gets text with no secrets in it. Remove them (or blank the values) and try again.`,
      { code: 'OLLAMA_SECRETS_REFUSED', statusCode: 422 },
    );
  }
}

/** Validates the browser's chat history. The server adds the only system message; a client can never supply one. */
export function validateChatMessages(raw: unknown, budgetChars: number): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    throw new AppError(`Send between 1 and ${MAX_MESSAGES} messages.`, { code: 'OLLAMA_BAD_REQUEST', statusCode: 400 });
  }
  const messages: ChatMessage[] = raw.map((entry) => {
    const role = (entry as { role?: unknown })?.role;
    const content = (entry as { content?: unknown })?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.trim() === '' || content.length > MAX_MESSAGE_CHARS) {
      throw new AppError('Each message needs a role of user or assistant and some text (up to 20,000 characters).', { code: 'OLLAMA_BAD_REQUEST', statusCode: 400 });
    }
    return { role, content };
  });
  if (messages[messages.length - 1].role !== 'user') throw new AppError('The last message must be from the user.', { code: 'OLLAMA_BAD_REQUEST', statusCode: 400 });
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total > budgetChars) throw tooLargeError('This conversation', total, budgetChars);
  return messages;
}

function errorEnvelope(error: OllamaError | AppError) {
  return { code: error.code, message: error.message };
}

/** Local (Ollama) routes. Chat and tasks answer as Server-Sent Events, like Agy Chat. */
export function createOllamaRouter(deps: OllamaRouterDependencies): express.Router {
  const router = express.Router();
  const { service } = deps;
  const budget = inputBudgetChars(deps.numCtx);

  router.use((req, _res, next) => {
    if (!deps.configured && req.path !== '/status') return next(new AppError('The local model is not set up on this server.', { code: 'OLLAMA_NOT_CONFIGURED', statusCode: 404 }));
    return next();
  });

  router.get('/status', async (req, res) => {
    // A cheap answer: the poller keeps this fresh. An unknown state, or "Check again" (?fresh=1), checks once now.
    if (deps.configured && (req.query.fresh === '1' || service.getHealth().status === 'unknown')) await service.checkHealth();
    res.json(service.getStatus());
  });

  router.get('/models', async (_req, res, next) => {
    try {
      await service.ensureOnline();
      res.json({ models: service.getHealth().models, defaultModel: service.getStatus().model });
    } catch (error) {
      next(error);
    }
  });

  router.post('/warmup', async (req, res, next) => {
    try {
      const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
      res.json({ ok: true, ...(await service.warmUp(model)) });
    } catch (error) {
      next(error);
    }
  });

  /** Runs `prepare` (which may throw a normal error), then streams the model's answer as SSE. */
  async function streamTurn(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    prepare: () => Promise<{ messages: ChatMessage[]; meta?: OllamaEvent }>,
    options: { model?: string; think?: boolean },
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let streaming = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const emit = (event: OllamaEvent) => {
      if (!streaming) {
        streaming = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        // A cold start can be silent for a while; a comment frame keeps Cloudflare from closing the stream at ~100 s.
        heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const { messages, meta } = await prepare();
      await service.streamChat({ model: options.model, messages, think: options.think, preamble: meta }, emit, controller.signal);
      if (heartbeat) clearInterval(heartbeat);
      if (streaming) res.end();
      else res.status(204).end();
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (!streaming) {
        next(error);
      } else {
        const known = error instanceof AppError;
        res.write(`data: ${JSON.stringify({ type: 'error', code: known ? error.code : 'OLLAMA_UPSTREAM', message: known ? error.message : 'The local model request failed.' })}\n\n`);
        res.end();
      }
    }
  }

  router.post('/chat', async (req, res, next) => {
    await streamTurn(
      req,
      res,
      next,
      async () => {
        const messages = validateChatMessages(req.body?.messages, budget);
        assertNoSecrets(messages.map((message) => message.content).join('\n'));
        return { messages: [{ role: 'system', content: CHAT_SYSTEM }, ...messages], meta: { type: 'meta', draft: true } };
      },
      { model: typeof req.body?.model === 'string' ? req.body.model : undefined, think: req.body?.think === true },
    );
  });

  router.post('/tasks/:name', async (req, res, next) => {
    await streamTurn(
      req,
      res,
      next,
      async () => {
        if (!isTaskName(req.params.name)) throw new AppError('Unknown task.', { code: 'OLLAMA_BAD_REQUEST', statusCode: 404 });
        const name = req.params.name;
        const task = TASKS[name];
        const pasted = typeof req.body?.text === 'string' ? req.body.text : '';
        let input = pasted;
        let prepared: PreparedDiff | null = null;

        if (task.input === 'text') {
          if (pasted.trim() === '') throw new AppError(`${task.label} needs some text to work on.`, { code: 'OLLAMA_BAD_REQUEST', statusCode: 400 });
          if (pasted.length > budget) throw tooLargeError('This text', pasted.length, budget);
        } else {
          // Diff tasks use pasted diff text when given, otherwise the selected project's git diff. Either way the
          // same filter runs (no lockfiles, secret files or binaries) and the result must fit the context window.
          let diff = pasted;
          if (diff.trim() === '') {
            const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
            const directory = projectId ? await deps.resolveProjectDir(projectId) : null;
            if (!directory) throw new AppError('Open a project first, or paste a diff.', { code: 'OLLAMA_BAD_REQUEST', statusCode: 400 });
            diff = await deps.readGitDiff(directory, task.input === 'staged-diff');
            if (diff.trim() === '') {
              throw new AppError(task.input === 'staged-diff' ? 'Nothing is staged. Stage your changes (git add) and try again.' : 'There are no changes to explain.', { code: 'OLLAMA_NOTHING_TO_SEND', statusCode: 422 });
            }
          }
          prepared = prepareDiff(diff, budget);
          input = prepared.text;
        }

        assertNoSecrets(input);
        return {
          messages: [
            { role: 'system', content: task.system },
            { role: 'user', content: wrapInput(input) },
          ],
          meta: { type: 'meta', task: name, draft: true, included: prepared?.included, excluded: prepared?.excluded },
        };
      },
      { model: typeof req.body?.model === 'string' ? req.body.model : undefined, think: req.body?.think === true },
    );
  });

  // Pre-stream failures arrive here as AppError; keep the shape the client already reads.
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: errorEnvelope(error) });
      return;
    }
    next(error);
  });

  return router;
}
