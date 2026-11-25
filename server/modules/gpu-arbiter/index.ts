// getGpuArbiter: used by server/index.ts to wire the shared arbiter into image generation.
export { getGpuArbiter } from './gpu-arbiter.module.js';
// createGpuArbiter and its types: used by the comfyui module (types) and by callers that bring their own database.
export { createGpuArbiter } from './gpu-arbiter.service.js';
export type { GpuArbiter, GpuState, Lease, LeaseKind, LeasePriority, AcquireResult, ExternalCheck } from './gpu-arbiter.service.js';
