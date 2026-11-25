import express from 'express';

import { AppError } from '@/shared/utils.js';

import type { PairService } from './pair.service.js';

/** Thin pair routes, mounted at /api/pair by pair.module.ts. Every run belongs to the signed-in user who started it. */
export function createPairRouter(service: PairService): express.Router {
  const router = express.Router();
  const handle = (work: (req: express.Request, userId: number) => unknown): express.RequestHandler => async (req, res, next) => {
    try {
      const userId = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
      if (!Number.isFinite(userId)) throw new AppError('Sign in first', { code: 'PAIR_UNAUTHENTICATED', statusCode: 401 });
      res.json(await work(req, userId));
    } catch (error) {
      next(error);
    }
  };

  router.get('/', handle((req, userId) => ({ runs: service.list(userId, req.query.projectId) })));
  router.post('/', handle(async (req, userId) => ({ run: await service.start(userId, req.body ?? {}) })));
  router.get('/:id', handle((req, userId) => ({ run: service.get(userId, req.params.id) })));
  router.post('/:id/approve-plan', handle((req, userId) => ({ run: service.approvePlan(userId, req.params.id) })));
  router.post('/:id/approve-diff', handle(async (req, userId) => ({ run: await service.approveDiff(userId, req.params.id, req.body?.hash) })));
  router.post('/:id/keep', handle(async (req, userId) => ({ run: await service.keep(userId, req.params.id) })));
  router.post('/:id/discard', handle(async (req, userId) => ({ run: await service.discard(userId, req.params.id) })));
  router.post('/:id/stop', handle((req, userId) => ({ run: service.stop(userId, req.params.id) })));
  return router;
}
