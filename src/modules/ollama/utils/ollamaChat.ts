export const TASKS = [
  { name: 'summarise-logs', label: 'Summarise logs', needsText: true, hint: 'Paste log output after the command' },
  { name: 'explain-diff', label: 'Explain diff', needsText: false, hint: 'Explains the git changes in this project (or a diff you paste)' },
  { name: 'commit-msg', label: 'Commit message', needsText: false, hint: 'Drafts a message from the staged changes in this project' },
  { name: 'boilerplate', label: 'Boilerplate', needsText: true, hint: 'Describe the file you want a stub for' },
] as const;

export type TaskName = (typeof TASKS)[number]['name'];

export type OllamaStreamEvent =
  | { type: 'meta'; task?: string; included?: string[]; excluded?: Array<{ path: string; reason: string }>; draft: true }
  | { type: 'status'; state: 'loading' | 'generating'; message?: string }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; tokensPerSecond?: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

/** "/commit-msg", "/summarise-logs <pasted text>" -> the task and the text after it. Anything else is plain chat. */
export function parseSlashCommand(input: string): { kind: 'task'; name: TaskName; text: string } | { kind: 'unknown'; command: string } | { kind: 'chat' } {
  const match = input.trimStart().match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return { kind: 'chat' };
  const name = match[1].toLowerCase();
  const task = TASKS.find((entry) => entry.name === name);
  if (!task) return { kind: 'unknown', command: `/${name}` };
  return { kind: 'task', name: task.name, text: (match[2] ?? '').trim() };
}

/** Slash commands that start with what has been typed so far, for the suggestion line. */
export function suggestCommands(input: string): string[] {
  const match = input.match(/^\/([a-z-]*)$/i);
  if (!match) return [];
  return TASKS.filter((task) => task.name.startsWith(match[1].toLowerCase())).map((task) => `/${task.name}`);
}

export type HistoryItem = { role: 'user' | 'assistant'; text: string };

/**
 * The most recent messages that fit `maxChars`, always ending with the newest. Older turns fall off first so a long
 * chat keeps working inside the small context window; `trimmed` tells the UI to say so.
 */
export function selectHistory(items: HistoryItem[], maxChars: number): { messages: Array<{ role: 'user' | 'assistant'; content: string }>; trimmed: boolean } {
  const kept: HistoryItem[] = [];
  let total = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const length = items[index].text.length;
    if (kept.length > 0 && total + length > maxChars) break;
    kept.unshift(items[index]);
    total += length;
  }
  // The conversation must start with a user turn.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return { messages: kept.map((item) => ({ role: item.role, content: item.text })), trimmed: kept.length < items.length };
}

/** Reads a Server-Sent Events body, handing each `data:` payload to `onEvent` as it arrives (nothing is held back). */
export async function readEventStream(response: Response, onEvent: (event: OllamaStreamEvent) => void): Promise<void> {
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
          onEvent(JSON.parse(data) as OllamaStreamEvent);
        } catch {
          // A malformed frame is skipped rather than ending the reply.
        }
      }
      boundary = buffered.indexOf('\n\n');
    }
  }
}
