import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ImageGpuState, ImagesStatus } from '@/shared/types';

const EMPTY: ImagesStatus = {
  configured: false,
  online: false,
  state: 'idle',
  leases: [],
};

const VALID_GPU_STATES: ReadonlySet<ImageGpuState> = new Set(['idle', 'llm', 'image', 'busy-external']);

/** Poll cadence (15 s) used while the document is visible to keep ComfyUI reachability and GPU lease state fresh. */
export const STATUS_POLL_MS = 15_000;

function normalizeGpuState(value: unknown): ImageGpuState {
  return typeof value === 'string' && VALID_GPU_STATES.has(value as ImageGpuState)
    ? (value as ImageGpuState)
    : 'idle';
}

/**
 * Used by the project-workspace module (WorkspaceMain) and ImagesPanel to check whether ComfyUI image generation is
 * configured and reachable, polling `/api/images/status` every 15 s while the page is visible.
 */
export function useImagesStatus(enabled = true): ImagesStatus & { refresh: () => Promise<void> } {
  // Latest ComfyUI configuration, reachability, and GPU arbiter snapshot from the server, driving tab visibility and the GPU pill.
  const [state, setState] = useState<ImagesStatus>(EMPTY);
  // True after unmount or disablement so a late status response never updates unmounted state.
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await readApiJson<Partial<ImagesStatus>>(await api.images.status());
      if (cancelled.current) return;
      setState({
        configured: data.configured === true,
        online: data.online === true,
        ...(typeof data.problem === 'string' && data.problem ? { problem: data.problem } : {}),
        state: normalizeGpuState(data.state),
        leases: Array.isArray(data.leases) ? data.leases : [],
      });
    } catch {
      // Signed out or console unreachable: preserve the last known state so the tab stays hidden if never configured.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    cancelled.current = false;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, STATUS_POLL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { ...state, refresh };
}
