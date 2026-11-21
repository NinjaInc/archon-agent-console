import { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2, RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';

type LocalServer = { port: number; host: string; process: string };

type BrowserPreviewBarProps = {
  /** False until the Browser is turned on in settings; the bar then explains instead of acting. */
  enabled: boolean;
  /** Called after a URL was opened, so the panel reloads its session list and shows the new view. */
  onOpened: () => void;
};

/** Used by BrowserUsePanel (same module) to open a test site or a running dev server in the server-side browser. */
export default function BrowserPreviewBar({ enabled, onOpened }: BrowserPreviewBarProps) {
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [url, setUrl] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    try {
      setServers((await readApiJson<{ data: { servers: LocalServer[] } }>(await api.browserUse.localServers())).data.servers);
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const open = async (target: string) => {
    if (!target.trim()) return;
    setOpening(target);
    setError(null);
    try {
      await readApiJson(await api.browserUse.preview(target));
      onOpened();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open that');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="border-b border-border/60 bg-muted/20 px-4 py-2.5">
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void open(url); }}>
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Preview a site or local server, e.g. localhost:5173"
          aria-label="URL to preview"
          disabled={!enabled}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
        />
        <Button type="submit" size="sm" disabled={!enabled || !url.trim() || opening !== null}>
          {opening === url && opening !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Open'}
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>Running on this server:</span>
        {servers.length === 0 && <span>nothing detected (start a dev server, then refresh)</span>}
        {servers.map((server) => {
          const target = `http://${server.host}:${server.port}/`;
          return (
            <button key={server.port} type="button" disabled={!enabled || opening !== null} onClick={() => void open(target)} title={`${server.process} on ${server.host}:${server.port}`} className="rounded-full border border-border bg-background px-2 py-0.5 font-mono hover:text-foreground disabled:opacity-50">
              {opening === target ? '…' : `:${server.port}`} <span className="text-muted-foreground/70">{server.process}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => void loadServers()} aria-label="Refresh running servers" className="rounded-full p-1 hover:text-foreground"><RefreshCw className="h-3 w-3" /></button>
      </div>
      {!enabled && <p className="mt-1.5 text-xs text-amber-500">Turn the Browser on in Settings to preview sites here.</p>}
      {error && <p role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}
