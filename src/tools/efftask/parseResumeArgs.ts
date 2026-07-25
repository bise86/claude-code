export interface ResumeArgs {
  mode: 'new' | 'resume'
  /** Undefined means "let me pick from a list". `'latest'` is resolved against listRuns. */
  runId?: string
  /** §17.4 续跑指引. Empty means "carry on exactly as planned". */
  guidance: string
  /** For mode 'new': the original prompt, BYTE-IDENTICAL to the input. */
  rest: string
}

const FLAG = '--resume'
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
    return { mode: 'new', guidance: '', rest: raw }
  }
  const after = trimmed.slice(FLAG.length).trim()
  if (after.length === 0) return { mode: 'resume', guidance: '', rest: '' }

  const [first, ...restWords] = after.split(/\s+/)
  if (first === 'latest') {
    return { mode: 'resume', runId: 'latest', guidance: restWords.join(' '), rest: '' }
  }
  if (RUN_ID.test(first)) {
    // Zero-pad: run directories are three-digit, so `--resume 3` must find `003` rather than
    // report that run "3" does not exist.
    const runId = first.length >= 3 ? first : first.padStart(3, '0')
    return { mode: 'resume', runId, guidance: restWords.join(' '), rest: '' }
  }
  // Not an id → the whole remainder is guidance and the run is chosen interactively.
  return { mode: 'resume', guidance: after, rest: '' }
}
