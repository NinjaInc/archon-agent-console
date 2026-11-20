import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Send, ShieldCheck, Square, Trash2, Wrench } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { Project } from '@/shared/types';
import { Markdown } from '@/modules/chat';
import AgyAllowedCommands from '@/modules/agy-chat/AgyAllowedCommands';
import { blockRemoteImages } from '@/modules/agy-chat/utils/blockRemoteImages';

type ChatSummary = { chatId: string; title: string; model: string | null; updatedAt: number };

type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; parameters: unknown; output?: string; running: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string };

type AgyMode = 'plan' | 'accept-edits' | 'auto';

const MODE_LABEL: Record<AgyMode, string> = {
  plan: 'Plan only (changes nothing)',
  'accept-edits': 'Edit files (no shell)',
  auto: 'Full access (runs commands)',
};

type SavedMessage = { id: number; role: string; content: { text?: string; id?: number; name?: string; parameters?: unknown; output?: string } };

type StreamEvent =
  | { type: 'init'; conversationId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: number; name: string; parameters: unknown; state: 'running' | 'done'; output?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'done'; status: string };

function fromSaved(message: SavedMessage): ChatItem | null {
  const id = `saved-${message.id}`;
  const c = message.content;
  if (message.role === 'user') return { kind: 'user', id, text: c.text ?? '' };
  if (message.role === 'assistant') return { kind: 'assistant', id, text: c.text ?? '' };
  if (message.role === 'tool') return { kind: 'tool', id, name: c.name ?? 'tool', parameters: c.parameters, output: c.output, running: false };
  if (message.role === 'error') return { kind: 'error', id, text: c.text ?? '' };
  if (message.role === 'notice') return { kind: 'notice', id, text: c.text ?? '' };
  return null;
}

/** A short one-line description of a tool call's parameters, e.g. the command line or file path. */
function describeParameters(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '';
  const values = Object.values(parameters as Record<string, unknown>).filter((value) => typeof value === 'string') as string[];
  return (values[0] ?? '').slice(0, 120);
}

/** Reads a Server-Sent Events body, calling `onEvent` for each `data:` payload. */
async function readEventStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (data) {
        try {
          onEvent(JSON.parse(data) as StreamEvent);
        } catch {
          // A malformed frame is skipped rather than ending the chat.
        }
      }
      boundary = buffered.indexOf('\n\n');
    }
  }
}

type AgyChatPanelProps = {
  /** The project agy works in; chats are kept per project. */
  selectedProject: Project;
};

