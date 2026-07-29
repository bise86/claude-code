/**
 * 恢复路径的对抗性扫描:磁盘上的每个字段,轮流塞进敌意值,整条链路都不许炸。
 *
 * WHY THIS EXISTS, and why it is generative rather than a list of cases.
 *
 * `.claude/efftask/<run>/**\/node.md` and `run.md` are YAML that a human is explicitly invited
 * to edit (the escalation cards tell them to raise `caps.maxIterations`, and `node.md` is the
 * run's own record). Everything on that disk is therefore untrusted input.
 *
 * Three consecutive review rounds found the SAME defect shape: someone adds a READER that
 * dereferences a persisted field one level deeper than `validateLoadedNodes` checks, and a
 * half-written or hand-edited value then throws — from inside `commit()`, which blocks the
 * node with a raw JS TypeError as its reason, or from inside `validateLoadedNodes` itself,
 * which costs the user every node in the run. Each round the fix was another per-field patch,
 * and each round a reviewer found the next field by hand. Found that way, one at a time:
 * `reviewLog.verdicts`, `verdicts[].blocking`, `score.plan.rationale`, `confirmedDraft` (null),
 * `worktree` (null), `worktree` (wrong shape), `interrupted`, `capCategory`, `startedAt`,
 * `updatedAt`, `goal`, `caps.scoreThreshold`.
 *
 * The per-field patches are all still there and still right. This file is the part that does
 * not drift: it enumerates the fields from a REAL node object, so a field added later is
 * covered the day it appears, and it drives the actual consumers rather than asserting on
 * shapes. If a future reader dereferences deeper than the validator checks, this goes red
 * without anyone having to think of that field.
 */
import { describe, expect, it } from 'bun:test'
import { loadRun, renderTreeSnapshot, serializeNode, type FsLike } from './persistence.js'
import { LEGAL_KIND, LEGAL_STATUS, readRunManifest, validateLoadedNodes } from './resumeCore.js'
import { reseatTransientNodes } from './reseat.js'
import { countStatuses } from './stateMachine.js'
import { elapsed } from '../../commands/efftask/TaskTreePanel.js'
import { createNode, emptyPhaseRoles, BLOCK_CATEGORIES, DEFAULT_CAPS, PHASE_NAMES, type TaskNode } from './types.js'
import { readFileSync } from 'node:fs'
import { stringify as yamlStringify } from 'yaml'

const NOW = '2026-07-26T00:00:00.000Z'

/**
 * Values a YAML file can legally hold where the code expected something else.
 *
 * Includes NESTED shapes on purpose. A first version of this list only replaced whole fields,
 * and it missed four of the six bugs reviewers had found by hand — because those bugs live
 * one level in (`reviewLog[].verdicts`, `verdicts[].blocking`, `score.plan.rationale`), where
 * a container of the right OUTER type carries the wrong inner one.
 */
