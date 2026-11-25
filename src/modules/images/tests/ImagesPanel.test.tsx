import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ImagesPanel from '@/modules/images/ImagesPanel';
import { STATUS_POLL_MS, useImagesStatus } from '@/modules/images/hooks/useImagesStatus';
import type * as ApiModule from '@/shared/api';
import type { ImagesStatus } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  generate: vi.fn(),
  file: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: {
      ...original.api,
      images: {
        status: mocks.status,
        generate: mocks.generate,
        file: mocks.file,
      },
    },
  };
});

let blobSeq = 0;
const createObjectURL = vi.fn((_blob: Blob) => `blob:generated-${++blobSeq}`);
const revokeObjectURL = vi.fn();

const jsonOk = (body: object) => Response.json(body);
const jsonError = (status: number, code: string, message: string) =>
  Response.json({ success: false, error: { code, message } }, { status });
const pngResponse = () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });

const makeStatus = (overrides: Partial<ImagesStatus> = {}): ImagesStatus & { refresh: () => Promise<void> } => ({
  configured: true,
  online: true,
  state: 'idle',
  leases: [],
  refresh: vi.fn(async () => undefined),
  ...overrides,
});

beforeEach(() => {
  blobSeq = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;

  mocks.status.mockReset().mockResolvedValue(
    jsonOk({ configured: true, online: true, state: 'idle', leases: [] }),
  );
  mocks.generate.mockReset();
  mocks.file.mockReset();
});

test('not configured: shows COMFYUI_BASE_URL setup hint with no private addresses and disables Generate', async () => {
  mocks.status.mockResolvedValue(
    jsonOk({ configured: false, online: false, state: 'idle', leases: [] }),
  );

  render(<ImagesPanel />);

  await screen.findByText('Not configured');
  const note = screen.getByRole('note');
  assert.match(note.textContent ?? '', /COMFYUI_BASE_URL/);
  assert.doesNotMatch(
    note.textContent ?? '',
    /127\.0\.0\.1|localhost|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./i,
  );

  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A quiet harbour at dusk' } });
  assert.equal((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled, true);
});

test('offline: shows offline banner and pill, and keeps Generate disabled', async () => {
  mocks.status.mockResolvedValue(
    jsonOk({ configured: true, online: false, state: 'idle', leases: [] }),
  );

  render(<ImagesPanel />);

  await screen.findByText('ComfyUI offline');
  assert.match(screen.getByRole('alert').textContent ?? '', /ComfyUI is offline/i);

  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse' } });
  assert.equal((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled, true);
});

test('renders all GPU status pill states and all five size options', () => {
  const { rerender } = render(<ImagesPanel status={makeStatus({ state: 'idle' })} />);
  assert.equal(screen.getByRole('status').textContent, 'GPU idle');

  const sizeOptions = Array.from(
    (screen.getByLabelText('Size') as HTMLSelectElement).querySelectorAll('option'),
  ).map((option) => option.value);
  assert.deepEqual(sizeOptions, ['512x512', '768x768', '1024x1024', '1024x768', '768x1024']);

  rerender(<ImagesPanel status={makeStatus({ state: 'llm' })} />);
  assert.equal(screen.getByRole('status').textContent, 'GPU: Local LLM');

  rerender(<ImagesPanel status={makeStatus({ state: 'image' })} />);
  assert.equal(screen.getByRole('status').textContent, 'GPU: Generating image');

  rerender(<ImagesPanel status={makeStatus({ state: 'busy-external' })} />);
  assert.equal(screen.getByRole('status').textContent, 'GPU busy');
});

test('polls /api/images/status every 15s only while the page is visible', async () => {
  vi.useFakeTimers();
  try {
    render(<ImagesPanel />);
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(mocks.status.mock.calls.length, 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    assert.equal(mocks.status.mock.calls.length, 2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    assert.equal(mocks.status.mock.calls.length, 2);
  } finally {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    vi.useRealTimers();
  }
});

test('generate calls the API, fetches the PNG, renders the image with seed and Download link, and revokes URLs on unmount', async () => {
  let resolveGenerate!: (response: Response) => void;
  mocks.generate.mockReturnValue(
    new Promise<Response>((resolve) => {
      resolveGenerate = resolve;
    }),
  );
  mocks.file.mockResolvedValue(pngResponse());

  const { unmount } = render(<ImagesPanel status={makeStatus()} />);

  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A sunlit mountain cabin' } });
  fireEvent.change(screen.getByLabelText('Negative prompt'), { target: { value: 'blurry, watermark' } });
  fireEvent.change(screen.getByLabelText('Size'), { target: { value: '1024x768' } });
  fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '42' } });

  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

  const runningButton = screen.getByRole('button', { name: 'Generating…' }) as HTMLButtonElement;
  assert.equal(runningButton.disabled, true);

  resolveGenerate(
    jsonOk({
      id: '0123456789abcdef',
      width: 1024,
      height: 768,
      seed: 42,
    }),
  );

  const img = (await screen.findByAltText('A sunlit mountain cabin')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), 'blob:generated-1');
  assert.deepEqual(mocks.generate.mock.calls[0], [
    {
      prompt: 'A sunlit mountain cabin',
      negative: 'blurry, watermark',
      width: 1024,
      height: 768,
      seed: 42,
    },
  ]);
  assert.deepEqual(mocks.file.mock.calls[0], ['0123456789abcdef']);
  assert.equal(createObjectURL.mock.calls.length, 1);

  assert.ok(screen.getByText('Seed: 42'));
  const downloadLink = screen.getByRole('link', { name: 'Download' });
  assert.equal(downloadLink.getAttribute('href'), 'blob:generated-1');
  assert.equal(downloadLink.getAttribute('download'), 'image-0123456789abcdef.png');

  await waitFor(() => {
    assert.equal((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled, false);
  });

  unmount();
  assert.deepEqual(revokeObjectURL.mock.calls, [['blob:generated-1']]);
});

test('shows plain error message when generate fails with structured error envelope', async () => {
  mocks.generate.mockResolvedValue(
    jsonError(422, 'COMFYUI_SECRETS_REFUSED', 'Not generated: prompt looks like it contains a GitHub token.'),
  );

  render(<ImagesPanel status={makeStatus()} />);

  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'ghp_secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

  const alert = await screen.findByRole('alert');
  assert.equal(alert.textContent, 'Not generated: prompt looks like it contains a GitHub token.');
  assert.equal(mocks.file.mock.calls.length, 0);
});

test('useImagesStatus keeps configured false when not configured so the tab stays hidden', async () => {
  mocks.status.mockResolvedValueOnce(
    jsonOk({ configured: false, online: false, state: 'idle', leases: [] }),
  );

  const { result } = renderHook(() => useImagesStatus());
  assert.equal(result.current.configured, false);

  await waitFor(() => {
    assert.equal(mocks.status.mock.calls.length, 1);
  });
  assert.equal(result.current.configured, false);
});

