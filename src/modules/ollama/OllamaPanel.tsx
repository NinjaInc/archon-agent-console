import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Cpu, Loader2, RefreshCw, Send, Square, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { Project } from '@/shared/types';
import { Markdown } from '@/modules/chat';
import { blockRemoteImages } from '@/modules/agy-chat';
import type { OllamaStatus } from '@/modules/ollama/hooks/useOllamaStatus';
import {
  TASKS,
  parseSlashCommand,
  readEventStream,
  selectHistory,
  suggestCommands,
  type HistoryItem,
  type OllamaStreamEvent,
  type TaskName,
} from '@/modules/ollama/utils/ollamaChat';

/** Characters of earlier conversation sent along; the server refuses more than the 8k context allows. */
const HISTORY_CHARS = 12_000;

type Excluded = Array<{ path: string; reason: string }>;

type Item =
  | { kind: 'user'; id: string; text: string; task?: TaskName }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; task?: TaskName; excluded?: Excluded; tokensPerSecond?: number }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string };

type Phase = { state: 'sending' | 'loading' | 'generating'; message?: string } | null;

type OllamaPanelProps = {
  selectedProject: Project;
  /** Shared with the tab bar so the dot there and the one here always agree. */
  ollama: OllamaStatus & { refresh: () => Promise<void> };
  /** Called only when the user chooses to move to Claude Chat; never on its own. */
  onOpenClaudeChat: () => void;
};

