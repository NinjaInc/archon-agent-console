import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, FileArchive, FolderUp, Loader2, Trash2, Upload } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { Project } from '@/shared/types';

type Target = 'claude' | 'agy';
type Scope = 'user' | 'project';

type InstalledSkill = { name: string; description: string; target: Target; scope: Scope; path: string };
type SkillFile = { path: string; content: string; encoding?: 'base64' };
type Preview = { name: string; description: string; files: { path: string; bytes: number }[]; totalBytes: number; warnings: string[] };

const TARGET_LABEL: Record<Target, string> = { claude: 'Claude Code', agy: 'Antigravity' };
const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']);
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const isBinaryPath = (filePath: string) => BINARY_EXTENSIONS.has(filePath.split('.').pop()?.toLowerCase() ?? '');
/** Hidden files and macOS zip metadata are never part of a skill. */
const isIgnoredPath = (filePath: string) => filePath.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX');

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function readUploadedFiles(list: File[]): Promise<{ files: SkillFile[]; skipped: number }> {
  const files: SkillFile[] = [];
  let skipped = 0;
  let total = 0;
  for (const file of list) {
    const filePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (isIgnoredPath(filePath)) { skipped += 1; continue; }
    total += file.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error('That is more than a skill can be (2 MB)');
    files.push(isBinaryPath(filePath) ? { path: filePath, content: await toBase64(file), encoding: 'base64' } : { path: filePath, content: await file.text() });
  }
  return { files, skipped };
}

async function readZip(file: File): Promise<{ files: SkillFile[]; skipped: number }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That zip is larger than a skill can be (2 MB)');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const files: SkillFile[] = [];
  let skipped = 0;
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (isIgnoredPath(entry.name)) { skipped += 1; continue; }
    const binary = isBinaryPath(entry.name);
    const content = await entry.async(binary ? 'base64' : 'string');
    total += content.length;
    // Checked while unpacking, so a zip bomb stops here rather than filling memory.
    if (total > MAX_UPLOAD_BYTES * 1.4) throw new Error('That zip unpacks to more than a skill can be (2 MB)');
    files.push(binary ? { path: entry.name, content, encoding: 'base64' } : { path: entry.name, content });
  }
  return { files, skipped };
}

type SkillsImportPanelProps = {
  /** The project a "this project only" skill is installed into. */
  selectedProject: Project | null;
};

