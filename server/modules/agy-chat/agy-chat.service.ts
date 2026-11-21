import { randomUUID } from 'node:crypto';

import { AppError } from '@/shared/utils.js';

export type AgyChat = {
  chatId: string;
  projectPath: string;
  title: string;
  model: string | null;
  agyConversationId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** A normalised event streamed to the browser for one agy turn. */
export type AgyChatEvent =
  | { type: 'init'; conversationId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: number; name: string; parameters: unknown; state: 'running' | 'done'; output?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'done'; status: string };

export type AgyProcess = {
  stdout: AsyncIterable<string | Buffer>;
  /** Resolves with the exit code once the process ends. */
  exited: Promise<number | null>;
  stderrText: () => string;
  kill: () => void;
};

type StoredChatRow = { chat_id: string; project_path: string; title: string; model: string | null; agy_conversation_id: string | null; created_at: number; updated_at: number };
type StoredMessageRow = { message_id: number; role: string; content: string; created_at: number };

export type AgyChatDependencies = {
  store: {
    insertChat(row: StoredChatRow): void;
    getChat(chatId: string): StoredChatRow | undefined;
    listChats(projectPath: string): StoredChatRow[];
    updateChat(chatId: string, fields: Partial<Pick<StoredChatRow, 'title' | 'model' | 'agy_conversation_id' | 'updated_at'>>): void;
    deleteChat(chatId: string): boolean;
    insertMessage(chatId: string, role: string, content: string, createdAt: number): void;
    listMessages(chatId: string): StoredMessageRow[];
  };
  /** The real folder of a registered project inside the allowed roots, or null. */
  resolveProjectDir: (projectId: string) => Promise<string | null>;
  /** Starts `agy -p <text> --output-format stream-json …` in `cwd`; no shell is involved. */
  spawnAgy: (args: string[], cwd: string) => AgyProcess | Promise<AgyProcess>;
  /** Whether the full-access mode may be used at all (server-side kill switch). */
  allowFullAccess?: boolean;
  /** Called when a full-access turn starts, so it can be logged (never receives message text). */
  audit?: (message: string) => void;
  now?: () => number;
  newId?: () => string;
};

const MAX_MESSAGE_CHARS = 20_000;
const MAX_RUNNING_TURNS = 4;
const MAX_BUFFERED_LINE = 1_000_000;
const MAX_SAVED_TEXT = 200_000;
const MAX_SAVED_PARAMETERS = 4_000;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** What agy may do in a turn. Always passed explicitly: with no --mode agy runs commands and edits anywhere as this user. */
export const AGY_MODES = ['plan', 'accept-edits', 'auto'] as const;
export type AgyMode = (typeof AGY_MODES)[number];
const DEFAULT_MODE: AgyMode = 'accept-edits';

/**
 * Without full access agy cannot run shell commands (a denied command ends the turn). Its first instinct is always
 * `find`/`ls`, so tell it up front to use its built-in file tools; with this note it explores and answers normally.
 * Sent to agy only: the saved user message stays exactly what was typed.
 */
const NO_SHELL_NOTE = '[Console note: shell commands are switched off in this chat and any run_command call will be refused. Explore with your file tools instead (list_dir, find_by_name, grep_search, view_file) and answer from what they return.]\n\n';

/** Keeps what a chat stores bounded; a file-writing tool call can carry a whole file. */
function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
}
function clipParameters(parameters: unknown): unknown {
  const text = JSON.stringify(parameters ?? null);
  return text.length > MAX_SAVED_PARAMETERS ? { truncated: clip(text, MAX_SAVED_PARAMETERS) } : parameters;
}
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHAT_ID = /^[0-9a-f-]{36}$/;
const TOOL_OUTPUT_LIMIT = 4_000;

