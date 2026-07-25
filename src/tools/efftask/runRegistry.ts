import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { loadRun, type FsLike } from './persistence.js'
import { readRunManifest } from './resumeCore.js'

/**
 * A lock older than this is treated as abandoned even if some process currently holds its
 * pid. pids are recycled, and keying staleness on liveness alone means one unlucky reuse
 * makes a run permanently unresumable — the exact failure takeover exists to prevent.
 */
export const STALE_LOCK_MS = 6 * 60 * 60 * 1000 // 6h: longer than any plausible live run

// A DIRECTORY, not a file: a non-recursive mkdir is the atomic create-if-absent primitive
// this filesystem gives us. The owner metadata lives inside it.
const lockDir = (runDir: string): string => `${runDir}/run.lock.d`
const ownerFile = (runDir: string): string => `${lockDir(runDir)}/owner.yaml`

export interface LockOwner { pid: number; at: string }
export interface LockResult { acquired: boolean; heldBy?: LockOwner; tookOver: boolean }

async function readOwner(fs: FsLike, runDir: string): Promise<LockOwner | undefined> {
  try {
    const parsed = yamlParse(await fs.readFile(ownerFile(runDir))) as { pid?: unknown; at?: unknown }
    if (!parsed || typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return undefined
    return { pid: parsed.pid, at: typeof parsed.at === 'string' ? parsed.at : '' }
  } catch {
    // Missing or unparseable. Either way it tells us nothing about a live holder, and a
    // one-byte corruption — exactly what a crash mid-write leaves — must not wall the run
    // off forever.
    return undefined
  }
}

function isStale(owner: LockOwner | undefined, pid: number, now: string, isAlive: (pid: number) => boolean): boolean {
  if (!owner) return true // unreadable owner file → treat the lock as abandoned
  if (owner.pid === pid) return true // our own lock; re-entering is fine
  const age = Date.parse(now) - Date.parse(owner.at)
  if (Number.isFinite(age) && age > STALE_LOCK_MS) return true
  return !isAlive(owner.pid)
}

/**
 * Take the single-writer lock for a run directory.
 *
 * Why this matters: two terminals resuming the same run both write node.md for the same
 * ids, so the second silently overwrites the first's progress while BOTH report success.
 *
 * `isAlive` is injected so the takeover rule is testable without spawning processes.
 */
export async function acquireRunLock(
  fs: FsLike, runDir: string, pid: number, now: string, isAlive: (pid: number) => boolean,
): Promise<LockResult> {
  const write = async (): Promise<void> => { await fs.writeFile(ownerFile(runDir), yamlStringify({ pid, at: now })) }

  // The whole exclusion rests on this one call being atomic; everything after it is
  // bookkeeping. A read-then-write would let two racing callers both observe "no lock".
  if (await fs.mkdirExclusive(lockDir(runDir))) {
    await write()
    return { acquired: true, tookOver: false }
  }

  const owner = await readOwner(fs, runDir)
  if (!isStale(owner, pid, now, isAlive)) return { acquired: false, heldBy: owner, tookOver: false }

  // Re-entering our own lock is not a takeover, and must not tear down a directory we are
  // still using.
  if (owner?.pid === pid) { await write(); return { acquired: true, tookOver: false } }

  // Stale. Tear the lock down and re-create it through the SAME atomic primitive rather than
  // just overwriting owner.yaml: if two terminals both judge the lock stale at once, only one
  // can win the re-create, so the takeover is as exclusive as the original acquisition.
  try {
    await fs.unlink(ownerFile(runDir))
    await fs.rmdir(lockDir(runDir))
  } catch { /* someone else is tearing it down too; the mkdirExclusive below decides */ }
  if (await fs.mkdirExclusive(lockDir(runDir))) {
    await write()
    return { acquired: true, tookOver: true }
  }
  return { acquired: false, heldBy: await readOwner(fs, runDir), tookOver: false }
}

/** Release the lock. Never throws: failing to release must not turn a finished run into a failed one. */
export async function releaseRunLock(fs: FsLike, runDir: string): Promise<void> {
  try { await fs.unlink(ownerFile(runDir)) } catch { /* ignore */ }
  try { await fs.rmdir(lockDir(runDir)) } catch { /* ignore */ }
}

export interface RunSummary {
  runId: string
  goalLine: string
  updatedAt: string
  counts: { accepted: number; blocked: number; pending: number; total: number }
  /** The manifest was missing or unreadable; the summary was rebuilt from the tree alone. */
  degraded: boolean
}

const RUN_ID = /^\d{1,4}$/

/**
 * Summarise every recoverable run under the efftask root, newest first.
 *
 * Runs with ZERO recovered nodes are omitted. `allocateRunId` reserves an id by creating the
 * directory, and a SIGKILL never reaches the release path, so empty reservations really do
 * accumulate — and `--resume latest` picking one would recover nothing, synthesize a
 * childless root and die instantly with an opaque reason.
 */
/**
 * The run's objective, from the manifest or the recovered root.
 *
 * TYPE-CHECKED, because this path has no validateLoadedNodes: listRuns reads node.md through
 * parseNodeFile directly. A hand-edited `goal: 123` therefore reached `.split` as a number
 * and threw out of listRuns — taking the whole run PICKER with it, so one damaged run hid
 * every healthy one.
 */
function pickGoal(fromManifest: unknown, nodes: { id: string; goal?: unknown }[]): string {
  if (typeof fromManifest === 'string' && fromManifest.length > 0) return fromManifest
  const rootGoal = nodes.find(n => n.id === 'root')?.goal
  return typeof rootGoal === 'string' ? rootGoal : ''
}

export async function listRuns(fs: FsLike, effRoot: string): Promise<RunSummary[]> {
  let names: string[]
  try { names = await fs.readdir(effRoot) } catch { return [] } // no runs yet is not an error

  const summaries: RunSummary[] = []
  for (const name of names) {
    if (!RUN_ID.test(name)) continue // notes/, README.md, anything hand-made
    const runDir = `${effRoot}/${name}`
    let nodes
    try { ({ nodes } = await loadRun(fs, runDir)) } catch { continue }
    if (nodes.length === 0) continue // reserved but never written
    const { config, degraded } = await readRunManifest(fs, runDir)

    let accepted = 0, blocked = 0
    let newest = ''
    for (const n of nodes) {
      if (n.status === 'ACCEPTED') accepted++
      else if (n.status === 'BLOCKED') blocked++
      // Max node timestamp, because the manifest frontmatter has no updatedAt of its own —
      // and "the run you last touched" is exactly what `--resume latest` should mean.
      if (typeof n.updatedAt === 'string' && n.updatedAt > newest) newest = n.updatedAt
    }
    const goal = pickGoal(config.goalPrompt, nodes)
    summaries.push({
      runId: name,
      goalLine: goal.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '',
      updatedAt: newest,
      counts: { accepted, blocked, pending: nodes.length - accepted - blocked, total: nodes.length },
      degraded: degraded.length > 0,
    })
  }
  // Newest first. Ties fall back to the id so the order is deterministic rather than
  // readdir-dependent.
  return summaries.sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.runId < b.runId ? 1 : -1) : (a.updatedAt < b.updatedAt ? 1 : -1))
}
