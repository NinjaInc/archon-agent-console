import express from 'express';

import type { OllamaEvent } from '@/modules/ollama/index.js';
import { AppError } from '@/shared/utils.js';

import type { WebSearchService } from './web-search.service.js';

/**
 * Web search routes: results, page text, and a cited answer streamed as Server-Sent Events. All read-only, and all of the work
 * is in the service; these only parse the request and shape the response.
 * Used by web-search.module.ts, which the server mounts at /api/search behind authentication.
 */
export function createWebSearchRouter(service: WebSearchService, searchOnline: () => Promise<boolean>): express.Router {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    res.json({ search: (await searchOnline()) ? 'online' : 'offline', answers: service.answersAvailable });
  });

  router.get('/', async (req, res, next) => {
    try {
      const limit = Number(req.query.limit);
      res.json(await service.search(req.query.q, {
        limit: Number.isFinite(limit) ? limit : undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        timeRange: typeof req.query.time_range === 'string' ? req.query.time_range : undefined,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/read', async (req, res, next) => {
    try {
      res.json(await service.read(req.body?.url));
    } catch (error) {
      next(error);
    }
  });

  router.post('/answer', async (req, res, next) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let streaming = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const emit = (event: OllamaEvent) => {
      if (!streaming) {
        streaming = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        // Searching and a cold model load can be silent for a while; a comment frame keeps Cloudflare from closing the stream at ~100 s.
        heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await service.streamAnswer({ query: req.body?.query, sources: req.body?.sources, model: req.body?.model, think: req.body?.think }, emit, controller.signal);
      if (heartbeat) clearInterval(heartbeat);
      if (streaming) res.end();
      else res.status(204).end();
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (!streaming) {
        next(error);
      } else {
        const known = error instanceof AppError;
        res.write(`data: ${JSON.stringify({ type: 'error', code: known ? error.code : 'WEB_ANSWER_FAILED', message: known ? error.message : 'The answer could not be completed.' })}\n\n`);
        res.end();
      }
    }
  });

  // Keep the structured error shape the client already reads.
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  });

  return router;
}
