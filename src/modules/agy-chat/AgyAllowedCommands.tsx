import { useCallback, useEffect, useState } from 'react';
import { Plus, ShieldCheck, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';

type AllowedCommandsState = { commands: string[]; otherRules: number };

const PRESETS = ['git status', 'git diff', 'git log', 'npm test', 'npm run build', 'npm run lint', 'ls -la'];

/** Plain words only, mirroring what the server accepts: one exact command line, no shell syntax or wildcards. */
const COMMAND_LINE = /^[A-Za-z0-9._/:=@,+-]+( [A-Za-z0-9._/:=@,+-]+)*$/;

/** Used by AgyChatPanel (same module) to edit the commands Antigravity may run without asking in the safer chat modes. */
export default function AgyAllowedCommands({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<AllowedCommandsState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await readApiJson<AllowedCommandsState>(await api.agyPermissions.get()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the allowed commands');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (commands: string[]) => {
    setIsSaving(true);
    setError(null);
    try {
      setState(await readApiJson<AllowedCommandsState>(await api.agyPermissions.set(commands)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setIsSaving(false);
    }
  };

  const add = async (line: string) => {
    const command = line.trim();
    if (!command || !state) return;
    if (!COMMAND_LINE.test(command)) {
      setError('Plain words only: no quotes, pipes, ; & > < $ ` ( ) or wildcards. Each rule allows exactly that one command.');
      return;
    }
    setDraft('');
    await save([...state.commands.filter((existing) => existing !== command), command]);
  };

  return (
    <div role="dialog" aria-label="Allowed commands" className="border-b border-border/60 bg-muted/30 px-4 py-3 text-sm">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
          <div className="flex-1">
            <p className="font-medium text-foreground">Commands Antigravity may run without asking</p>
            <p className="text-xs text-muted-foreground">
              Used in <em>Edit files</em> mode, where any other command is blocked. Each entry allows that exact command line only (for example <code>npm test</code>); it is saved in agy&apos;s settings, so it also applies to the Antigravity terminal tab.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        <ul className="flex flex-wrap gap-1.5">
          {state?.commands.length === 0 && <li className="text-xs text-muted-foreground">Nothing is allowed yet.</li>}
          {state?.commands.map((command) => (
            <li key={command} className="inline-flex items-center gap-1 rounded-full border border-border bg-background py-0.5 pl-2.5 pr-1 font-mono text-xs">
              {command}
              <button type="button" aria-label={`Remove ${command}`} disabled={isSaving} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => void save(state.commands.filter((existing) => existing !== command))}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>

        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void add(draft); }}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. npm run build" aria-label="Command to allow" className="h-9 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary" />
          <Button type="submit" size="sm" disabled={!draft.trim() || isSaving}><Plus className="mr-1 h-3.5 w-3.5" />Allow</Button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Quick add:
          {PRESETS.filter((preset) => !state?.commands.includes(preset)).map((preset) => (
            <button key={preset} type="button" disabled={isSaving || !state} onClick={() => void add(preset)} className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono hover:text-foreground">{preset}</button>
          ))}
        </div>
        {state && state.otherRules > 0 && <p className="text-xs text-muted-foreground">{state.otherRules} other rule(s) in agy&apos;s settings are kept untouched.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
