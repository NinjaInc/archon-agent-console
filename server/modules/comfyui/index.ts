/**
 * Public barrel for the ComfyUI image generation module.
 * Author: Josh Neufield (Archon Tech)
 */
// loadComfyuiConfig / ComfyuiConfig: used by server startup, CLI diagnostics, and tests to read COMFYUI_BASE_URL safely.
export { loadComfyuiConfig } from './comfyui.config.js';
export type { ComfyuiConfig } from './comfyui.config.js';
// createComfyuiModule / ComfyuiModule / ComfyuiModuleOptions: used by server/index.ts to wire the shared GPU arbiter and mount /api/images.
export { createComfyuiModule } from './comfyui.module.js';
export type { ComfyuiModule, ComfyuiModuleOptions } from './comfyui.module.js';
// createComfyuiRouter: used by server composition or integration harnesses mounting HTTP routes onto an existing ComfyuiService.
export { createComfyuiRouter } from './comfyui.routes.js';
// createComfyuiService and service types: used by server composition, agent/scheduled image callers, and tests.
export { createComfyuiService } from './comfyui.service.js';
export type {
  ComfyuiService,
  ComfyuiServiceOptions,
  ComfyuiStatus,
  GeneratedImage,
  GenerateImageInput,
} from './comfyui.service.js';
