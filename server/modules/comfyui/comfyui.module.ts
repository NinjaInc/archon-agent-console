/**
 * Composition root for the ComfyUI image module.
 * Author: Josh Neufield (Archon Tech)
 */
import type express from 'express';

import type { GpuArbiter } from '@/modules/gpu-arbiter/index.js';

import { loadComfyuiConfig, type ComfyuiConfig } from './comfyui.config.js';
import { createComfyuiRouter } from './comfyui.routes.js';
import { createComfyuiService, type ComfyuiService } from './comfyui.service.js';

/**
 * External dependencies wired when assembling the ComfyUI module at server startup.
 * Consumed by server/index.ts (via index.ts) when mounting `/api/images`.
 */
export type ComfyuiModuleOptions = {
  arbiter: Pick<GpuArbiter, 'acquire' | 'heartbeat' | 'release' | 'state'>;
  unloadOllama: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

/**
 * Assembled ComfyUI module bundle exposing the Express router, service, and loaded config.
 * Consumed by server/index.ts (via index.ts) to mount `/api/images` and share the service with internal callers.
 */
export type ComfyuiModule = {
  comfyuiRoutes: express.Router;
  comfyuiService: ComfyuiService;
  comfyuiConfig: ComfyuiConfig;
};

/**
 * Loads ComfyUI environment configuration and wires the service and `/api/images` router.
 * Used by server/index.ts (via index.ts) once the shared GPU arbiter and Ollama unload hook are initialized.
 */
export function createComfyuiModule({ arbiter, unloadOllama, env = process.env }: ComfyuiModuleOptions): ComfyuiModule {
  const comfyuiConfig = loadComfyuiConfig(env);
  if (comfyuiConfig.problem) {
    console.warn(`[comfyui] image generation is off: ${comfyuiConfig.problem}`);
  }
  const comfyuiService = createComfyuiService({
    config: comfyuiConfig,
    arbiter,
    unloadOllama,
  });
  const comfyuiRoutes = createComfyuiRouter(comfyuiService);
  return { comfyuiRoutes, comfyuiService, comfyuiConfig };
}