/** Rendered by ProjectWorkspace's WorkspaceMain for the sidebar "Skills" tool; imports skills (a SKILL.md, a folder or a zip) for Claude Code and Antigravity and lists installed ones. */
export default function SkillsImportPanel({ selectedProject }: SkillsImportPanelProps) {
  const [pasted, setPasted] = useState('');
  const [uploaded, setUploaded] = useState<{ files: SkillFile[]; label: string; skipped: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<Target, boolean>>({ claude: true, agy: true });
  const [scope, setScope] = useState<Scope>('user');
  const [overwrite, setOverwrite] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const files = useMemo<SkillFile[]>(() => (uploaded ? uploaded.files : pasted.trim() ? [{ path: 'SKILL.md', content: pasted }] : []), [uploaded, pasted]);
  const chosenTargets = (Object.keys(targets) as Target[]).filter((target) => targets[target]);
  const projectId = selectedProject?.projectId;

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled((await readApiJson<{ skills: InstalledSkill[] }>(await api.skillsImport.list(projectId))).skills);
    } catch (caught) {
      setMessage({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not list skills' });
    }
  }, [projectId]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  // The server validates and describes the skill; nothing is written until Import.
  useEffect(() => {
    setTrusted(false);
    if (files.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await readApiJson<Preview>(await api.skillsImport.preview({ files }));
        if (!cancelled) { setPreview(result); setPreviewError(null); }
      } catch (caught) {
        if (!cancelled) { setPreview(null); setPreviewError(caught instanceof Error ? caught.message : 'Not a valid skill'); }
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [files]);

  const importSkill = async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const result = await readApiJson<{ name: string; files: number }>(
        await api.skillsImport.import({ files, targets: chosenTargets, scope, projectId: scope === 'project' ? projectId : undefined, overwrite, acknowledgeRisk: trusted }),
      );
      setMessage({ kind: 'ok', text: `Installed "${result.name}" (${result.files} file${result.files === 1 ? '' : 's'}) for ${chosenTargets.map((target) => TARGET_LABEL[target]).join(' and ')}.` });
      setPasted('');
      setUploaded(null);
      setOverwrite(false);
      await loadInstalled();
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : 'Import failed';
      setMessage({ kind: 'error', text: /already installed/i.test(text) ? `${text}. Tick "Replace if it already exists" to overwrite it.` : text });
    } finally {
      setIsBusy(false);
    }
  };

  const removeSkill = async (skill: InstalledSkill) => {
    if (!window.confirm(`Remove the "${skill.name}" skill from ${TARGET_LABEL[skill.target]} (${skill.scope === 'user' ? 'all projects' : 'this project'})? Its folder is deleted.`)) return;
    setMessage(null);
    try {
      await readApiJson(await api.skillsImport.remove({ target: skill.target, scope: skill.scope, name: skill.name, projectId: skill.scope === 'project' ? projectId : undefined }));
      await loadInstalled();
    } catch (caught) {
      setMessage({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not remove the skill' });
    }
  };

  const onPick = async (kind: 'file' | 'folder' | 'zip', list: FileList | null) => {
    if (!list || list.length === 0) return;
    setMessage(null);
    try {
      if (kind === 'zip') {
        const result = await readZip(list[0]);
        setUploaded({ ...result, label: list[0].name });
      } else {
        const result = await readUploadedFiles([...list]);
        setUploaded({ ...result, label: kind === 'folder' ? `folder (${result.files.length} files)` : list[0].name });
      }
      setPasted('');
    } catch (caught) {
      setUploaded(null);
      setMessage({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not read that' });
    }
  };

  const needsTrust = Boolean(preview && preview.warnings.length > 0);
  const canImport = Boolean(preview) && chosenTargets.length > 0 && (scope === 'user' || Boolean(projectId)) && (!needsTrust || trusted) && !isBusy;
  const pickerClass = 'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        <div className="flex items-center gap-3">
          <BookOpen className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Skills</h2>
            <p className="text-xs text-muted-foreground">
              Import a skill (a SKILL.md, a folder or a zip) so Claude Code and Antigravity can use it. A skill is a set of instructions an agent follows, so only import ones you trust.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="skill-text" className="text-sm font-medium text-foreground">SKILL.md</label>
            <div className="flex flex-wrap gap-2">
              <label className={pickerClass}><Upload className="h-3.5 w-3.5" /> File
                <input type="file" accept=".md,text/markdown,text/plain" className="hidden" onChange={(event) => { void onPick('file', event.target.files); event.target.value = ''; }} />
              </label>
              <label className={pickerClass}><FolderUp className="h-3.5 w-3.5" /> Folder
                <input type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={(event) => { void onPick('folder', event.target.files); event.target.value = ''; }} />
              </label>
              <label className={pickerClass}><FileArchive className="h-3.5 w-3.5" /> Zip
                <input type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => { void onPick('zip', event.target.files); event.target.value = ''; }} />
              </label>
            </div>
          </div>
          {uploaded ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <span>Loaded <strong>{uploaded.label}</strong>{uploaded.skipped > 0 && <span className="text-xs text-muted-foreground"> · {uploaded.skipped} hidden/system file(s) skipped</span>}</span>
              <Button size="sm" variant="ghost" onClick={() => setUploaded(null)}>Clear</Button>
            </div>
          ) : (
            <textarea
              id="skill-text"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              spellCheck={false}
              placeholder={'---\nname: my-skill\ndescription: What it does and when to use it\n---\n\n# My skill\n...'}
              className="h-48 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
            />
          )}
          {previewError && files.length > 0 && <p role="alert" className="text-xs text-destructive">{previewError}</p>}
          {preview && (
            <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
              <p className="text-sm text-foreground"><code className="rounded bg-muted px-1.5 py-0.5">{preview.name}</code> — {preview.description}</p>
              <p className="mt-1 text-muted-foreground">{preview.files.length} file{preview.files.length === 1 ? '' : 's'}, {(preview.totalBytes / 1024).toFixed(1)} KB{preview.files.length > 1 && `: ${preview.files.slice(0, 8).map((file) => file.path).join(', ')}${preview.files.length > 8 ? ', …' : ''}`}</p>
              {needsTrust && (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-foreground">
                  <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> This skill can make an agent run commands</p>
                  <ul className="ml-5 mt-1 list-disc">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                  <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} /> I have read this skill and trust where it came from</label>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="mb-1 font-medium text-foreground">Install for</legend>
            {(Object.keys(TARGET_LABEL) as Target[]).map((target) => (
              <label key={target} className="flex items-center gap-2">
                <input type="checkbox" checked={targets[target]} onChange={(event) => setTargets((current) => ({ ...current, [target]: event.target.checked }))} />
                {TARGET_LABEL[target]}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="mb-1 font-medium text-foreground">Available in</legend>
            <label className="flex items-center gap-2"><input type="radio" name="skill-scope" checked={scope === 'user'} onChange={() => setScope('user')} /> All projects</label>
            <label className={`flex items-center gap-2 ${projectId ? '' : 'opacity-50'}`}>
              <input type="radio" name="skill-scope" checked={scope === 'project'} disabled={!projectId} onChange={() => setScope('project')} />
              Only {selectedProject ? selectedProject.displayName : 'the selected project'}
            </label>
          </fieldset>
        </div>

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} /> Replace if it already exists</label>

        {message && (
          <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${message.kind === 'error' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/10 text-foreground'}`}>{message.text}</div>
        )}

        <Button type="button" className="self-start" onClick={() => void importSkill()} disabled={!canImport}>
          {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BookOpen className="mr-2 h-4 w-4" />}
          Import skill
        </Button>

        <div className="border-t border-border/60 pt-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Installed skills</h3>
          {installed.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {installed.map((skill) => (
                <li key={`${skill.target}-${skill.scope}-${skill.name}`} className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {skill.name} <span className="text-xs font-normal text-muted-foreground">· {TARGET_LABEL[skill.target]} · {skill.scope === 'user' ? 'all projects' : 'this project'}</span>
                    </p>
                    {skill.description && <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>}
                  </div>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${skill.name}`} onClick={() => void removeSkill(skill)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
