export interface ResumeArgs {
  mode: 'new' | 'resume'
  /** Undefined means "let me pick from a list". `'latest'` is resolved against listRuns. */
  runId?: string
  /** §17.4 续跑指引. Empty means "carry on exactly as planned". */
  guidance: string
  /**
   * `--retry-blocked`: also reopen nodes a SAFETY VALVE stopped (spec §9/§11).
   *
   * Opt-in by design. A valve exists to stop a run from spending unbounded budget on work
   * that keeps failing, so re-arming it must be something a human asked for in words — never
   * a side effect of resuming. The escalation card names this flag, which is what makes the
   * card's 处理方式 true: a plain `--resume` reproduces the identical block having made zero
   * model calls.
   */
  retryBlocked: boolean
  /** For mode 'new': the original prompt, BYTE-IDENTICAL to the input. */
  rest: string
}

const FLAG = '--resume'
const RETRY_FLAG = '--retry-blocked'
// 1-4 digits: allocateRunId pads to three but keeps counting past 999, so a four-digit id is
// reachable and a stricter pattern would make those runs unresumable.
const RUN_ID = /^\d{1,4}$/

/**
 * Split `/et` arguments into a new run or a resume.
 *
 * The one subtle rule: the word after `--resume` is a run id ONLY if it looks like one.
 * `/et --resume 先从简` must be read as "resume the run I pick, with this guidance", not as
 * a request for a run literally named 先从简 that will then 404.
 */
export function parseResumeArgs(raw: string): ResumeArgs {
  const trimmed = raw.trim()
  // NOT `raw.trim()` for the new-run path: `rest` becomes goalPrompt, which becomes the root
  // node's goal and title and is interpolated into every plan prompt. Any normalisation here
  // silently edits the user's objective.
  if (trimmed !== FLAG && !trimmed.startsWith(`${FLAG} `)) {
    // NOT stripped on the new-run path: `rest` becomes the goalPrompt verbatim, and a user
    // whose objective legitimately contains the words "--retry-blocked" must keep them.
    return { mode: 'new', guidance: '', rest: raw, retryBlocked: false }
  }
  const after = trimmed.slice(FLAG.length).trim()
  // Pulled out wherever it appears, INCLUDING before the run id, and removed from the words
  // that become guidance — otherwise the flag would land in a model prompt as an instruction.
  const words = after.split(/\s+/).filter(w => w.length > 0)
  const retryBlocked = words.includes(RETRY_FLAG)
  const kept = words.filter(w => w !== RETRY_FLAG)
  if (kept.length === 0) return { mode: 'resume', guidance: '', rest: '', retryBlocked }

  const [first, ...restWords] = kept
  if (first === 'latest') {
    return { mode: 'resume', runId: 'latest', guidance: restWords.join(' '), rest: '', retryBlocked }
  }
  if (RUN_ID.test(first)) {
    // Zero-pad: run directories are three-digit, so `--resume 3` must find `003` rather than
    // report that run "3" does not exist.
    const runId = first.length >= 3 ? first : first.padStart(3, '0')
    return { mode: 'resume', runId, guidance: restWords.join(' '), rest: '', retryBlocked }
  }
  // Not an id → the whole remainder is guidance and the run is chosen interactively.
  return { mode: 'resume', guidance: kept.join(' '), rest: '', retryBlocked }
}