function toChat(row: StoredChatRow): AgyChat {
  return { chatId: row.chat_id, projectPath: row.project_path, title: row.title, model: row.model, agyConversationId: row.agy_conversation_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Antigravity chat: one agy process per message, resumed with --conversation, streamed as normalised events. */
export function createAgyChatService(dependencies: AgyChatDependencies) {
  const now = dependencies.now ?? Date.now;
  const newId = dependencies.newId ?? randomUUID;
  const running = new Map<string, () => void>();

  function requireChat(chatId: unknown): StoredChatRow {
    if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new AppError('Invalid chat id', { code: 'AGY_CHAT_INVALID', statusCode: 400 });
    const row = dependencies.store.getChat(chatId);
    if (!row) throw new AppError('Chat not found', { code: 'AGY_CHAT_NOT_FOUND', statusCode: 404 });
    return row;
  }

  function readModel(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !MODEL_ID.test(value)) throw new AppError('Invalid model', { code: 'AGY_MODEL_INVALID', statusCode: 400 });
    return value;
  }

  /** Maps one agy stream-json line to zero or more browser events; `state` carries the per-turn bookkeeping. */
  function translate(line: unknown, state: TurnState): AgyChatEvent[] {
    const event = line as { event?: string; init?: { conversation_id?: string; model?: string }; step_update?: Record<string, unknown>; result?: Record<string, unknown> };
    if (event.event === 'init') {
      const rawConversationId = String((event as { conversation_id?: string }).conversation_id ?? '');
      // Only a well-formed id is ever stored and passed back to agy on the next turn.
      const conversationId = CONVERSATION_ID.test(rawConversationId) ? rawConversationId : '';
      state.conversationId = conversationId;
      return [{ type: 'init', conversationId, model: String(event.init?.model ?? '') }];
    }
    if (event.event === 'step_update' && event.step_update) {
      const step = event.step_update;
      const index = Number(step.step_index);
      if (step.step_type === 'agent_response') {
        const events: AgyChatEvent[] = [];
        if (typeof step.text_delta === 'string' && step.text_delta) {
          const last = state.parts[state.parts.length - 1];
          if (last?.kind === 'text') last.text = clip(last.text + step.text_delta, MAX_SAVED_TEXT);
          else state.parts.push({ kind: 'text', text: step.text_delta });
          events.push({ type: 'text', text: step.text_delta });
        }
        const usage = step.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) events.push({ type: 'usage', inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) });
        return events;
      }
      if (step.step_type === 'tool') {
        const info = (step.tool_info ?? {}) as { name?: string; parameters?: unknown; output?: unknown };
        const name = String(step.tool_name ?? info.name ?? 'tool');
        const done = step.state === 'DONE';
        const output = done && typeof info.output === 'string' ? info.output.slice(0, TOOL_OUTPUT_LIMIT) : undefined;
        if (done) state.parts.push({ kind: 'tool', id: index, name, parameters: clipParameters(info.parameters), output });
        return [{ type: 'tool', id: index, name, parameters: info.parameters, state: done ? 'done' : 'running', output }];
      }
    }
    if (event.event === 'result') {
      const result = (event.result ?? {}) as { status?: string; response?: unknown };
      state.status = String(result.status ?? 'SUCCESS');
      // Some turns carry the answer only here, not as streamed text.
      if (typeof result.response === 'string') state.resultText = result.response;
    }
    return [];
  }

  /** What the turn produced, in the order it happened, so a saved chat reads like the live one. */
  type TurnPart = { kind: 'text'; text: string } | { kind: 'tool'; id: number; name: string; parameters: unknown; output?: string };
  type TurnState = { conversationId: string; parts: TurnPart[]; status: string; resultText: string };

  return {
    async createChat(input: { projectId: unknown; model?: unknown }): Promise<AgyChat> {
      if (typeof input.projectId !== 'string' || !input.projectId) throw new AppError('projectId is required', { code: 'AGY_PROJECT_REQUIRED', statusCode: 400 });
      const projectPath = await dependencies.resolveProjectDir(input.projectId);
      if (!projectPath) throw new AppError('That project is not available', { code: 'AGY_PROJECT_UNKNOWN', statusCode: 400 });
      const stamp = now();
      const row: StoredChatRow = { chat_id: newId(), project_path: projectPath, title: 'New chat', model: readModel(input.model), agy_conversation_id: null, created_at: stamp, updated_at: stamp };
      dependencies.store.insertChat(row);
      return toChat(row);
    },

    async listChats(projectId: unknown): Promise<AgyChat[]> {
      if (typeof projectId !== 'string' || !projectId) throw new AppError('projectId is required', { code: 'AGY_PROJECT_REQUIRED', statusCode: 400 });
      const projectPath = await dependencies.resolveProjectDir(projectId);
      return projectPath ? dependencies.store.listChats(projectPath).map(toChat) : [];
    },

    getChat(chatId: unknown) {
      const row = requireChat(chatId);
      return {
        chat: toChat(row),
        messages: dependencies.store.listMessages(row.chat_id).map((message) => ({ id: message.message_id, role: message.role, content: JSON.parse(message.content) as unknown, createdAt: message.created_at })),
        running: running.has(row.chat_id),
      };
    },

    deleteChat(chatId: unknown): { deleted: boolean } {
      const row = requireChat(chatId);
      running.get(row.chat_id)?.();
      return { deleted: dependencies.store.deleteChat(row.chat_id) };
    },

    /** Stops the running turn of a chat, if any. */
    stop(chatId: unknown): { stopped: boolean } {
      const row = requireChat(chatId);
      const cancel = running.get(row.chat_id);
      cancel?.();
      return { stopped: Boolean(cancel) };
    },

    /**
     * Runs one turn. Events go to `emit` as they arrive; the returned promise settles when the turn ends.
     * `signal` aborts it (the browser closed the stream).
     */
    async sendMessage(
      chatId: unknown,
      input: { text: unknown; model?: unknown; mode?: unknown },
      emit: (event: AgyChatEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const row = requireChat(chatId);
      if (typeof input.text !== 'string' || !input.text.trim()) throw new AppError('A message is required', { code: 'AGY_MESSAGE_REQUIRED', statusCode: 400 });
      if (input.text.length > MAX_MESSAGE_CHARS) throw new AppError('That message is too long', { code: 'AGY_MESSAGE_TOO_LONG', statusCode: 400 });
      if (running.has(row.chat_id)) throw new AppError('This chat is already answering', { code: 'AGY_CHAT_BUSY', statusCode: 409 });
      if (running.size >= MAX_RUNNING_TURNS) throw new AppError('Too many Antigravity turns are running; wait for one to finish', { code: 'AGY_TOO_MANY', statusCode: 429 });
      const mode = input.mode === undefined || input.mode === null || input.mode === '' ? DEFAULT_MODE : input.mode;
      if (!AGY_MODES.includes(mode as AgyMode)) throw new AppError('Invalid mode', { code: 'AGY_MODE_INVALID', statusCode: 400 });
      const model = readModel(input.model) ?? row.model;
      const text = input.text.trim();
      // Full access (agy runs any command as this user) is an explicit per-message choice and can be switched off server-side.
      if (mode === 'auto' && dependencies.allowFullAccess === false) throw new AppError('Full access is turned off on this server', { code: 'AGY_FULL_ACCESS_DISABLED', statusCode: 403 });

      // -p=<text> attaches the prompt to the flag, so text starting with dashes can never be read as an option.
      const prompt = mode === 'auto' ? text : `${NO_SHELL_NOTE}${text}`;
      const args = [`-p=${prompt}`, '--output-format', 'stream-json'];
      if (row.agy_conversation_id && CONVERSATION_ID.test(row.agy_conversation_id)) args.push('--conversation', row.agy_conversation_id);
      if (model) args.push('--model', model);
      // plan: researches and writes a plan, changes nothing in the project. accept-edits: may edit files; commands
      // are denied unless allowed in agy's permissions.allow. auto: edits and runs anything as this user.
      args.push('--mode', mode as string);
      if (mode === 'auto') dependencies.audit?.(`full-access turn started (chat ${row.chat_id.slice(0, 8)})`);

      dependencies.store.insertMessage(row.chat_id, 'user', JSON.stringify({ text }), now());
      if (row.title === 'New chat') dependencies.store.updateChat(row.chat_id, { title: text.replace(/\s+/g, ' ').slice(0, 60) });

      // Claim the chat before the (async) spawn so a second message cannot slip in meanwhile.
      let cancelled = false;
      let child: AgyProcess | null = null;
      const cancel = () => { cancelled = true; child?.kill(); };
      running.set(row.chat_id, cancel);
      try {
        child = await dependencies.spawnAgy(args, row.project_path);
      } catch (error) {
        running.delete(row.chat_id);
        throw error;
      }
      if (cancelled) child.kill();
      signal?.addEventListener('abort', cancel, { once: true });

      const state: TurnState = { conversationId: row.agy_conversation_id ?? '', parts: [], status: 'SUCCESS', resultText: '' };
      let buffered = '';
      const handleLine = (raw: string) => {
        if (!raw.trim()) return;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; }
        for (const event of translate(parsed, state)) emit(event);
      };

      try {
        for await (const chunk of child.stdout) {
          buffered += chunk.toString();
          if (buffered.length > MAX_BUFFERED_LINE && !buffered.includes('\n')) buffered = ''; // a runaway line is dropped, not accumulated
          let newline = buffered.indexOf('\n');
          while (newline >= 0) {
            handleLine(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf('\n');
          }
        }
        handleLine(buffered);
        const code = await child.exited;
        const finished = child;

        // Never end a turn silently: use the closing result text when nothing was streamed, else say so.
        const wroteText = state.parts.some((part) => part.kind === 'text' && part.text.trim());
        if (!wroteText && state.resultText.trim() && !cancelled) {
          state.parts.push({ kind: 'text', text: state.resultText });
          emit({ type: 'text', text: state.resultText });
        } else if (!wroteText && !cancelled && code === 0 && !/auto-denied/.test(finished.stderrText())) {
          const steps = state.parts.filter((part) => part.kind === 'tool').length;
          const message = steps > 0
            ? `Antigravity ran ${steps} step${steps === 1 ? '' : 's'} but wrote no reply. Ask it to summarise what it found.`
            : 'Antigravity finished without a reply. In "Edit files" mode it cannot run commands; try "Full access" or ask differently.';
          dependencies.store.insertMessage(row.chat_id, 'notice', JSON.stringify({ text: message }), now());
          emit({ type: 'notice', message });
        }
        for (const part of state.parts) {
          if (part.kind === 'text') dependencies.store.insertMessage(row.chat_id, 'assistant', JSON.stringify({ text: clip(part.text, MAX_SAVED_TEXT) }), now());
          else dependencies.store.insertMessage(row.chat_id, 'tool', JSON.stringify({ id: part.id, name: part.name, parameters: part.parameters, output: part.output }), now());
        }
        if (CONVERSATION_ID.test(state.conversationId) && state.conversationId !== row.agy_conversation_id) {
          dependencies.store.updateChat(row.chat_id, { agy_conversation_id: state.conversationId });
        }
        dependencies.store.updateChat(row.chat_id, { updated_at: now(), ...(model ? { model } : {}) });

        if (cancelled) {
          emit({ type: 'done', status: 'STOPPED' });
        } else if (code === 0 && /auto-denied/.test(finished.stderrText())) {
          // agy exits normally (and even marks the tool step done) when a tool needed a permission it cannot ask
          // for; its stderr is the only signal, so surface it instead of leaving an empty reply.
          const hint = finished.stderrText().split('\n').find((line) => line.includes('auto-denied'))?.replace(/^jetski:\s*/, '').slice(0, 300) ?? 'A tool needed permission.';
          dependencies.store.insertMessage(row.chat_id, 'error', JSON.stringify({ text: hint }), now());
          emit({ type: 'error', message: hint });
          emit({ type: 'done', status: 'DENIED' });
        } else if (code !== 0) {
          const detail = finished.stderrText().split('\n').find((line) => line.trim())?.slice(0, 300) ?? `agy exited with code ${code}`;
          dependencies.store.insertMessage(row.chat_id, 'error', JSON.stringify({ text: detail }), now());
          emit({ type: 'error', message: detail });
          emit({ type: 'done', status: 'ERROR' });
        } else {
          emit({ type: 'done', status: state.status });
        }
      } finally {
        running.delete(row.chat_id);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

/** What a finished turn is worth telling the user about on their phone, or null when it is not. */
export type TurnNotification = { kind: 'stop'; reason: string } | { kind: 'error'; message: string };

/**
 * Decides whether a finished Agy Chat turn should send a push notification, and what it says.
 * Quick replies stay quiet (you are looking at the screen), and a turn you stopped yourself never notifies.
 */
export function summariseTurnForNotification(turn: { status: string; seconds: number; steps: number; error?: string; minSeconds: number }): TurnNotification | null {
  if (turn.status === 'STOPPED') return null;
  if (turn.status === 'ERROR' || turn.error) {
    return { kind: 'error', message: turn.error?.slice(0, 160) || 'Antigravity stopped with an error' };
  }
  if (turn.seconds < turn.minSeconds) return null;
  if (turn.status === 'DENIED') return { kind: 'stop', reason: 'Blocked: a command needed permission' };
  const minutes = Math.floor(turn.seconds / 60);
  const duration = minutes > 0 ? `${minutes}m ${Math.round(turn.seconds % 60)}s` : `${Math.round(turn.seconds)}s`;
  const steps = turn.steps > 0 ? `${turn.steps} step${turn.steps === 1 ? '' : 's'}, ` : '';
  return { kind: 'stop', reason: `Reply ready (${steps}${duration})` };
}
