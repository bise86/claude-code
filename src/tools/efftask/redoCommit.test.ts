import { describe, expect, it } from 'bun:test'

import { commitRedo } from './redoCommit.js'
import { planRedo, type RedoPlan } from './redo.js'
import type { FsLike } from './persistence.js'
import { PHASE_NAMES, type EffTaskConfig, type NodeKind, type NodeStatus, type TaskNode } from './types.js'

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id, title: id, goal: `目标 ${id}`, parentId: null, childIds: [], deps: [],
    kind: 'executable' as NodeKind, status: 'CREATED' as NodeStatus,
    phaseRoles: Object.fromEntries(PHASE_NAMES.map(p => [p, []])) as TaskNode['phaseRoles'],
    plan: { solution: '', keyPoints: '', risks: '', acceptance: '' },
    execStatus: '', blockedReason: '', reviewLog: [], acceptLog: [], score: {},
    iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    depth: 0, createdAt: 'T0', updatedAt: 'T0',
    ...over,
  }
}

const TREE = (): TaskNode[] => [
  node('root', { kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
  node('root/00-a', {
    parentId: 'root', depth: 1, status: 'ACCEPTED',
    worktree: { branch: 'br-a', path: '/wt/a' },
  }),
]

/** 记录**发生了什么、按什么顺序**的假盘。 */
function fakeFs(over: Partial<FsLike> = {}): { fs: FsLike; log: string[] } {
  const log: string[] = []
  const files = new Set<string>(['root/node.md', 'root/00-a/node.md'].map(p => `/run/${p}`))
  const fs: FsLike = {
    async readFile(p) { log.push(`read ${p}`); return '' },
    async writeFile(p) { log.push(`write ${p}`); files.add(p) },
    async mkdir(p) { log.push(`mkdir ${p}`) },
    async readdir() { return [] },
    async exists(p) { return files.has(p) },
    async mkdirExclusive() { return true },
    async unlink(p) { log.push(`unlink ${p}`); files.delete(p) },
    async rmdir(p) { log.push(`rmdir ${p}`) },
    ...over,
  }
  return { fs, log }
}

const CONFIG = { goalPrompt: '目标', caps: {}, phaseRoles: {} } as unknown as EffTaskConfig
const ok = (r: RedoPlan | { error: string }): RedoPlan => {
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('commitRedo 的落盘顺序', () => {
  it('先放工作区,再删子树,最后才写节点', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs, log } = fakeFs()
    const released: string[] = []
    await commitRedo({
      fs, runDir: '/run', config: CONFIG, before,
      pool: { async release(n) { released.push(n.id); log.push(`release ${n.id}`); return { removed: true } } },
    }, plan)

    const iRelease = log.findIndex(l => l.startsWith('release '))
    const iUnlink = log.findIndex(l => l.startsWith('unlink '))
    const iWrite = log.findIndex(l => l === 'write /run/root/node.md')
    // release 要拿**原节点**算路径和分支,而下一步就把它们从树里删了。
    expect(iRelease).toBeGreaterThanOrEqual(0)
    expect(iRelease).toBeLessThan(iUnlink)
    // 删在写之前:反过来的话,一次失败的删除会留下一个刚被写过的、看起来很新的幽灵。
    expect(iUnlink).toBeLessThan(iWrite)
  })

  it('被删的子节点 node.md 真的从盘上消失', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs, log } = fakeFs()
    await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    // 留在盘上的话,loadRun 下次 --resume 会把它原样读回来 —— 而父节点的 childIds
    // 已经不认它了,于是变成一个永远等不到的幽灵兄弟。
    expect(log).toContain('unlink /run/root/00-a/node.md')
  })

  it('剩下的节点全部写回去 —— 依赖改写只存在于内存里等于没改', async () => {
    const before = [
      ...TREE(),
      node('root/01-b', { parentId: 'root', depth: 1, deps: ['root/00-a'] }),
    ]
    before[0]!.childIds = ['root/00-a', 'root/01-b']
    const plan = ok(planRedo(before, 'root/00-a', 'execute', 'T1'))
    const { fs, log } = fakeFs()
    await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    for (const id of ['root', 'root/00-a', 'root/01-b']) {
      expect(log).toContain(`write /run/${id}/node.md`)
    }
  })
})