const HOSTILE: unknown[] = [
  null, 123, -1, 0, 'a string', true, false, '',
  [], [null], ['x'], {}, { nope: 1 }, [{ nope: 1 }],
  // container-shaped, wrong inside — the shapes that actually bit us
  [{ round: 1 }],
  [{ round: 1, verdicts: 'nope' }],
  [{ round: 1, verdicts: [{ role: 'a' }] }],
  [{ round: 1, verdicts: [{ role: 'a', blocking: 'not an array' }] }],
  [{ round: 1, verdicts: [{ role: 'a', blocking: ['x'], comments: 5 }] }],
  // 补救拆分 proposals ride on a verdict, so a hand-edited node.md can carry any shape here.
  [{ round: 1, verdicts: [{ role: 'a', blocking: ['x'], comments: 'c', remedy: 'nope' }] }],
  [{ round: 1, verdicts: [{ role: 'a', blocking: ['x'], comments: 'c', remedy: [{ title: 5 }] }] }],
  [{ round: 1, synthesized: 'nope' }],
  { plan: { rationale: 90 } },
  { plan: { role: 'r', score: -50, rationale: [] } },
  { exec: 'nope' },
  { children: 'nope' },
  { children: [{ nope: 1 }] },
  { branch: 'b' },
  { path: '/p' },
  // container-shaped, EMPTY inside. A separate class from "wrong inside", and the one this
  // list missed: every hostile value above replaces a container's ELEMENTS, so a reader that
  // dereferences `children[0]` / `verdicts[0]` — outer shape guarded, index not — walked
  // through all 34,000 assertions untouched. Proven, not hypothesised: a reviewer added
  // exactly such a reader and this file stayed green.
  { children: [] },
  [{ round: 1, verdicts: [] }],
  { plan: {} },
  { plan: {}, exec: {} },
  // Inner shapes for the three containers whose `.map` bodies were never reached, because
  // every hostile element above was filtered out one line before them: `resumes[]` needs an
  // `at` string to survive, `phaseRoles.<phase>[]` needs a `roleName` string.
  [{ at: 'x' }],
  [{ at: 'x', reseated: 'nope', exhausted: [], retried: {}, repairs: 'nope' }],
  { plan: [{ roleName: 123 }] },
  { plan: [{ roleName: 'r', model: 5 }], accept: 'nope' },
  // Negative counters. `Number.isFinite(-5)` is true, so the whole iteration block sailed
  // past both the validator and this file's own post-condition, while every budget check is
  // `spent >= caps.maxIterations` — buying 8 rounds where the caps say 3.
  { planReview: -5, acceptance: -5, integration: -5, scoring: -5, mergeResolve: -5 },
  // 各阶段耗时 is a plain number map on disk, so it takes garbage the same way iteration does.
  { EXECUTING: 'nope' },
  { EXECUTING: -1 },
  { EXECUTING: Number.NaN },
  { 不是状态: 5 },
]

/** A fully-populated node — the field list comes from this, not from a hand-written array. */
function richNode(): TaskNode {
  const n = createNode({
    id: 'root', title: '根任务', goal: '打通登录', parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  })
  n.kind = 'executable'
  n.status = 'BLOCKED'
  n.execStatus = '改了 src/a.ts'
  n.blockedReason = '验收迭代超限(3)'
  n.interrupted = false
  n.mergeConflict = true
  n.capBlocked = true
  n.capCategory = 'rework'
  // 补救拆分 already used once — the flag that stops it happening twice, which is the bound
  // the whole cost argument for that feature rests on.
  n.revised = true
  n.phaseMs = { EXECUTING: 42_000, ACCEPTANCE: 7_000 }
  // 模型用量。和 phaseMs 同一类:一张从盘上读回来的纯数字表,而它会被渲染成
  // `NaN 次 · NaNk`,还会顺着 childIds 被子树合计一路传染到根节点那一行。
  n.usage = { calls: 12, input: 34_000, output: 5_600, cacheRead: 120_000, cacheWrite: 800 }
  // 被任务重做删掉的那棵子树的账。和 usage 同一类的敌意输入面。
  n.discardedUsage = { calls: 20, input: 60_000, output: 9_000, cacheRead: 0, cacheWrite: 0 }
  n.confirmedDraft = { children: [{ title: '甲', deps: [] }] }
  // 手工重做的一次性重入点。和 confirmedDraft 同类:一个持久化的标志选 step **内部**的
  // 入口,而 node.md 是可手工编辑的 —— 一个垃圾值决定节点从哪个环节重入。
  n.redoFrom = 'review'
  n.worktree = { branch: 'b', path: '/wt/root' }
  n.startedAt = NOW
  n.score = {
    plan: { role: 'scorer', score: 80, rationale: '结构清楚' },
    exec: { role: 'scorer', score: 90, rationale: '测试齐全' },
  }
  n.reviewLog = [{
    round: 1,
    verdicts: [{ role: 'architect', pass: false, blocking: ['缺回滚'], comments: 'c' }],
    synthesized: { pass: false, blockingSummary: '[architect] 缺回滚' },
  }]
  n.acceptLog = [...n.reviewLog]
  return n
}

