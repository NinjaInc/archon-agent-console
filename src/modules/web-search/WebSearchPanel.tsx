import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Loader2, Search, Sparkles, Square } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { OllamaStreamEvent, WebAnswerSource, WebSearchResult } from '@/shared/types';
import { Markdown } from '@/modules/chat';
import { blockRemoteImages } from '@/modules/agy-chat';
import { readEventStream } from '@/modules/ollama';
import {
  CATEGORIES,
  TIME_RANGES,
  hostOf,
  linkCitations,
} from '@/modules/web-search/utils/webSearch';

type Status = { search: 'online' | 'offline' | 'unknown'; answers: boolean };
type Preview = { loading: boolean; title?: string; text?: string; error?: string };
type Answer = { query: string; sources: WebAnswerSource[]; text: string; phase: 'searching' | 'writing' | 'done'; error?: string };

/** Rendered by WorkspaceMain for the full-page Web search view: private search, safe page previews, and cited answers from the local model. */
export default function WebSearchPanel() {
  // What the user is typing; sent on Search or Answer, and kept so one query can be searched and then answered.
  const [query, setQuery] = useState('');
  // The kind of search (general, code, science, news); a request parameter the user chooses, not derivable.
  const [category, setCategory] = useState('general');
  // Optional recency filter chosen by the user ('' means any time).
  const [timeRange, setTimeRange] = useState('');
  // Whether the search service is up and whether cited answers are available; asked once from the server and updated when a search finds it down.
  const [status, setStatus] = useState<Status>({ search: 'unknown', answers: false });
  // The last search's hits; null means nothing has been searched yet (distinct from an empty result list).
  const [results, setResults] = useState<WebSearchResult[] | null>(null);
  // The cleaned query the server actually searched (it trims and normalises), shown above the results.
  const [searchedFor, setSearchedFor] = useState('');
  // True while a search request is in flight, to disable the button and show progress.
  const [searching, setSearching] = useState(false);
  // The server's message for a failed or refused search, shown inline; answers keep their own error inside the answer card.
  const [error, setError] = useState<string | null>(null);
  // Page-text previews opened by the user, keyed by result address, so each result can expand independently.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // The cited answer being streamed or finished (text, sources, phase, error); one answer at a time.
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Seconds since the answer started, so a slow first reply (model load) visibly progresses.
  const [elapsed, setElapsed] = useState(0);
  // Briefly true after Copy, to confirm it worked.
  const [copied, setCopied] = useState(false);
  // The in-flight answer request, so Stop and leaving the page can cancel it (and the server stops reading and generating).
  const abortRef = useRef<AbortController | null>(null);
  const answering = answer !== null && answer.phase !== 'done';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await readApiJson<Status>(await api.webSearch.status());
        if (!cancelled) setStatus({ search: data.search === 'online' ? 'online' : 'offline', answers: data.answers === true });
      } catch {
        if (!cancelled) setStatus({ search: 'offline', answers: false });
      }
    })();
    return () => { cancelled = true; abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!answering) return undefined;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [answering]);

  const runSearch = useCallback(async () => {
    const text = query.trim();
    if (!text || searching) return;
    setSearching(true);
    setError(null);
    setPreviews({});
    try {
      const data = await readApiJson<{ query: string; results: WebSearchResult[] }>(await api.webSearch.search(text, { limit: 10, category, timeRange: timeRange || undefined }));
      setResults(data.results);
      setSearchedFor(data.query);
      setStatus((current) => ({ ...current, search: 'online' }));
    } catch (caught) {
      setResults(null);
      setError(caught instanceof Error ? caught.message : 'The search failed');
      if ((caught as { code?: string }).code === 'WEB_SEARCH_OFFLINE') setStatus((current) => ({ ...current, search: 'offline' }));
    } finally {
      setSearching(false);
    }
  }, [query, category, timeRange, searching]);

  const runAnswer = useCallback(async () => {
    const text = query.trim();
    if (!text || answering) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setAnswer({ query: text, sources: [], text: '', phase: 'searching' });
    setError(null);
    try {
      const response = await api.webSearch.answer({ query: text, sources: 4 }, controller.signal);
      if (!response.ok) await readApiJson(response); // throws with the server's message
      await readEventStream(response, (event: OllamaStreamEvent) => {
        if (event.type === 'meta' && event.sources) setAnswer((current) => (current ? { ...current, sources: event.sources ?? [], phase: 'writing' } : current));
        else if (event.type === 'text') setAnswer((current) => (current ? { ...current, text: current.text + event.text, phase: 'writing' } : current));
        else if (event.type === 'error') setAnswer((current) => (current ? { ...current, error: event.message } : current));
      });
      setAnswer((current) => (current ? { ...current, phase: 'done' } : current));
    } catch (caught) {
      if ((caught as { name?: string }).name === 'AbortError') {
        setAnswer((current) => (current ? { ...current, phase: 'done' } : current));
      } else {
        setAnswer((current) => (current ? { ...current, phase: 'done', error: caught instanceof Error ? caught.message : 'The answer failed' } : current));
      }
    } finally {
      abortRef.current = null;
    }
  }, [query, answering]);

  const loadPreview = async (url: string) => {
    if (previews[url] && !previews[url].error) {
      setPreviews((current) => { const next = { ...current }; delete next[url]; return next; }); // second click closes it
      return;
    }
    setPreviews((current) => ({ ...current, [url]: { loading: true } }));
    try {
      const data = await readApiJson<{ title: string; text: string }>(await api.webSearch.read(url));
      setPreviews((current) => ({ ...current, [url]: { loading: false, title: data.title, text: data.text } }));
    } catch (caught) {
      setPreviews((current) => ({ ...current, [url]: { loading: false, error: caught instanceof Error ? caught.message : 'Could not read that page' } }));
    }
  };

  const copyAnswer = async () => {
    if (!answer?.text) return;
    try {
      await navigator.clipboard.writeText(answer.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the answer is still selectable on screen.
    }
  };

  const dot = status.search === 'online' ? 'bg-emerald-500' : status.search === 'offline' ? 'bg-red-500' : 'bg-muted-foreground/40';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
        <Globe className="h-4 w-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Web search</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
          {status.search === 'online' ? 'Private search online' : status.search === 'offline' ? 'Search service not running' : 'Checking…'}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">Queries go to public search engines. Page text is untrusted.</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); void runSearch(); }}
          >
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the web…"
              aria-label="Search"
              maxLength={300}
              className="h-10 w-full basis-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
            />
            <select aria-label="Kind of search" value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 rounded-xl border border-border bg-background px-2 text-sm">
              {CATEGORIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
            <select aria-label="Time range" value={timeRange} onChange={(event) => setTimeRange(event.target.value)} className="h-10 rounded-xl border border-border bg-background px-2 text-sm">
              {TIME_RANGES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
            <Button type="submit" disabled={!query.trim() || searching || status.search === 'offline'}>
              {searching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Search
            </Button>
            {answering ? (
              <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()} aria-label="Stop"><Square className="mr-1 h-4 w-4" />Stop</Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={!query.trim() || !status.answers || status.search === 'offline'}
                title={status.answers ? 'Reads the top pages and writes a cited answer with the local model' : 'Needs the local model (Ollama) to be set up'}
                onClick={() => void runAnswer()}
              >
                <Sparkles className="mr-1 h-4 w-4" />Answer with sources
              </Button>
            )}
          </form>

          {status.search === 'offline' && (
            <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
              The search service is not running on this server. Start it with <code>scripts/install-searxng.sh</code>, then reload this page.
            </div>
          )}
          {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

          {answer && (
            <section aria-label="Answer" className="rounded-2xl border border-border/60 bg-muted/20 p-4">
              <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded border border-border px-1.5 py-0.5 uppercase tracking-wide">Draft</span>
                <span className="truncate">Answer from the local model, using only the pages below</span>
                {answer.text && (
                  <button type="button" className="ml-auto flex items-center gap-1 hover:text-foreground" onClick={() => void copyAnswer()} aria-label="Copy answer">
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              {answer.phase !== 'done' && (
                <div role="status" aria-live="polite" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {answer.phase === 'searching' ? 'Searching and reading pages…' : 'Writing the answer…'} {elapsed}s
                </div>
              )}
              {answer.text && <div className="text-sm"><Markdown>{blockRemoteImages(linkCitations(answer.text, answer.sources))}</Markdown></div>}
              {answer.error && <div role="alert" className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{answer.error}</div>}
              {answer.sources.length > 0 && (
                <ol className="mt-3 space-y-1 border-t border-border/50 pt-3 text-xs">
                  {answer.sources.map((source) => (
                    <li key={source.n} className="flex gap-2">
                      <span className="text-muted-foreground">[{source.n}]</span>
                      <a href={source.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline">{source.title || hostOf(source.url)}</a>
                      <span className="shrink-0 text-muted-foreground">{hostOf(source.url)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          {results !== null && (
            <section aria-label="Results">
              <p className="mb-2 text-xs text-muted-foreground">{results.length === 0 ? `No results for “${searchedFor}”. Try different words.` : `${results.length} results for “${searchedFor}”`}</p>
              <ul className="flex flex-col gap-3">
                {results.map((result) => {
                  const preview = previews[result.url];
                  return (
                    <li key={result.url} className="rounded-xl border border-border/50 bg-background/50 p-3">
                      <a href={result.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1.5 text-sm font-medium text-primary hover:underline">
                        <span className="min-w-0">{result.title}</span><ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hostOf(result.url)}{result.published ? ` · ${result.published}` : ''}{result.engines.length > 0 ? ` · ${result.engines.join(', ')}` : ''}</div>
                      {result.snippet && <p className="mt-1 text-sm text-muted-foreground">{result.snippet}</p>}
                      <button type="button" className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void loadPreview(result.url)} aria-expanded={Boolean(preview && !preview.error)}>
                        {preview?.loading ? 'Reading…' : preview && !preview.error ? 'Hide preview' : 'Preview text'}
                      </button>
                      {preview?.error && <p role="alert" className="mt-2 text-xs text-destructive">{preview.error}</p>}
                      {preview?.text && (
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/30 p-2 font-sans text-xs" aria-label="Page text preview">{preview.text}</pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {results === null && !answer && !error && status.search !== 'offline' && (
            <p className="mt-6 text-center text-sm text-muted-foreground">Private web search. Press <strong>Answer with sources</strong> and the local model reads the top pages and writes a short answer with numbered citations.</p>
          )}
        </div>
      </div>
    </div>
  );
}