/** Rendered by ProjectWorkspace's WorkspaceMain for the Antigravity chat tab; a structured agy chat with history, tool steps, model choice and Stop. */
export default function AgyChatPanel({ selectedProject }: AgyChatPanelProps) {
  const projectId = selectedProject.projectId;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<AgyMode>('accept-edits');
  const [showAllowed, setShowAllowed] = useState(false);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<{ input: number; output: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const counter = useRef(0);
  const nextId = () => `live-${counter.current++}`;

  const loadChats = useCallback(async () => {
    const data = await readApiJson<{ chats: ChatSummary[] }>(await api.agyChat.list(projectId));
    setChats(data.chats);
    return data.chats;
  }, [projectId]);

  const openChat = useCallback(async (id: string | null) => {
    setChatId(id);
    setError(null);
    setTokens(null);
    if (!id) {
      setItems([]);
      return;
    }
    const data = await readApiJson<{ chat: ChatSummary; messages: SavedMessage[] }>(await api.agyChat.get(id));
    setItems(data.messages.map(fromSaved).filter((item): item is ChatItem => item !== null));
    if (data.chat.model) setModel(data.chat.model);
  }, []);

  // Load the project's chats and the model list when the project changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, modelData] = await Promise.all([loadChats(), readApiJson<{ models: string[] }>(await api.agyChat.models())]);
        if (cancelled) return;
        setModels(modelData.models);
        setModel((current) => current || modelData.models.find((entry) => entry.includes('flash-medium')) || modelData.models[0] || '');
        await openChat(list[0]?.chatId ?? null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load Antigravity chats');
      }
    })();
    return () => { cancelled = true; abortRef.current?.abort(); };
  }, [loadChats, openChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const handleEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'text') {
      setItems((current) => {
        const last = current[current.length - 1];
        if (last?.kind === 'assistant' && last.id.startsWith('live-')) return [...current.slice(0, -1), { ...last, text: last.text + event.text }];
        return [...current, { kind: 'assistant', id: nextId(), text: event.text }];
      });
    } else if (event.type === 'tool') {
      setItems((current) => {
        const id = `tool-${event.id}-${current.length}`;
        const existing = current.findIndex((item) => item.kind === 'tool' && item.id.startsWith(`tool-${event.id}-`) && item.running);
        const next: ChatItem = { kind: 'tool', id: existing >= 0 ? current[existing].id : id, name: event.name, parameters: event.parameters, output: event.output, running: event.state === 'running' };
        if (existing >= 0) return current.map((item, index) => (index === existing ? next : item));
        return [...current, next];
      });
    } else if (event.type === 'usage') {
      setTokens((current) => ({ input: (current?.input ?? 0) + event.inputTokens, output: (current?.output ?? 0) + event.outputTokens }));
    } else if (event.type === 'error') {
      setItems((current) => [...current, { kind: 'error', id: nextId(), text: event.message }]);
    } else if (event.type === 'notice') {
      setItems((current) => [...current, { kind: 'notice', id: nextId(), text: event.message }]);
    }
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setError(null);
    setIsStreaming(true);
    setInput('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let id = chatId;
      if (!id) {
        const created = await readApiJson<{ chat: ChatSummary }>(await api.agyChat.create(projectId, model || undefined));
        id = created.chat.chatId;
        setChatId(id);
      }
      setItems((current) => [...current, { kind: 'user', id: nextId(), text }]);
      const response = await api.agyChat.send(id, { text, model: model || undefined, mode }, controller.signal);
      if (!response.ok) await readApiJson(response);
      await readEventStream(response, handleEvent);
    } catch (caught) {
      if ((caught as { name?: string }).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : 'The message could not be sent');
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      // Full access is granted one message at a time and never stays on by itself.
      setMode((current) => (current === 'auto' ? 'accept-edits' : current));
      void loadChats().catch(() => undefined);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    if (chatId) void api.agyChat.stop(chatId).catch(() => undefined);
  };

  const newChat = async () => {
    abortRef.current?.abort();
    await openChat(null);
  };

  const deleteChat = async () => {
    if (!chatId || !window.confirm('Delete this chat? This only removes it from the console.')) return;
    await api.agyChat.remove(chatId).catch(() => undefined);
    const list = await loadChats().catch(() => [] as ChatSummary[]);
    await openChat(list[0]?.chatId ?? null);
  };

  // Live progress: seconds since the message was sent, and tool steps since the last user message.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isStreaming) return undefined;
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);
  const stepsThisTurn = useMemo(() => {
    const lastUser = items.map((item) => item.kind).lastIndexOf('user');
    return items.slice(lastUser + 1).filter((item) => item.kind === 'tool').length;
  }, [items]);

  const currentTitle = useMemo(() => chats.find((chat) => chat.chatId === chatId)?.title, [chats, chatId]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <select
          aria-label="Chat"
          value={chatId ?? ''}
          onChange={(event) => void openChat(event.target.value || null)}
          disabled={isStreaming}
          className="h-8 max-w-[16rem] rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">New chat</option>
          {chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.title}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => void newChat()} disabled={isStreaming} aria-label="New chat"><Plus className="h-3.5 w-3.5" /></Button>
        {chatId && <Button size="sm" variant="ghost" onClick={() => void deleteChat()} disabled={isStreaming} aria-label="Delete chat"><Trash2 className="h-3.5 w-3.5" /></Button>}
        <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} disabled={isStreaming} className="ml-auto h-8 max-w-[14rem] rounded-lg border border-border bg-background px-2 text-sm">
          {models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <select
          aria-label="What Antigravity may do"
          value={mode}
          onChange={(event) => setMode(event.target.value as AgyMode)}
          disabled={isStreaming}
          className={`h-8 max-w-[18rem] rounded-lg border bg-background px-2 text-xs ${mode === 'auto' ? 'border-amber-500 text-amber-500' : 'border-border'}`}
          title="Antigravity run from here has no one to ask, so what it may do is decided before each message."
        >
          {(Object.keys(MODE_LABEL) as AgyMode[]).map((entry) => <option key={entry} value={entry}>{MODE_LABEL[entry]}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => setShowAllowed((open) => !open)} aria-expanded={showAllowed} title="Commands Antigravity may run without asking"><ShieldCheck className="mr-1 h-3.5 w-3.5" />Allowed commands</Button>
      </div>

      {showAllowed && <AgyAllowedCommands onClose={() => setShowAllowed(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 && !isStreaming && (
          <p className="mx-auto mt-10 max-w-md text-center text-sm text-muted-foreground">
            Ask Antigravity about <strong>{selectedProject.displayName}</strong>. It works in <code>{selectedProject.fullPath}</code>.
            {mode === 'accept-edits' && ' It reads and edits files with its built-in tools. Shell commands are off (only exact commands on your Allowed commands list run).'}
            {mode === 'plan' && ' It will research and write a plan without changing anything.'}
            {mode === 'auto' && ' Full access: it can run any command and edit any file as the server user, for this message.'}
          </p>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {items.map((item) => {
            if (item.kind === 'user') {
              return <div key={item.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">{item.text}</div>;
            }
            if (item.kind === 'assistant') {
              return <div key={item.id} className="max-w-[92%] text-sm"><Markdown>{blockRemoteImages(item.text)}</Markdown></div>;
            }
            if (item.kind === 'notice') {
              return <div key={item.id} role="status" className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{item.text}</div>;
            }
            if (item.kind === 'error') {
              if (/auto-denied/.test(item.text)) {
                return (
                  <div key={item.id} role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
                    Antigravity wanted to run a command that is not on your allowed list, so it was blocked.{' '}
                    <button type="button" className="underline" onClick={() => setShowAllowed(true)}>Allowed commands</button>
                    {' '}lets you permit specific ones, or pick Full access for one message.
                  </div>
                );
              }
              return <div key={item.id} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{item.text}</div>;
            }
            return (
              <details key={item.id} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
                <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                  {item.running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                  <span className="font-medium text-foreground">{item.name}</span>
                  <span className="truncate font-mono">{describeParameters(item.parameters)}</span>
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{item.output ?? (item.running ? 'Running…' : '(no output)')}</pre>
              </details>
            );
          })}
          {isStreaming && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Antigravity is working… {stepsThisTurn > 0 ? `${stepsThisTurn} step${stepsThisTurn === 1 ? '' : 's'} · ` : ''}{elapsedSeconds}s
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {error && <div role="alert" className="mx-4 mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <div className="border-t border-border/60 px-3 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={currentTitle ? 'Reply to Antigravity…' : 'Message Antigravity…'}
            aria-label="Message"
            className="max-h-40 min-h-[3rem] flex-1 resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          {isStreaming ? (
            <Button onClick={stop} variant="outline" aria-label="Stop"><Square className="h-4 w-4" /></Button>
          ) : (
            <Button onClick={() => void send()} disabled={!input.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
          )}
        </div>
        {tokens && <p className="mx-auto mt-1 max-w-3xl text-[10px] text-muted-foreground/60">{tokens.input.toLocaleString()} in · {tokens.output.toLocaleString()} out tokens this reply</p>}
      </div>
    </div>
  );
}