/** An fs whose only content is one node.md and one run.md, both supplied as raw text. */
function diskWith(nodeMd: string, runMd = '---\ncreatedAt: x\ngoalPrompt: g\n---\n\n'): FsLike {
  const files = new Map<string, string>([
    ['/run/run.md', runMd],
    ['/run/root/node.md', nodeMd],
  ])
  return {
    readFile: async p => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v },
    writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
    unlink: async () => {}, rmdir: async () => {}, exists: async () => true,
    readdir: async d => {
      if (d === '/run') return ['run.md', 'root']
      if (d === '/run/root') return ['node.md']
      throw new Error('not a dir')
    },
  }
}

/**
 * Everything the recovery path does to a node before the orchestrator gets it, plus every
 * consumer that reads it afterwards. This is the list a per-field patch has to satisfy, and
 * the reason the test drives it rather than asserting on shapes.
 */
async function driveRecovery(nodeMd: string, intactField?: keyof TaskNode): Promise<void> {
  const fs = diskWith(nodeMd)
  const { nodes } = await loadRun(fs, '/run')
  const { nodes: validated } = validateLoadedNodes(nodes, {
    goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW,
  })

  // POST-CONDITIONS, not just "it did not throw".
  //
  // A first version of this file asserted only the absence of an exception, and four of the
  // six known bugs sailed through it: `startedAt: 123` renders a year-1900 duration instead
  // of throwing, a bad `capCategory` silently sends a retried node to the wrong phase, and a
  // defensive WRITER can mask a missing VALIDATOR entirely. What protects the readers is the
  // shape the validator guarantees, so that is what gets asserted.
  for (const n of validated) {
    expect(typeof n.id).toBe('string')
    expect(typeof n.title).toBe('string')
    expect(typeof n.goal).toBe('string')
    expect(typeof n.execStatus).toBe('string')
    expect(typeof n.blockedReason).toBe('string')
    expect(Array.isArray(n.deps)).toBe(true)
    expect(Array.isArray(n.childIds)).toBe(true)
    // The state machine switches on these exhaustively; an unlisted value falls through
    // every branch, and the node is then neither advanceable nor blocked.
    expect(LEGAL_STATUS.has(n.status as string)).toBe(true)
    expect(LEGAL_KIND.has(n.kind as string)).toBe(true)
    expect(Number.isFinite(n.depth)).toBe(true)
    expect(n.depth).toBeGreaterThanOrEqual(0)
    // Both feed Date.parse, which COERCES instead of throwing — the failure is a wrong
    // duration on screen, not an exception, so "it did not throw" could never have caught it.
    expect(typeof n.createdAt).toBe('string')
    expect(typeof n.updatedAt).toBe('string')
    expect(n.startedAt === undefined || typeof n.startedAt === 'string').toBe(true)
    for (const k of ['solution', 'keyPoints', 'risks', 'acceptance'] as const) {
      expect(typeof n.plan[k]).toBe('string')
    }
    // The roster is what runRoundtable dispatches from: a `roleName: 123` reaches runAgent as
    // an undefined subagent type.
    for (const p of PHASE_NAMES) {
      expect(Array.isArray(n.phaseRoles[p])).toBe(true)
      for (const r of n.phaseRoles[p]) {
        expect(typeof r.roleName).toBe('string')
        expect(r.model === undefined || typeof r.model === 'string').toBe(true)
      }
    }
    // Every counter is compared with >=; NaN turns a bounded loop unbounded — and so does a
    // negative number, which is finite. Asserting only Number.isFinite let `planReview: -5`
    // through, buying 8 real model rounds against a cap of 3.
    for (const c of ['planReview', 'acceptance', 'integration', 'scoring', 'mergeResolve'] as const) {
      expect(Number.isFinite(n.iteration[c])).toBe(true)
      expect(n.iteration[c]).toBeGreaterThanOrEqual(0)
    }
    // The three booleans reseat keys on, all matched with === true.
    for (const f of ['interrupted', 'mergeConflict', 'capBlocked'] as const) {
      expect(n[f] === undefined || typeof n[f] === 'boolean').toBe(true)
    }
    // 各阶段耗时 is divided by 1000 and rendered; NaN reads as "NaNs" and a negative reads as
    // a phase that finished before it started. Unknown keys are dropped rather than shown —
    // a row labelled with something that is not a status is not a phase.
    for (const [k, v] of Object.entries(n.phaseMs ?? {})) {
      expect(LEGAL_STATUS.has(k)).toBe(true)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
    // capCategory picks WHICH phase a retried node re-enters.
    expect(n.capCategory === undefined || BLOCK_CATEGORIES.has(n.capCategory)).toBe(true)
    // worktree is the isolation gate: a truthy-but-malformed value makes it pass.
    if (n.worktree !== undefined) {
      expect(typeof n.worktree.branch).toBe('string')
      expect(typeof n.worktree.path).toBe('string')
      expect(n.worktree.branch.length).toBeGreaterThan(0)
      expect(n.worktree.path.length).toBeGreaterThan(0)
    }
    if (n.confirmedDraft !== undefined) {
      expect(Array.isArray(n.confirmedDraft.children)).toBe(true)
      // NOT asserted non-empty, deliberately: `applyRootDraft` writes `{children: []}` for an
      // executable root, where presence of the field — not its length — is the confirmation.
      // A reader that dereferences `children[0]` is therefore wrong on legal data, and
      // stepStart's `confirmed` guard is what refuses the one shape that is dangerous (an
      // empty list on a node that is not executable). Tried tightening the validator instead;
      // it discarded a real gate decision.
      for (const c of n.confirmedDraft.children) {
        expect(typeof c.title).toBe('string')
        expect(c.title.length).toBeGreaterThan(0)
        expect(Array.isArray(c.deps)).toBe(true)
      }
    }
    for (const rec of [...n.reviewLog, ...n.acceptLog]) {
      expect(Number.isFinite(rec.round)).toBe(true)
      expect(Array.isArray(rec.verdicts)).toBe(true)
      expect(typeof rec.synthesized.blockingSummary).toBe('string')
      for (const v of rec.verdicts) {
        expect(typeof v.role).toBe('string')
        expect(Array.isArray(v.blocking)).toBe(true)
        expect(typeof v.comments).toBe('string')
      }
    }
    for (const s2 of [n.score.plan, n.score.exec]) {
      if (s2 === undefined) continue
      expect(typeof s2.role).toBe('string')
      expect(typeof s2.rationale).toBe('string')
      expect(Number.isFinite(s2.score)).toBe(true)
      expect(s2.score).toBeGreaterThanOrEqual(0)
      expect(s2.score).toBeLessThanOrEqual(100)
    }
    // The panel must never print a duration from a corrupt timestamp.
    const shown = elapsed(n, Date.parse(NOW) + 5000)
    expect(shown === '-' || shown === '排队中' || /^\d{1,6}s$/.test(shown)).toBe(true)
  }

  // PRESERVATION, alongside safety. A validator that answers "this field might be malformed"
  // by deleting it is safe and wrong — one round's fix for `score.plan.rationale: 90` did
  // exactly that, discarding the reviewer's comment instead of stringifying it. Corrupting
  // field X must not cost the user field Y.
  if (intactField !== undefined) {
    const n = validated.find(x => x.id === 'root')
    expect(n).toBeDefined()
    if (intactField !== 'score' && n!.score.plan !== undefined) {
      expect(n!.score.plan.rationale).toBe('结构清楚')
      expect(n!.score.plan.score).toBe(80)
    }
    if (intactField !== 'reviewLog' && n!.reviewLog.length > 0) {
      expect(n!.reviewLog[0].verdicts[0]?.blocking).toEqual(['缺回滚'])
    }
    if (intactField !== 'goal') expect(n!.goal).toBe('打通登录')
    if (intactField !== 'execStatus') expect(n!.execStatus).toBe('改了 src/a.ts')
  }

  // The writers, on what the VALIDATOR produced — before reseat gets a chance to launder it.
  // reseat stamps `updatedAt = now` on every node it moves, and richNode's mergeConflict makes
  // it move all of them, so serializeNode had never once seen a corrupt `updatedAt`. Any
  // reader added to serializeNode for that field was invisible to this file.
  for (const n of validated) {
    serializeNode(n)      // runs on EVERY commit — a throw here blocks the node forever
    elapsed(n, Date.now())
  }
  countStatuses(validated)
  renderTreeSnapshot(validated)

  // Both reseat modes, on INDEPENDENT copies. Called in sequence on the same array, the second
  // call was a no-op for 25 of the 26 fields — every entry point in reseat requires
  // `status === 'BLOCKED'`, and the first call had already moved the node off it. So the
  // --retry-blocked branches (reviewExhausted's phase choice, the budget reset, the RETRY_NOTE
  // append) were unreached for all but one field, including capCategory's consumer — one of
  // the six bugs this file exists to catch.
  for (const opts of [{}, { retryBlocked: true }]) {
    const copy = structuredClone(validated)
    reseatTransientNodes(copy, NOW, DEFAULT_CAPS, opts)
    for (const n of copy) {
      serializeNode(n)
      elapsed(n, Date.now())
    }
    countStatuses(copy)
    renderTreeSnapshot(copy)
  }
}

describe('磁盘上任何一个字段被写坏,恢复链路都不许抛', () => {
  const base = richNode()
  const fields = Object.keys(base) as (keyof TaskNode)[]

  it('字段清单必须覆盖 TaskNode 声明的每一个字段', () => {
    // `Object.keys(richNode())` can only see fields something ASSIGNS. A field added to the
    // interface that neither createNode nor richNode sets is absent from the scan, and a
    // `toBeGreaterThan(15)` guard passes anyway — the exact drift this file was written to
    // end, one level up. So the list is checked against the DECLARATION, which is the only
    // place a new field cannot hide from.
    const src = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('export interface TaskNode {'))
    const declared = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1])
    // If the regex ever stops matching, everything below is vacuously true — pin the count.
    expect(declared.length).toBeGreaterThan(20)
    expect(declared.filter(f => !fields.includes(f as keyof TaskNode))).toEqual([])
    // …and the ones that actually bit us, so a rename cannot silently empty this file.
    for (const f of ['reviewLog', 'score', 'worktree', 'confirmedDraft', 'capCategory', 'startedAt']) {
      expect(declared).toContain(f)
    }
  })

  for (const field of fields) {
    it(`${field} 被写成任意敌意值都不抛`, async () => {
      for (const value of HOSTILE) {
        const raw: Record<string, unknown> = { ...base, [field]: value }
        const md = `---\n${yamlStringify(raw)}---\n\n# x\n`
        // The assertion IS "it did not throw". A rejected promise here is the exact failure
        // this file exists for: it means a reader dereferences deeper than the validator
        // checks, and on the real disk that costs a node or the whole run.
        await driveRecovery(md, field).catch(e => {
          throw new Error(`字段 ${String(field)} = ${JSON.stringify(value)} 让恢复链路抛了: ${e instanceof Error ? e.message : String(e)}`)
        })
      }
    })
  }

  it('--retry-blocked 分支在这份扫描里确实被走到了(否则那一半循环是摆设)', async () => {
    // A vacuity guard, not a behaviour test. Both reseat modes used to run in SEQUENCE on the
    // same array: the first call moved the node off BLOCKED, and every entry point in reseat
    // requires BLOCKED — so the second call returned immediately for 25 of the 26 fields and
    // the --retry-blocked branches were never exercised at all. Independent copies fixed that,
    // and this pins it: if a future edit makes the fixture non-blocked, half the loop silently
    // stops testing anything and this goes red instead.
    const md = `---\n${yamlStringify({ ...richNode() })}---\n\n# x\n`
    const { nodes } = await loadRun(diskWith(md), '/run')
    const { nodes: validated } = validateLoadedNodes(nodes, { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW })
    const plain = reseatTransientNodes(structuredClone(validated), NOW, DEFAULT_CAPS)
    const retry = reseatTransientNodes(structuredClone(validated), NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(retry.retried.length).toBeGreaterThan(0)
    // …and the two modes must actually take different paths, or one of the two copies is
    // just paying for a duplicate of the other.
    expect(plain.retried).toEqual([])
  })

  it('完好的节点原样通过校验 —— 校验器不能顺手改掉好数据', async () => {
    const md = `---\n${yamlStringify({ ...base })}---\n\n# x\n`
    const fsx = diskWith(md)
    const { nodes } = await loadRun(fsx, '/run')
    const { nodes: validated, repairs } = validateLoadedNodes(nodes, { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW })
    // `repairs` mixes two kinds of line: "we fixed something broken" and "FYI, we kept your
    // conflict worktree". Only the first kind may appear for a healthy node.
    expect(repairs.filter(r => /损坏|无法识别|已清除|已丢弃|非法|重置|缺失/.test(r))).toEqual([])
    const n = validated[0]
    expect(n.score.plan).toEqual({ role: 'scorer', score: 80, rationale: '结构清楚' })
    expect(n.score.exec).toEqual({ role: 'scorer', score: 90, rationale: '测试齐全' })
    expect(n.reviewLog[0].verdicts).toEqual([{ role: 'architect', pass: false, blocking: ['缺回滚'], comments: 'c' }])
    expect(n.confirmedDraft).toEqual({ children: [{ title: '甲', deps: [] }] })
    expect(n.worktree).toEqual({ branch: 'b', path: '/wt/root' })
    expect(n.capCategory).toBe('rework')
    expect(n.mergeConflict).toBe(true)
  })

  /**
   * The other half of preservation, and the half the `intactField` chain structurally cannot
   * see: it only ever asks "did corrupting X cost Y", while this defect class is "corrupting X
   * cost X's own salvageable content". Reproduced by restoring the old `scoreRecord` — which
   * answered a non-string `rationale` by DELETING the reviewer's comment instead of
   * String()-ing it — and this file stayed entirely green; only a hand-written case in
   * resumeCore.test.ts went red, which is the per-field hunting this file was meant to end.
   *
   * A validator that answers "this might be malformed" by dropping it is safe and wrong. The
   * user typed those comments, and the run is being resumed to keep them.
   */
  const salvage = async (over: Record<string, unknown>): Promise<TaskNode> => {
    const md = `---\n${yamlStringify({ ...richNode(), ...over })}---\n\n# x\n`
    const { nodes } = await loadRun(diskWith(md), '/run')
    const { nodes: validated } = validateLoadedNodes(nodes, { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW })
    const n = validated.find(x => x.id === 'root')
    expect(n).toBeDefined()
    return n!
  }

  it('score:数字 rationale 要被 String() 而不是被删掉', async () => {
    const n = await salvage({ score: { plan: { role: 'r', score: 80, rationale: 90 } } })
    expect(n.score.plan).toEqual({ role: 'r', score: 80, rationale: '90' })
  })

  it('score:分数越界只夹到范围内,理由和角色一起留着', async () => {
    const n = await salvage({ score: { plan: { role: 'r', score: -50, rationale: '结构清楚' } } })
    expect(n.score.plan).toEqual({ role: 'r', score: 0, rationale: '结构清楚' })
  })

  it('reviewLog:blocking 写成字符串,同一条评审里的角色和评语不能陪葬', async () => {
    const n = await salvage({
      reviewLog: [{ round: 2, verdicts: [{ role: 'architect', blocking: '不是数组', comments: '要加回滚' }] }],
    })
    expect(n.reviewLog[0].round).toBe(2)
    expect(n.reviewLog[0].verdicts[0].role).toBe('architect')
    expect(n.reviewLog[0].verdicts[0].comments).toBe('要加回滚')
    expect(n.reviewLog[0].verdicts[0].blocking).toEqual([])
  })

  it('reviewLog:整组 verdicts 丢了,综合结论还要留着', async () => {
    const n = await salvage({
      reviewLog: [{ round: 2, verdicts: 'nope', synthesized: { pass: false, blockingSummary: '[architect] 缺回滚' } }],
    })
    expect(n.reviewLog[0].round).toBe(2)
    expect(n.reviewLog[0].synthesized.blockingSummary).toBe('[architect] 缺回滚')
  })

  it('worktree:引用无法识别时清掉引用,但 mergeConflict 必须留着', async () => {
    // Clearing both was a real regression: it left a node that NEITHER --resume NOR
    // --retry-blocked could reopen, while its own blockedReason still told the user to resume.
    const n = await salvage({ worktree: { branch: 'b' } })
    expect(n.worktree).toBeUndefined()
    expect(n.mergeConflict).toBe(true)
  })

  it('capCategory:类别无法识别时清掉类别,但 capBlocked 必须留着', async () => {
    // capBlocked is what makes --retry-blocked OFFER the node at all; dropping it alongside
    // the category would silently retire a node the escalation card invited the user to retry.
    const n = await salvage({ capCategory: '瞎写的' })
    expect(n.capCategory).toBeUndefined()
    expect(n.capBlocked).toBe(true)
  })

  it('iteration:一个计数器是负数,不能把其它计数器一起清零', async () => {
    const n = await salvage({ iteration: { planReview: -5, acceptance: 2, integration: 1, scoring: 0, mergeResolve: 0 } })
    expect(n.iteration.planReview).toBe(0)
    expect(n.iteration.acceptance).toBe(2)
    expect(n.iteration.integration).toBe(1)
  })

  it('confirmedDraft:一个子项写坏,其余已确认的子项要留着', async () => {
    const n = await salvage({ confirmedDraft: { children: [{ title: '甲', deps: 'nope' }, { nope: 1 }] } })
    expect(n.confirmedDraft).toEqual({ children: [{ title: '甲', deps: [] }] })
  })

  it('phaseRoles:一个角色写坏,同阶段其它角色要留着', async () => {
    const n = await salvage({ phaseRoles: { ...emptyPhaseRoles(), plan: [{ roleName: 'architect', model: 5 }, { nope: 1 }] } })
    expect(n.phaseRoles.plan).toEqual([{ roleName: 'architect' }])
  })

  it('plan:一个子字段写坏,其余方案正文要留着', async () => {
    const n = await salvage({ plan: { solution: '先做登录', keyPoints: 5, risks: '无', acceptance: '测试通过' } })
    expect(n.plan.solution).toBe('先做登录')
    expect(n.plan.keyPoints).toBe('')
    expect(n.plan.acceptance).toBe('测试通过')
  })

  it('两个字段同时写坏也不抛', async () => {
    // Single-field cases miss interactions — `worktree` + `mergeConflict` was exactly one.
    for (const a of ['worktree', 'mergeConflict', 'score', 'reviewLog'] as (keyof TaskNode)[]) {
      for (const b of ['confirmedDraft', 'capCategory', 'interrupted', 'iteration'] as (keyof TaskNode)[]) {
        for (const value of [null, 'x', 123]) {
          const raw: Record<string, unknown> = { ...base, [a]: value, [b]: value }
          await driveRecovery(`---\n${yamlStringify(raw)}---\n\n# x\n`).catch(e => {
            throw new Error(`${String(a)}+${String(b)} = ${JSON.stringify(value)} 抛了: ${e instanceof Error ? e.message : String(e)}`)
          })
        }
      }
    }
  })
})