describe('commitRedo 报出来的问题', () => {
  it('工作区因为有未合入的提交而保留 —— 说清楚,并且不算失败', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs } = fakeFs()
    const { problems } = await commitRedo({
      fs, runDir: '/run', config: CONFIG, before,
      pool: { async release() { return { removed: false, keptBecause: '仍有未合入集成分支的提交' } } },
    }, plan)
    // 重做不该顺手毁掉用户还没合并的产出。保留是**正确行为**,但必须告诉他东西在哪。
    expect(problems.join()).toContain('仍有未合入集成分支的提交')
    expect(problems.join()).toContain('/wt/a')
  })

  it('release 抛异常不会打断整次重做', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs, log } = fakeFs()
    const { problems } = await commitRedo({
      fs, runDir: '/run', config: CONFIG, before,
      pool: { async release() { throw new Error('git 挂了') } },
    }, plan)
    expect(problems.join()).toContain('git 挂了')
    // 后面两步照做 —— 一个放不掉的工作区不该让整棵树留在半改状态。
    expect(log).toContain('unlink /run/root/00-a/node.md')
    expect(log.some(l => l.startsWith('write '))).toBe(true)
  })

  it('删不掉的 node.md 必须上屏,不能只写日志', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs } = fakeFs({ async unlink() { throw new Error('EACCES') } })
    const { problems } = await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    // 它会在下一次 --resume 时自己长回来,而用户是唯一能处理它的人。
    expect(problems.join()).toContain('下次恢复会复活它')
    expect(problems.join()).toContain('EACCES')
  })

  it('写不下去的节点也要上屏 —— 否则这次重做下次恢复时整个消失', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root/00-a', 'execute', 'T1'))
    const { fs } = fakeFs({ async writeFile(p) { if (p.endsWith('node.md')) throw new Error('ENOSPC') } })
    const { problems } = await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    expect(problems.join()).toContain('下次恢复会读到旧状态')
  })

  it('删了子树但父节点写不回去:必须说清盘上现在是什么样', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs } = fakeFs({ async writeFile(p: string) { if (p.endsWith('node.md')) throw new Error('ENOSPC') } })
    const { problems } = await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    // 「读到旧状态」这句话在删过子树的情况下是**不完整**的,而不完整的那部分要命:
    // 盘上留着一个 childIds 指向一批不存在节点的父节点,下次 --resume 会以
    // 「子节点缺失」阻断,而用户按字面意思以为只是回到重做之前。
    expect(problems.join()).toContain('子节点缺失')
    expect(problems.join()).toContain('childIds')
  })

  it('没删过子树时不说那句 —— 别吓唬人', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root/00-a', 'execute', 'T1'))
    const { fs } = fakeFs({ async writeFile(p: string) { if (p.endsWith('node.md')) throw new Error('ENOSPC') } })
    const { problems } = await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    expect(problems.join()).not.toContain('子节点缺失')
  })
  it('没有隔离池时不报任何工作区问题', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root', 'plan', 'T1'))
    const { fs } = fakeFs()
    const { problems } = await commitRedo({ fs, runDir: '/run', config: CONFIG, before }, plan)
    // 这次 run 本来就没隔离,不是「释放失败」。
    expect(problems.filter(p => p.includes('工作区'))).toEqual([])
  })

  it('一切正常时 problems 是空的', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root/00-a', 'execute', 'T1'))
    const { fs } = fakeFs()
    const { problems } = await commitRedo({
      fs, runDir: '/run', config: CONFIG, before,
      pool: { async release() { return { removed: true } } },
    }, plan)
    expect(problems).toEqual([])
  })

  it('run.md 写失败只进日志,不当成问题上屏', async () => {
    const before = TREE()
    const plan = ok(planRedo(before, 'root/00-a', 'execute', 'T1'))
    const errs: Error[] = []
    const { fs } = fakeFs({
      async writeFile(p) { if (p.endsWith('run.md')) throw new Error('run.md 写不动') },
    })
    const { problems } = await commitRedo(
      { fs, runDir: '/run', config: CONFIG, before, onError: e => errs.push(e) }, plan,
    )
    // run.md 是给人看的清单,节点自己的 node.md 才是恢复用的真相 —— 它写不下去
    // 不影响这次重做能不能被恢复,所以不占用户的注意力。
    expect(problems).toEqual([])
    expect(errs.map(e => e.message)).toContain('run.md 写不动')
  })
})
