import { Download, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { useImagesStatus } from '@/modules/images/hooks/useImagesStatus';
import { api, readApiJson } from '@/shared/api';
import type { GeneratedImageResult, ImageGenerateInput, ImageGpuState, ImagesStatus } from '@/shared/types';
import { Button } from '@/shared/ui';

const IMAGE_SIZES = [
  { value: '512x512', width: 512, height: 512 },
  { value: '768x768', width: 768, height: 768 },
  { value: '1024x1024', width: 1024, height: 1024 },
  { value: '1024x768', width: 1024, height: 768 },
  { value: '768x1024', width: 768, height: 1024 },
] as const;

type ImageSizeValue = (typeof IMAGE_SIZES)[number]['value'];

type SessionGeneratedImage = GeneratedImageResult & {
  prompt: string;
  objectUrl: string;
};

type ImagesPanelProps = {
  /** Shared status polled by WorkspaceMain; when omitted, ImagesPanel polls `/api/images/status` on its own. */
  status?: ImagesStatus & { refresh: () => Promise<void> };
};

function getGpuPill(status: ImagesStatus): { label: string; dotClass: string } {
  if (!status.configured) {
    return { label: 'Not configured', dotClass: 'bg-muted-foreground/40' };
  }
  if (!status.online) {
    return { label: 'ComfyUI offline', dotClass: 'bg-red-500' };
  }
  const byState: Record<ImageGpuState, { label: string; dotClass: string }> = {
    idle: { label: 'GPU idle', dotClass: 'bg-emerald-500' },
    llm: { label: 'GPU: Local LLM', dotClass: 'bg-amber-500' },
    image: { label: 'GPU: Generating image', dotClass: 'bg-sky-500' },
    'busy-external': { label: 'GPU busy', dotClass: 'bg-red-500' },
  };
  return byState[status.state];
}

/** Used by the project-workspace module (WorkspaceMain) to render the ComfyUI image generation tab. */
export default function ImagesPanel({ status: externalStatus }: ImagesPanelProps = {}) {
  const internalStatus = useImagesStatus(externalStatus === undefined);
  const status = externalStatus ?? internalStatus;

  // Positive prompt text sent to ComfyUI to describe the image to generate.
  const [prompt, setPrompt] = useState('');
  // Optional negative prompt text telling ComfyUI which visual elements or defects to avoid.
  const [negative, setNegative] = useState('');
  // Chosen width-by-height preset from the supported resolution options.
  const [size, setSize] = useState<ImageSizeValue>('512x512');
  // Optional seed text kept as a raw string so an empty field omits the seed and lets the server pick randomly.
  const [seedInput, setSeedInput] = useState('');
  // True while `/api/images/generate` and `/api/images/file/:id` are running, disabling the Generate button.
  const [generating, setGenerating] = useState(false);
  // Plain error message from the last failed generation or validation check, cleared before the next attempt.
  const [error, setError] = useState<string | null>(null);
  // Generated images from the current UI session (newest first) paired with their authenticated blob object URLs.
  const [results, setResults] = useState<SessionGeneratedImage[]>([]);

  // Tracks every created object URL so all blob URLs are revoked when the panel unmounts.
  const objectUrlsRef = useRef<string[]>([]);
  // False once unmounted so an in-flight image fetch revokes its blob URL instead of setting state.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const urls = objectUrlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.length = 0;
    };
  }, []);

  const selectedSize = IMAGE_SIZES.find((entry) => entry.value === size) ?? IMAGE_SIZES[0];
  const pill = getGpuPill(status);
  const canGenerate = status.configured && status.online && !generating && prompt.trim().length > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || generating || !status.configured || !status.online) {
      return;
    }

    const trimmedSeed = seedInput.trim();
    let parsedSeed: number | undefined;
    if (trimmedSeed !== '') {
      const numericSeed = Number(trimmedSeed);
      if (!Number.isSafeInteger(numericSeed) || numericSeed < 0) {
        setError('Seed must be a non-negative whole number.');
        return;
      }
      parsedSeed = numericSeed;
    }

    const trimmedNegative = negative.trim();
    const payload: ImageGenerateInput = {
      prompt: trimmedPrompt,
      ...(trimmedNegative ? { negative: trimmedNegative } : {}),
      width: selectedSize.width,
      height: selectedSize.height,
      ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
    };

    setGenerating(true);
    setError(null);
    try {
      const generated = await readApiJson<GeneratedImageResult>(await api.images.generate(payload));
      const fileResponse = await api.images.file(generated.id);
      if (!fileResponse.ok) {
        const contentType = fileResponse.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          await readApiJson(fileResponse);
        }
        throw new Error(`Could not load generated image (${fileResponse.status}).`);
      }

      const blob = await fileResponse.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (!mountedRef.current) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      objectUrlsRef.current.push(objectUrl);
      setResults((current) => [
        {
          ...generated,
          prompt: trimmedPrompt,
          objectUrl,
        },
        ...current,
      ]);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : 'Image generation failed.');
      if ((caught as { code?: string }).code === 'COMFYUI_OFFLINE') {
        void status.refresh();
      }
    } finally {
      if (mountedRef.current) {
        setGenerating(false);
      }
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
        <ImageIcon className="h-4 w-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Images</h2>
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground"
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${pill.dotClass}`} />
          {pill.label}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Generated locally on the private GPU host.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {!status.configured && (
            <div role="note" className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              Image generation is not configured. Set{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">COMFYUI_BASE_URL</code>{' '}
              in the server environment to your ComfyUI endpoint and restart the server.
              {status.problem ? ` (${status.problem})` : ''}
            </div>
          )}

          {status.configured && !status.online && (
            <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
              ComfyUI is offline or unreachable. Start ComfyUI on the GPU host and try again.
            </div>
          )}

          <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background/50 p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="images-prompt" className="text-xs font-medium text-foreground">
                Prompt
              </label>
              <textarea
                id="images-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Describe the image you want to generate…"
                className="min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="images-negative-prompt" className="text-xs font-medium text-foreground">
                Negative prompt
              </label>
              <input
                id="images-negative-prompt"
                type="text"
                value={negative}
                onChange={(event) => setNegative(event.target.value)}
                maxLength={2000}
                placeholder="Optional — details to avoid (blurry, watermark, low quality)"
                className="h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="images-size" className="text-xs font-medium text-foreground">
                  Size
                </label>
                <select
                  id="images-size"
                  value={size}
                  onChange={(event) => setSize(event.target.value as ImageSizeValue)}
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                >
                  {IMAGE_SIZES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.value}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="images-seed" className="text-xs font-medium text-foreground">
                  Seed
                </label>
                <input
                  id="images-seed"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={seedInput}
                  onChange={(event) => setSeedInput(event.target.value)}
                  placeholder="Random"
                  className="h-10 w-36 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                />
              </div>

              <Button type="submit" disabled={!canGenerate} className="ml-auto">
                {generating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                {generating ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </form>

          {error && (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {results.length > 0 && (
            <section aria-label="Generated images">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((item) => (
                  <article
                    key={item.id}
                    className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/60"
                  >
                    <img
                      src={item.objectUrl}
                      alt={item.prompt}
                      width={item.width}
                      height={item.height}
                      className="aspect-square w-full bg-muted/30 object-contain"
                    />
                    <div className="flex flex-col gap-2 p-3">
                      <p className="line-clamp-2 text-xs text-foreground">{item.prompt}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Seed: {item.seed}</span>
                        <span>·</span>
                        <span>
                          {item.width}x{item.height}
                        </span>
                        <a
                          href={item.objectUrl}
                          download={`image-${item.id}.png`}
                          className="ml-auto inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          Download
                        </a>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
