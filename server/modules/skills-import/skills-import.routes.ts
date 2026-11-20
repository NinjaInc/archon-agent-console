import express from 'express';

import type { createSkillsImportService } from './skills-import.service.js';

/** Thin routes for importing and managing SKILL.md skills: parse input, call the service, return JSON. */
export function createSkillsImportRouter(service: ReturnType<typeof createSkillsImportService>): express.Router {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ skills: await service.list({ projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined }) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/preview', (req, res, next) => {
    try {
      res.json(service.preview(req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  router.post('/import', async (req, res, next) => {
    try {
      res.json(await service.importSkill(req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  router.post('/remove', async (req, res, next) => {
    try {
      res.json(await service.remove(req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
