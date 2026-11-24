/**
 * Thin HTTP routes for ComfyUI image status, generation, and PNG serving (mounted at /api/images).
 * Author: Josh Neufield (Archon Tech)
 *
 * All GPU lease coordination, Ollama unloading, workflow assembly, ComfyUI communication, and disk I/O live in
 * comfyui.service.ts; these handlers only parse transport input, invoke the service, and shape the HTTP response.
 */
import express from 'express';

import { AppError } from '@/shared/utils.js';

import { IMAGE_ID_PATTERN, type ComfyuiService, type GenerateImageInput } from './comfyui.service.js';

function parseGenerateBody(raw: unknown): GenerateImageInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Request body must be a JSON object.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.prompt !== 'string') {
    throw new AppError('Prompt is required.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }
  if (body.negative !== undefined && typeof body.negative !== 'string') {
    throw new AppError('Negative prompt must be a string.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }
  if (typeof body.width !== 'number' || typeof body.height !== 'number') {
    throw new AppError('Width and height must be numbers.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }
  if (body.seed !== undefined && typeof body.seed !== 'number') {
    throw new AppError('Seed must be a number.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
  }
  return {
    prompt: body.prompt,
    ...(body.negative !== undefined ? { negative: body.negative } : {}),
    width: body.width,
    height: body.height,
    ...(body.seed !== undefined ? { seed: body.seed } : {}),
  };
}

/**
 * Builds the Express router for `/status`, `/generate`, and `/file/:id`.
 * Used by comfyui.module.ts for the server mount at `/api/images` and by tests/comfyui.routes.test.ts.
 */
export function createComfyuiRouter(service: ComfyuiService): express.Router {
  const router = express.Router();

  router.get('/status', async (_req, res, next) => {
    try {
      res.json(await service.status());
    } catch (error) {
      next(error);
    }
  });

  router.post('/generate', async (req, res, next) => {
    try {
      const input = parseGenerateBody(req.body);
      res.json(await service.generate(input));
    } catch (error) {
      next(error);
    }
  });

  router.get('/file/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string' || !IMAGE_ID_PATTERN.test(id)) {
        throw new AppError('Invalid image id.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 });
      }
      const pngBytes = await service.readImage(id);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(pngBytes);
    } catch (error) {
      next(error);
    }
  });

  // Any nested or empty path under /file (e.g. /file/a/b or /file/) is rejected as an invalid id.
  router.use('/file', (_req, _res, next) => {
    next(new AppError('Invalid image id.', { code: 'COMFYUI_BAD_REQUEST', statusCode: 400 }));
  });

  // Keep the structured error envelope consistent when mounted standalone or under server/index.ts.
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof URIError) {
      res.status(400).json({ success: false, error: { code: 'COMFYUI_BAD_REQUEST', message: 'Invalid image id.' } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  });

  return router;
}
