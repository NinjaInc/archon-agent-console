/**
 * GPU arbiter: one lease at a time decides who may use the desktop GPU (chat model, image jobs, or a game).
 * Author: Josh Neufield (Archon Tech)
 *
 * Rules (all enforced here, not left to callers):
 *  - A lease has a kind ('llm' or 'image'), a priority ('interactive' or 'nightly') and a short TTL that a heartbeat renews,
 *    so a crashed holder frees the GPU by itself.
 *  - 'llm' leases may share with other 'llm' leases; an 'image' lease is exclusive.
 *  - Interactive work preempts nightly work (the nightly lease is marked preempted and its next heartbeat fails).
 *  - A game on the desktop ALWAYS wins: when the desktop reports the GPU busy with something else, nightly is refused and
 *    interactive is refused too (the user is playing); if the desktop cannot be reached, nightly fails closed and
 *    interactive fails open (a person is waiting and can see the result).
 */
import Database from 'better-sqlite3';

export type LeaseKind = 'llm' | 'image';
export type LeasePriority = 'interactive' | 'nightly';
export type GpuState = 'idle' | 'llm' | 'image' | 'busy-external';
/** What the desktop status service says: whether something other than Ollama/ComfyUI is using the GPU, or null if unreachable. */
export type ExternalCheck = () => Promise<{ externalBusy: boolean } | null>;

export type Lease = { id: string; holder: string; kind: LeaseKind; priority: LeasePriority; expiresAt: number; preempted: boolean };
export type AcquireResult = { ok: true; lease: Lease } | { ok: false; reason: 'busy-external' | 'desktop-unreachable' | 'held' };

type Options = { path: string; external: ExternalCheck; now?: () => number; ttlMs?: number };

export function createGpuArbiter(options: Options) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 90_000;
  const db = new Database(options.path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec('CREATE TABLE IF NOT EXISTS gpu_lease (id TEXT PRIMARY KEY, holder TEXT NOT NULL, kind TEXT NOT NULL, priority TEXT NOT NULL, expires_at INTEGER NOT NULL, preempted INTEGER NOT NULL DEFAULT 0)');

  type Row = { id: string; holder: string; kind: LeaseKind; priority: LeasePriority; expires_at: number; preempted: number };
  const toLease = (row: Row): Lease => ({ id: row.id, holder: row.holder, kind: row.kind, priority: row.priority, expiresAt: row.expires_at, preempted: row.preempted === 1 });
  const live = (): Row[] => {
    db.prepare('DELETE FROM gpu_lease WHERE expires_at <= ?').run(now());
    return db.prepare('SELECT * FROM gpu_lease WHERE preempted = 0').all() as Row[];
  };

  /** Tries to take the GPU. Used by the ComfyUI client before each image job and by the nightly runner before each model call. */
  async function acquire(request: { holder: string; kind: LeaseKind; priority: LeasePriority }): Promise<AcquireResult> {
    const external = await options.external().catch(() => null);
    if (external === null && request.priority === 'nightly') return { ok: false, reason: 'desktop-unreachable' };
    if (external?.externalBusy) return { ok: false, reason: 'busy-external' };
    const take = db.transaction((): AcquireResult => {
      const holders = live();
      const conflicts = holders.filter((row) => request.kind === 'image' || row.kind === 'image');
      if (conflicts.length > 0) {
        const nightlyOnly = conflicts.every((row) => row.priority === 'nightly');
        if (request.priority === 'interactive' && nightlyOnly) {
          for (const row of conflicts) db.prepare('UPDATE gpu_lease SET preempted = 1 WHERE id = ?').run(row.id);
        } else {
          return { ok: false, reason: 'held' };
        }
      }
      const id = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const expiresAt = now() + ttlMs;
      db.prepare('INSERT INTO gpu_lease (id, holder, kind, priority, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, request.holder, request.kind, request.priority, expiresAt);
      return { ok: true, lease: { id, holder: request.holder, kind: request.kind, priority: request.priority, expiresAt, preempted: false } };
    });
    return take();
  }

  /** Renews a lease. False means it was preempted or expired and the holder must stop. Used by long jobs every ~30 s. */
  function heartbeat(id: string): boolean {
    const row = db.prepare('SELECT * FROM gpu_lease WHERE id = ?').get(id) as Row | undefined;
    if (!row || row.preempted === 1 || row.expires_at <= now()) return false;
    db.prepare('UPDATE gpu_lease SET expires_at = ? WHERE id = ?').run(now() + ttlMs, id);
    return true;
  }

  /** Gives the GPU back. Safe to call twice. */
  function release(id: string): void {
    db.prepare('DELETE FROM gpu_lease WHERE id = ?').run(id);
  }

  /** Current state for the Images tab pill: what holds the GPU, ignoring the desktop check. */
  function state(): { state: GpuState; leases: Lease[] } {
    const leases = live().map(toLease);
    const current: GpuState = leases.some((l) => l.kind === 'image') ? 'image' : leases.length > 0 ? 'llm' : 'idle';
    return { state: current, leases };
  }

  return { acquire, heartbeat, release, state, close: () => db.close() };
}

export type GpuArbiter = ReturnType<typeof createGpuArbiter>;
