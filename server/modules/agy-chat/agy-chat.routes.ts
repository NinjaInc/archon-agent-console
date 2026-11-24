import express from 'express';

import type { AgyUsageLimit } from '@/shared/types.js';
import type { createAgyChatService } from './agy-chat.service.js';

/** Thin Antigravity chat routes. Sending a message answers as a Server-Sent Events stream of normalised events. */
export function createAgyChatRouter(
  service: ReturnType<typeof createAgyChatService>,
  listModels: () => Promise<string[]>,
  listUsage: () => Promise<AgyUsageLimit[]>,
  /** Called once a turn ends, for the push notification. Never receives message text. */
  onTurnFinished?: (turn: { userId: number; chatId: string; status: string; seconds: number; steps: number; error?: string }) => void,
): express.Router {
  const router = express.Router();

  router.get('/models', async (_req, res, next) => {
    try {
      res.json({ models: await listModels() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/usage', async (_req, res, next) => {
    try {
      res.json({ limits: await listUsage() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      res.json({ chats: await service.listChats(req.query.projectId) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      res.json({ chat: await service.createChat(req.body ?? {}) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:chatId', (req, res, next) => {
    try {
      res.json(service.getChat(req.params.chatId));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:chatId', (req, res, next) => {
    try {
      res.json(service.deleteChat(req.params.chatId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:chatId/stop', (req, res, next) => {
    try {
      res.json(service.stop(req.params.chatId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:chatId/messages', async (req, res, next) => {
    const startedAt = Date.now();
    const outcome = { status: 'SUCCESS', steps: 0, error: undefined as string | undefined };
    // The turn belongs to the chat, not to this connection. A browser that disconnects (tab switch, sleeping laptop, a
    // tunnel hiccup, a phone locking) must not kill the turn and lose the reply: it keeps running, is saved when it ends,
    // and the page picks it up again. Only the Stop button (POST /:chatId/stop) cancels a turn.
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    let streaming = false;
    // Cloudflare closes a response that sends nothing for ~100 s, which would cut a long turn; a comment frame keeps it open.
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      await service.sendMessage(
        req.params.chatId,
        req.body ?? {},
        (event) => {
          if (event.type === 'done') outcome.status = event.status;
          else if (event.type === 'error') outcome.error = event.message;
          else if (event.type === 'tool' && event.state === 'done') outcome.steps += 1;
          if (clientGone) return; // nobody is listening; the service still saves everything
          if (!streaming) {
            streaming = true;
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            heartbeat = setInterval(() => { if (!clientGone) res.write(': ping\n\n'); }, 25_000);
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      );
      if (heartbeat) clearInterval(heartbeat);
      const userId = (req as { user?: { id?: number } }).user?.id;
      if (userId && onTurnFinished) {
        try {
          onTurnFinished({ userId, chatId: req.params.chatId, status: outcome.status, seconds: (Date.now() - startedAt) / 1000, steps: outcome.steps, error: outcome.error });
        } catch {
          // A notification problem must never fail the chat.
        }
      }
      if (clientGone) return;
      if (!streaming) res.status(204).end();
      else res.end();
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (clientGone) return;
      // Validation errors arrive before any streaming starts, so the normal error handler can answer.
      if (!streaming) {
        next(error);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Chat failed' })}\n\n`);
        res.end();
      }
    }
  });

  return router;
}
