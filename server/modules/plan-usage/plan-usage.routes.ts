import express from 'express';

import type { createPlanUsageService } from './plan-usage.service.js';

/** Thin route: GET / answers { limits }. Used by plan-usage.module.ts for the /api/usage mount. */
export function createPlanUsageRouter(service: ReturnType<typeof createPlanUsageService>): express.Router {
  const router = express.Router();
  router.get('/', async (_req, res, next) => {
    try {
      res.json({ limits: await service.list() });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
