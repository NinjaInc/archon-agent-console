import express from 'express';

import type { createGithubReposService } from './github-repos.service.js';

/** Thin routes for the GitHub repositories view: parse input, call the service, return JSON. */
export function createGithubReposRouter(service: ReturnType<typeof createGithubReposService>): express.Router {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ repos: await service.list({ refresh: req.query.refresh === '1' }) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/open', async (req, res, next) => {
    try {
      res.json(await service.open((req.body as { nameWithOwner?: unknown }).nameWithOwner));
    } catch (error) {
      next(error);
    }
  });

  router.post('/clone', async (req, res, next) => {
    try {
      res.json(await service.clone((req.body as { nameWithOwner?: unknown }).nameWithOwner));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
