import express from 'express';

import type { createAgyService } from './agy.service.js';

/** Creates thin Antigravity auth routes: parse input, call the service, return booleans only. */
export function createAgyRouter(service: ReturnType<typeof createAgyService>): express.Router {
  const router = express.Router();

  router.get('/status', async (_req, res, next) => {
    try {
      res.json(await service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.get('/permissions', async (_req, res, next) => {
    try {
      res.json(await service.getAllowedCommands());
    } catch (error) {
      next(error);
    }
  });

  router.put('/permissions', async (req, res, next) => {
    try {
      res.json(await service.setAllowedCommands((req.body as { commands?: unknown }).commands));
    } catch (error) {
      next(error);
    }
  });

  router.put('/api-key', async (req, res, next) => {
    try {
      const body = req.body as { apiKey?: unknown };
      res.json(await service.setApiKey(body.apiKey));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api-key', async (_req, res, next) => {
    try {
      res.json(await service.clearApiKey());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