describe('run.md 的每个配置字段被写坏,readRunManifest 都不许抛', () => {
  const MANIFEST_FIELDS = ['createdAt', 'parallelism', 'phaseRoles', 'caps', 'goalPrompt', 'notices', 'mainModel', 'resumeGuidance', 'resumes', 'status', 'reason']
  const CAP_FIELDS = ['maxDepth', 'maxNodes', 'maxIterations', 'nodeTimeoutMs', 'scoreThreshold']

  for (const field of MANIFEST_FIELDS) {
    it(`${field} 被写成任意敌意值都不抛`, async () => {
      for (const value of HOSTILE) {
        const fm: Record<string, unknown> = { createdAt: 'x', goalPrompt: 'g', [field]: value }
        const fs = diskWith('---\nid: root\n---\n\n', `---\n${yamlStringify(fm)}---\n\n`)
        const { config } = await readRunManifest(fs, '/run').catch(e => {
          throw new Error(`run.md 的 ${field} = ${JSON.stringify(value)} 抛了: ${e instanceof Error ? e.message : String(e)}`)
        })
        // …and whatever came back must be USABLE, not merely returned. Asserting only
        // parallelism meant corrupting `caps`, `phaseRoles`, `notices` or `resumes` was
        // checked for "did not throw" and nothing else — and `resumes` is where the resume
        // history the gate prints comes from.
        expect(Number.isFinite(config.parallelism)).toBe(true)
        expect(config.parallelism).toBeGreaterThanOrEqual(1)
        expect(typeof config.goalPrompt).toBe('string')
        for (const c of ['maxDepth', 'maxNodes', 'maxIterations', 'nodeTimeoutMs'] as const) {
          expect(Number.isFinite(config.caps[c])).toBe(true)
          expect(config.caps[c]).toBeGreaterThan(0)
        }
        for (const p of PHASE_NAMES) {
          expect(Array.isArray(config.phaseRoles[p])).toBe(true)
          for (const r of config.phaseRoles[p]) expect(typeof r.roleName).toBe('string')
        }
        expect(Array.isArray(config.notices)).toBe(true)
        for (const x of config.notices) expect(typeof x).toBe('string')
        expect(config.mainModel === undefined || typeof config.mainModel === 'string').toBe(true)
        for (const r of config.resumes ?? []) {
          expect(typeof r.at).toBe('string')
          expect(Number.isFinite(r.reseated)).toBe(true)
          expect(Number.isFinite(r.exhausted)).toBe(true)
          expect(r.retried === undefined || Number.isFinite(r.retried)).toBe(true)
          expect(Array.isArray(r.repairs)).toBe(true)
          for (const x of r.repairs) expect(typeof x).toBe('string')
        }
      }
    })
  }

  for (const field of CAP_FIELDS) {
    it(`caps.${field} 被写成任意敌意值都不抛,且结果可用`, async () => {
      for (const value of HOSTILE) {
        const fm = { createdAt: 'x', goalPrompt: 'g', caps: { [field]: value } }
        const fs = diskWith('---\nid: root\n---\n\n', `---\n${yamlStringify(fm)}---\n\n`)
        const { config } = await readRunManifest(fs, '/run')
        // Every cap is compared with >= somewhere; NaN would make a bounded loop unbounded.
        for (const c of ['maxDepth', 'maxNodes', 'maxIterations', 'nodeTimeoutMs'] as const) {
          expect(Number.isFinite(config.caps[c])).toBe(true)
          expect(config.caps[c]).toBeGreaterThan(0)
        }
        if (config.caps.scoreThreshold !== undefined) {
          expect(config.caps.scoreThreshold).toBeGreaterThanOrEqual(0)
          expect(config.caps.scoreThreshold).toBeLessThanOrEqual(100)
        }
      }
    })
  }
})
