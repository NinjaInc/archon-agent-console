import express from 'express';

import type { loadProdClaude } from './prod-claude.service.js';

/** Thin route: tells the UI whether to show the Prod Claude tab. Never returns key material. */
export function createProdClaudeRouter(load: () => ReturnType<typeof loadProdClaude>): express.Router {
  const router = express.Router();
  router.get('/status', async (_req, res, next) => {
    try {
      const loaded = await load();
      if (!loaded) {
        res.json({ configured: false });
        return;
      }
      const { config } = loaded;
      res.json({ configured: true, ready: loaded.keyPresent && loaded.hostKeyPinned, label: config.label, host: config.host, user: config.user });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
