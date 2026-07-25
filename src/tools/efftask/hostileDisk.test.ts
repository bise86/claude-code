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
import { readRunManifest, validateLoadedNodes } from './resumeCore.js'
import { reseatTransientNodes } from './reseat.js'
import { countStatuses } from './stateMachine.js'
import { elapsed } from '../../commands/efftask/TaskTreePanel.js'
import { createNode, emptyPhaseRoles, BLOCK_CATEGORIES, DEFAULT_CAPS, type TaskNode } from './types.js'
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
  [{ round: 1, synthesized: 'nope' }],
  { plan: { rationale: 90 } },
  { plan: { role: 'r', score: -50, rationale: [] } },
  { exec: 'nope' },
  { children: 'nope' },
  { children: [{ nope: 1 }] },
  { branch: 'b' },
  { path: '/p' },
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
  n.confirmedDraft = { children: [{ title: '甲', deps: [] }] }
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
    // Every counter is compared with >=; NaN turns a bounded loop unbounded.
    for (const c of ['planReview', 'acceptance', 'integration', 'scoring', 'mergeResolve'] as const) {
      expect(Number.isFinite(n.iteration[c])).toBe(true)
    }
    // The three booleans reseat keys on, all matched with === true.
    for (const f of ['interrupted', 'mergeConflict', 'capBlocked'] as const) {
      expect(n[f] === undefined || typeof n[f] === 'boolean').toBe(true)
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
      for (const c of n.confirmedDraft.children) expect(typeof c.title).toBe('string')
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

  // Both reseat modes, because --retry-blocked takes different branches.
  reseatTransientNodes(validated, NOW, DEFAULT_CAPS)
  reseatTransientNodes(validated, NOW, DEFAULT_CAPS, { retryBlocked: true })
  for (const n of validated) {
    serializeNode(n)      // runs on EVERY commit — a throw here blocks the node forever
    elapsed(n, Date.now())
  }
  countStatuses(validated)
  renderTreeSnapshot(validated)
}

describe('磁盘上任何一个字段被写坏,恢复链路都不许抛', () => {
  const base = richNode()
  const fields = Object.keys(base) as (keyof TaskNode)[]

  it('字段清单是从真节点上取的,不是手写的(否则新字段永远不会被覆盖)', () => {
    expect(fields.length).toBeGreaterThan(15)
    // Spot-check the ones that actually bit us, so a rename cannot silently empty this file.
    for (const f of ['reviewLog', 'score', 'worktree', 'confirmedDraft', 'capCategory', 'startedAt']) {
      expect(fields).toContain(f as keyof TaskNode)
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
        // …and whatever came back must be usable: the pool reads parallelism directly.
        expect(Number.isFinite(config.parallelism)).toBe(true)
        expect(config.parallelism).toBeGreaterThanOrEqual(1)
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