/** Rendered by WorkspaceMain for the Local LLM tab: draft-only chat and task shortcuts on the Ollama model, with no tools. */
export default function OllamaPanel({ selectedProject, ollama, onOpenClaudeChat }: OllamaPanelProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [think, setThink] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [warm, setWarm] = useState<'idle' | 'warming' | 'ready' | 'failed'>('idle');
  const [offlineText, setOfflineText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const assistantRef = useRef<string | null>(null);
  const warmedRef = useRef<string | null>(null);
  const counter = useRef(0);
  const nextId = () => `local-${counter.current++}`;

  const online = ollama.status === 'online';
  const offline = ollama.status === 'offline';
  const isStreaming = phase !== null;

  // Default to the configured model once the list arrives.
  useEffect(() => {
    if (model || ollama.models.length === 0) return;
    setModel(ollama.models.some((entry) => entry.name === ollama.model) ? ollama.model : ollama.models[0].name);
  }, [model, ollama.model, ollama.models]);

  // Warm-up ping when the tab opens (and again when the host comes back): loads the model into the GPU now, so the
  // first real message does not pay for it. A failure is not fatal; the first message will report the real problem.
  useEffect(() => {
    if (offline) warmedRef.current = null;
    if (!online || !model || warmedRef.current === model) return undefined;
    warmedRef.current = model;
    let cancelled = false;
    setWarm('warming');
    (async () => {
      try {
        await readApiJson(await api.ollama.warmup(model));
        if (!cancelled) setWarm('ready');
      } catch {
        if (!cancelled) setWarm('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [online, offline, model]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: 'end' }); }, [items, phase]);
  useEffect(() => {
    if (!isStreaming) return undefined;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  const patchAssistant = useCallback((patch: (item: Extract<Item, { kind: 'assistant' }>) => Extract<Item, { kind: 'assistant' }>) => {
    if (!assistantRef.current) {
      const created = `local-${counter.current++}`;
      assistantRef.current = created;
      setItems((current) => [...current, { kind: 'assistant', id: created, text: '', reasoning: '' }]);
    }
    const id = assistantRef.current;
    setItems((current) => current.map((item) => (item.id === id && item.kind === 'assistant' ? patch(item) : item)));
  }, []);

  const handleEvent = useCallback((event: OllamaStreamEvent) => {
    if (event.type === 'meta') {
      patchAssistant((item) => ({ ...item, task: event.task as TaskName | undefined, excluded: event.excluded }));
    } else if (event.type === 'status') {
      setPhase({ state: event.state, message: event.message });
    } else if (event.type === 'reasoning') {
      patchAssistant((item) => ({ ...item, reasoning: item.reasoning + event.text }));
    } else if (event.type === 'text') {
      patchAssistant((item) => ({ ...item, text: item.text + event.text }));
    } else if (event.type === 'usage') {
      patchAssistant((item) => ({ ...item, tokensPerSecond: event.tokensPerSecond }));
    } else if (event.type === 'error') {
      setItems((current) => [...current, { kind: 'error', id: nextId(), text: event.message }]);
      if (event.code === 'OLLAMA_OFFLINE') void ollama.refresh();
    }
  }, [ollama, patchAssistant]);

  /** Sends one request and streams the answer. Nothing is applied anywhere: the reply is only shown. */
  const run = async (start: (signal: AbortSignal) => Promise<Response>, user: { text: string; task?: TaskName }, textForFallback: string) => {
    setOfflineText('');
    setPhase({ state: 'sending' });
    assistantRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    setItems((current) => [...current, { kind: 'user', id: nextId(), text: user.text, task: user.task }]);
    try {
      const response = await start(controller.signal);
      if (!response.ok) await readApiJson(response); // throws with the server's message and code
      await readEventStream(response, handleEvent);
    } catch (caught) {
      if ((caught as { name?: string }).name !== 'AbortError') {
        const code = (caught as { code?: string }).code;
        setItems((current) => [...current, { kind: 'error', id: nextId(), text: caught instanceof Error ? caught.message : 'The local model request failed' }]);
        if (code === 'OLLAMA_OFFLINE') {
          setOfflineText(textForFallback);
          void ollama.refresh();
        }
      }
    } finally {
      setPhase(null);
      abortRef.current = null;
    }
  };

  const history = (): HistoryItem[] =>
    items.flatMap((item): HistoryItem[] => {
      if (item.kind === 'user' && !item.task) return [{ role: 'user', text: item.text }];
      if (item.kind === 'assistant' && !item.task && item.text) return [{ role: 'assistant', text: item.text }];
      return [];
    });

  const runTask = async (name: TaskName, text: string) => {
    const task = TASKS.find((entry) => entry.name === name)!;
    if (task.needsText && !text) {
      setInput(`/${name} `);
      inputRef.current?.focus();
      setItems((current) => [...current, { kind: 'notice', id: nextId(), text: `${task.label}: ${task.hint}, then press Enter.` }]);
      return;
    }
    const label = text ? `/${name} (${text.length.toLocaleString()} characters)` : `/${name} on ${selectedProject.displayName}`;
    await run((signal) => api.ollama.task(name, { text: text || undefined, projectId: selectedProject.projectId, model: model || undefined, think }, signal), { text: label, task: name }, text);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming || offline) return;
    const parsed = parseSlashCommand(text);
    setInput('');
    if (parsed.kind === 'unknown') {
      setItems((current) => [...current, { kind: 'notice', id: nextId(), text: `Unknown command ${parsed.command}. Available: ${TASKS.map((task) => `/${task.name}`).join(', ')}.` }]);
      return;
    }
    if (parsed.kind === 'task') {
      await runTask(parsed.name, parsed.text);
      return;
    }
    const selected = selectHistory([...history(), { role: 'user', text }], HISTORY_CHARS);
    if (selected.trimmed) setItems((current) => [...current, { kind: 'notice', id: nextId(), text: 'This chat is getting long for the small context window, so the oldest messages are no longer sent. Start a new chat to reset.' }]);
    await run((signal) => api.ollama.chat({ messages: selected.messages, model: model || undefined, think }, signal), { text }, text);
  };

  const stop = () => abortRef.current?.abort();

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    } catch {
      // Clipboard blocked: the text is still selectable on screen.
    }
  };

  /** The user's explicit choice to move to Claude Chat; the message is copied so nothing is lost. */
  const openClaudeChatInstead = async () => {
    const lastUser = [...items].reverse().find((item) => item.kind === 'user' && !item.task);
    const text = offlineText || (lastUser?.kind === 'user' ? lastUser.text : '');
    if (text) await navigator.clipboard.writeText(text).catch(() => undefined);
    onOpenClaudeChat();
  };

  const suggestions = useMemo(() => suggestCommands(input), [input]);

  const dotClass = online ? 'bg-emerald-500' : offline ? 'bg-red-500' : 'bg-muted-foreground/40';
  const statusText = online ? 'Local LLM online' : offline ? 'Local LLM offline' : 'Checking local LLM…';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
          <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
          <span className="font-medium">{statusText}</span>
          {online && <span className="hidden text-xs text-muted-foreground sm:inline">{ollama.numCtx.toLocaleString()}-token context</span>}
        </span>
        <select
          aria-label="Local model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={isStreaming || ollama.models.length === 0}
          className="ml-auto h-8 max-w-56 rounded-lg border border-border bg-background px-2 text-sm"
        >
          {ollama.models.length === 0 && <option value="">{ollama.model || 'No models'}</option>}
          {ollama.models.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}{entry.parameterSize ? ` · ${entry.parameterSize}` : ''}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="The model reasons step by step first. Better for Explain diff, but noticeably slower.">
          <input type="checkbox" checked={think} onChange={(event) => setThink(event.target.checked)} disabled={isStreaming} />
          Thinking (slower)
        </label>
        <Button size="sm" variant="ghost" onClick={() => { setItems([]); setOfflineText(''); }} disabled={isStreaming || items.length === 0} aria-label="Clear chat"><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        {TASKS.map((task) => (
          <Button key={task.name} size="sm" variant="outline" disabled={isStreaming || offline} title={`${task.hint}. Or type /${task.name}`} onClick={() => void runTask(task.name, '')}>
            {task.label}
          </Button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">Draft only: no tools, nothing is written, run or committed from here.</span>
      </div>

      {(offline || offlineText) && (
        <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
          <span className="font-medium">Local LLM offline.</span>
          <span className="text-muted-foreground">The desktop may be asleep or busy with a game.</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void ollama.refresh()}><RefreshCw className="mr-1 h-3.5 w-3.5" />Check again</Button>
            <Button size="sm" variant="outline" onClick={() => void openClaudeChatInstead()} title="Copies your last message and opens Claude Chat. Nothing is sent automatically.">Use Claude Chat instead</Button>
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 && !isStreaming && (
          <div className="mx-auto mt-8 max-w-md text-center text-sm text-muted-foreground">
            <Cpu className="mx-auto mb-2 h-6 w-6" />
            <p>A small model running on your own hardware. Good for quick drafts and summaries; it cannot see your files or run anything.</p>
            <p className="mt-2">Try <code>/commit-msg</code> after staging changes, <code>/explain-diff</code>, or paste logs after <code>/summarise-logs</code>.</p>
            {warm === 'warming' && <p className="mt-3 flex items-center justify-center gap-2 text-xs"><Loader2 className="h-3 w-3 animate-spin" />Warming up the model…</p>}
            {warm === 'ready' && <p className="mt-3 text-xs text-emerald-500">Model loaded and ready.</p>}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {items.map((item) => {
            if (item.kind === 'user') {
              return <div key={item.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">{item.text}</div>;
            }
            if (item.kind === 'notice') {
              return <div key={item.id} role="status" className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{item.text}</div>;
            }
            if (item.kind === 'error') {
              return <div key={item.id} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{item.text}</div>;
            }
            return (
              <div key={item.id} className="max-w-[92%] text-sm">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded border border-border px-1.5 py-0.5 uppercase tracking-wide">Draft</span>
                  {item.task && <span>{TASKS.find((task) => task.name === item.task)?.label}</span>}
                  {item.tokensPerSecond ? <span>{item.tokensPerSecond} tok/s</span> : null}
                  {item.text && (
                    <button type="button" className="ml-auto flex items-center gap-1 hover:text-foreground" onClick={() => void copy(item.id, item.text)} aria-label="Copy draft">
                      {copiedId === item.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copiedId === item.id ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                {item.excluded && item.excluded.length > 0 && (
                  <p className="mb-1 text-[11px] text-muted-foreground">Left out of what was sent: {item.excluded.map((file) => `${file.path} (${file.reason})`).join(', ')}.</p>
                )}
                {item.reasoning && (
                  <details className="mb-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Thinking</summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{item.reasoning}</pre>
                  </details>
                )}
                {item.text && <Markdown>{blockRemoteImages(item.text)}</Markdown>}
              </div>
            );
          })}
          {isStreaming && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase?.state === 'loading' ? (phase.message ?? 'Loading the model into the GPU…') : phase?.state === 'sending' ? 'Sending…' : think ? 'Thinking and writing…' : 'Writing…'} {elapsed}s
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-border/60 px-3 py-3">
        {suggestions.length > 0 && (
          <div className="mx-auto mb-1 flex max-w-3xl flex-wrap gap-2 text-xs text-muted-foreground">
            {suggestions.map((command) => <button key={command} type="button" className="rounded border border-border px-1.5 py-0.5 hover:text-foreground" onClick={() => { setInput(`${command} `); inputRef.current?.focus(); }}>{command}</button>)}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={offline ? 'The local model is offline' : 'Ask the local model, or type / for a shortcut'}
            aria-label="Message"
            className="max-h-40 min-h-12 flex-1 resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          {isStreaming ? (
            <Button onClick={stop} variant="outline" aria-label="Stop"><Square className="h-4 w-4" /></Button>
          ) : (
            <Button onClick={() => void send()} disabled={!input.trim() || offline} aria-label="Send"><Send className="h-4 w-4" /></Button>
          )}
        </div>
      </div>
    </div>
  );
}
