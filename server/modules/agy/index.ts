// agyRoutes: used by the server entrypoint to mount protected Antigravity auth endpoints.
export { agyRoutes } from './agy.module.js';
// getAgyLaunchEnvironment: used by the websocket shell service to inject GEMINI_API_KEY into agy PTYs only.
export { getAgyLaunchEnvironment } from './agy.module.js';
