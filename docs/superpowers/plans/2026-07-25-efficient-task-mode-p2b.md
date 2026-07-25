# 高效任务模式 — P2b worktree 隔离与集成 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让每个可执行节点在自己的 git worktree 里执行,验收通过后合并回本 run 的集成分支,全部完成后把集成分支交给用户处置。隔离到位后解除 `execute` 的串行锁,兑现"各任务执行可以并行,默认5个"的后半句。

**Architecture:** Run 启动时建集成分支 `efftask/<runId>/integration`(从 HEAD)。每个可执行节点进入执行前,从**集成分支当前状态**开一个 worktree;执行、验收都在该 worktree 内进行;验收通过后由一个**专用的集成 worktree**(绝不碰用户的检出)串行合并回集成分支。冲突先自动解决一次,仍失败则升级人工(飞书卡片)并保留 worktree。

## 本文档的由来(勿删)

P2 v1 的隔离部分被三方圆桌评审否决,其中**隔离相关 14 条阻断多数在一次性 git 仓库里实际复现**。下面每一条"必须"都对应一个已复现的失败,不是风格偏好。

---

## 已复现的失败(实现者必读,每条都要有对应测试)

| # | 失败 | 证据 |
|---|---|---|
| F1 | **slug 对几乎所有真实节点非法** | `validateWorktreeSlug` 每个 `/` 分段只允许 `[a-zA-Z0-9._-]`、全长 ≤64。`root/01-建表` 抛错;三层英文节点 94 字符抛错。**而 v1 指定的验收用例 `root/01-x` 恰是唯一能过的形状** —— 会在功能彻底失效时亮绿灯 |
| F2 | **合并丢工作并报成功** | 执行者从不提交(`executePrompt` 没要求),worktree 脏但零提交 → `hasWorktreeChanges` 为真 → `git merge` 打印 "Already up to date" 退出 0 → 判成功 → `release` 用 `--force` 删 worktree → **改动在所有 ref 中消失**,节点 ACCEPTED、run 报 completed。**这是默认路径** |
| F3 | **验收看不见被验收的工作** | `runRoundtable` 构造请求**不带 cwd**,只有 execute 阶段传 worktree 路径。验收角色读的是主工作树,只能照 `execStatus` 自述盖章 |
| F4 | **worktree 基线是 `origin/<默认分支>`** | `createAgentWorktree` 无 base 参数。从 `feature/mine` 检出时,执行者的 worktree 里既没有用户的新文件也没有其改动;且节点**永远看不到依赖节点已合并的产出** |
| F5 | **在主检出上合并会污染用户工作区** | `git checkout efftask/001` 会把用户未提交的改动一起带到集成分支上;冲突还会在**用户的检出**里留下 `MERGE_HEAD` 与冲突标记 |
| F6 | **互斥锁按配置判定,隔离按运行时判定** | 配置写 `worktree` → 锁解除;`acquire` 因 F1 对每个节点都返回 null → **N 个带写权限的执行者同时在用户真实工作树上开工**,各自报成功 |
| F7 | **绝对路径与 MCP 穿透隔离** | `runWithCwdOverride` 只改相对路径解析;plan 阶段无 cwd,`plan.solution` 常含主仓绝对路径;MCP 工具是进程外的,完全无视 AsyncLocalStorage |
| F8 | **续跑会把执行者放回用户真实仓库** | `node.worktree` 会随 `serializeNode` 往返,但校验/归位从不读它。中断后 worktree 已被删,续跑时 `cwd` 指向不存在的路径,`Shell.exec` **静默回退到 `getOriginalCwd()`** |
| F9 | **冲突阻断的节点是死局** | `blockWithReason` 设 `interrupted = signal.aborted` = false,`reseat` 每次续跑都跳过它;保留的 worktree 也不匹配 `EPHEMERAL_WORKTREE_PATTERNS`,永远不被清理 |
| F10 | **`dispose` 会销毁真实工作** | `removeAgentWorktree` 是 `--force`;对 BLOCKED / 预算耗尽 / 被中断的节点,`node.md` 还描述着那些改动,盘上已被删 |
| F11 | **`merge()` 缺基础设施错误档** | 每个非冲突的 git 失败(index.lock 争用、分支缺失、磁盘)都会被报成"冲突"并伪造文件列表 |
| F12 | **hook 型 worktree 没有分支** | `createAgentWorktree` 的 `worktreeBranch` 可选;hook 型无分支,`git merge <undefined>` 会让每个 hook-VCS 用户的节点被误判为冲突 |
| F13 | **spec §8 被静默削减** | 集成分支创建、冲突的**一次自动解决**、飞书升级卡、收口、非 git 时**让用户选择**,v1 全丢,还引用误读的 §16 当依据 |

---

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json`,不引入 `env:` 间接、不脱敏。
- **宁可不隔离,不可假隔离。** 任何一步拿不到真 worktree,整个 run 必须降级为串行执行并如实告知;**绝不允许**"配置说隔离了、实际在用户工作树上并发写"。
- **宁可保留垃圾,不可删掉工作。** 任何 `--force` 删除前必须先确认该 worktree 干净。
- **合并成功必须有正面证据**(集成分支多了一个提交),不能以退出码 0 为准 —— F2。
- 验收必须能**读到**它要验收的东西 —— F3。
- 断点续跑必须继续可用:`node.worktree` 是可能失效的磁盘引用,恢复路径必须校验它。

---

## Task 21: worktree 身份与生命周期(纯逻辑,不碰真 git)

**Files:** `src/tools/efftask/worktreeId.ts` + 测试

```ts
/** runId + node.id → 一个一定合法的 worktree slug。 */
export function worktreeSlug(runId: string, nodeId: string): string
export function integrationBranch(runId: string): string
```

slug **不得**从标题或节点 id 直接派生(F1)。取 `efftask-<runId>-<sha256(nodeId) 前 8 位十六进制>`:恒为 `[a-z0-9-]`、恒 ≤ 32 字符、对同一节点稳定(续跑要能重新找到)、不同节点碰撞概率可忽略。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'bun:test'
import { worktreeSlug, integrationBranch } from './worktreeId.js'
import { validateWorktreeSlug } from '../../utils/worktree.js'
import { childId } from './persistence.js'

describe('worktreeSlug is legal for nodes that actually occur', () => {
  it('accepts Chinese titles and deep nesting — the shapes that made v1 throw', () => {
    // validateWorktreeSlug allows only [a-zA-Z0-9._-] per '/'-segment, max 64 chars total.
    // v1 derived the slug from runId + node.id, so `root/01-建表` threw — and its own
    // acceptance case `root/01-x` was the ONE shape that passed, i.e. it would have gone
    // green over a total failure.
    const deep = childId(childId(childId('root', 1, '建表'), 2, 'write integration tests for the endpoint'), 3, '压测')
    for (const id of ['root', 'root/01-建表', deep, 'root/01-' + 'x'.repeat(200)]) {
      const slug = worktreeSlug('001', id)
      expect(() => validateWorktreeSlug(slug)).not.toThrow()
      expect(slug.length).toBeLessThanOrEqual(64)
    }
  })

  it('is stable for the same node and distinct across nodes', () => {
    // Stability is load-bearing: resume must find the same worktree again.
    expect(worktreeSlug('001', 'root/01-建表')).toBe(worktreeSlug('001', 'root/01-建表'))
    expect(worktreeSlug('001', 'root/01-a')).not.toBe(worktreeSlug('001', 'root/02-a'))
    expect(worktreeSlug('001', 'root/01-a')).not.toBe(worktreeSlug('002', 'root/01-a'))
  })

  it('integration branch is per-run', () => {
    expect(integrationBranch('003')).toBe('efftask/003/integration')
  })
})
```

- [ ] **Step 2-4:** 跑红 → 实现(用 `node:crypto` 的 `createHash('sha256')`)→ 跑绿 → 提交。

---

## Task 22: `worktreePool`(注入 git 执行器,不碰真仓库)

**Files:** `src/tools/efftask/worktreePool.ts` + 测试

```ts
export interface GitRunner {
  (args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>
}
export interface Lease {
  path: string; branch: string; headCommit: string; gitRoot: string; hookBased: boolean
}
export type MergeResult =
  | { ok: true; merged: boolean }                     // merged=false 表示该节点没有产出
  | { ok: false; kind: 'conflict'; files: string[] }
  | { ok: false; kind: 'infra'; message: string }     // F11:非冲突失败不得伪装成冲突

export interface WorktreePool {
  init(): Promise<{ ok: true } | { ok: false; reason: string }>  // 建集成分支 + 集成 worktree
  acquire(node: TaskNode): Promise<Lease | null>                 // null = 隔离不可用
  commitAndMerge(node: TaskNode): Promise<MergeResult>
  release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }>
  dispose(): Promise<{ kept: { path: string; why: string }[] }>
}
```

**每条规则都对应一个已复现的失败:**

1. `init()` 从 HEAD 建 `efftask/<runId>/integration`,并为它开一个**专用集成 worktree**。所有合并都在该 worktree 内执行 —— **绝不 `git checkout` 用户的检出**(F5)。
2. `acquire()` 先 `createAgentWorktree(slug)`,再在该 worktree 内 `git checkout -B <wtBranch> <integrationBranch>`,把基线换成集成分支当前状态(F4)。失败返回 `null`,**不抛**。
3. `acquire()` 返回**完整**租约:`headCommit`(`hasWorktreeChanges` 要)、`gitRoot`(`removeAgentWorktree` 缺了它会静默失败并泄漏)、`hookBased`。**hook 型无分支 → 直接返回 null**,该 run 降级(F12)——不要试图合并一个 undefined 分支。
4. `commitAndMerge()`:先在 worktree 内 `git add -A && git commit`(执行者不会自己提交,F2);无改动则返回 `{ok:true, merged:false}` 并**跳过合并**;有改动则在集成 worktree 内合并,并**核对集成分支的 HEAD 确实前进了**才算成功。
5. 合并冲突 → `{kind:'conflict', files}`,并 `git merge --abort` 清理集成 worktree;其它非零退出 → `{kind:'infra'}`(F11)。
6. `release()` 只在**合并成功**后删;删前再查一次 `hasWorktreeChanges`,脏则保留并说明原因(F10)。
7. `dispose()` 逐个查干净才删,保留清单返回给调用方展示(F10)。

- [ ] Step 1-10:测试先行,注入假 `GitRunner` 与假 worktree 函数。**必测**:F1 的中文/深层 id、F2 的"未提交即合并"(断言 `merged` 与集成分支 HEAD 前进)、F4 的基线换到集成分支、F10 的脏 worktree 不删、F11 的 infra 与 conflict 分档、F12 的 hook 型返回 null。

---

## Task 23: 接线到编排(隔离真正生效)

**Files:** `orchestrator.ts`、`pipeline.ts`、`roundtable.ts`、`types.ts`、`efftask.tsx`

1. **执行前 acquire,写入 `node.worktree`**;`stepExecute` 已经在读 `node.worktree?.path` 当 cwd。
2. **验收也要拿到 cwd**(F3):`runRoundtable` 增 `cwd?`,`accept` 阶段对可执行节点传 worktree 路径。否则验收角色读的是主工作树,只能照自述盖章。
3. **提示词注入 worktree 告示**(F7):照 `forkSubagent.ts` 的 `buildWorktreeNotice` 做一份,告诉执行者它的工作目录已经变了、方案里的绝对路径需要换算。**同时在文档里写明:MCP 工具是进程外的,不受 cwd 覆盖约束 —— 这是隔离的已知漏洞,不是可以假装不存在的。**
4. **验收通过 → `commitAndMerge`**;成功 → ACCEPTED + `release`;冲突 → 见 Task 24;infra → 按基础设施失败重试,**不当作冲突**。
5. **互斥锁按运行时判定**(F6):只有 `acquire` 真的拿到租约的节点才允许并发执行;**第一个 `acquire` 返回 null 就把整个 run 降级为串行**,且在此之前不得有第二个执行者启动。
6. `EffTaskConfig.isolation: 'worktree' | 'none'`,由 `init()` 的实际结果决定,不是用户随便声明的。

---

## Task 24: 冲突处理与人工升级(spec §8 原文)

1. 冲突 → **先自动解决一次**:由该节点的 execute 角色在 worktree 内解决冲突并重跑验收(spec §8 明确要求;§16 的"不追求全自动"指不保证无冲突,**不等于取消这一次尝试** —— v1 引用误读的 §16 把它删了)。
2. 仍失败 → 升级人工:**飞书卡片**,节点标 BLOCKED,`blockedReason` 必须带上 **worktree 路径、分支名、冲突文件列表**,否则用户无从下手。
3. **冲突阻断的节点必须可恢复**(F9):`TaskNode` 增 `conflict?: { path: string; branch: string; files: string[] }`;`reseat` 见到它时**不重开**(人还没处理),但恢复关口要把它列出来,并提供"我已手工解决,续跑时重试合并"的入口。
4. 保留的 worktree 要能被清理:登记到一个 run 级清单里,`dispose` 与收口时展示。

## Task 25: 收口(spec §8 最后一条)

全部 ACCEPTED 后,集成分支交给用户:复用 `superpowers:finishing-a-development-branch` 的四选项(合回当前分支 / 建 PR / 保留 / 丢弃)。**默认不直接改用户当前工作区。** 缺了这一步,用户跑完一整个 run 在自己的工作区里看不到任何改动,而且没有任何地方告诉他东西在哪(v1 就是这样)。

## Task 26: 非 git 仓库 → 让用户选择(spec §8 最后一条)

启动时检测。非 git 仓库 → 关口提示"需要 git 仓库以隔离并行执行",给出选项:**改用共享工作目录串行执行** / 先 `git init` / 取消。v1 改成静默自动降级,那是未经认可的规格变更。

## Task 27: 续跑路径校验 worktree(F8)

`validateLoadedNodes` 增:`node.worktree` 存在但路径已不存在 → 清空该字段并记 repair。否则续跑时 `cwd` 指向已删目录,`Shell.exec` **静默回退到用户真实仓库**,而 `node.md` 还宣称隔离中。必测:worktree 路径不存在的节点被归位后不带陈旧 cwd。

---

## Self-Review

- spec §8 五条(集成分支 / 每节点 worktree / 合并回收 / 冲突升级 / 收口 / 非 git 选择)→ Task 22-26,逐条对应。
- 用户"各任务执行可以并行"的后半句 → Task 23 第 5 点。
- **已知且不打算解决的漏洞(必须写进文档与代码注释,不得假装隔离是完备的)**:MCP 工具进程外执行,不受 cwd 覆盖;执行阶段的工具池是完整的 `context.options.tools`,含父级 MCP 工具。要真正封死需要按工具来源过滤,超出本期范围。
- 本期不做:P1 交接清单的启动第 3 关、后台任务注册、飞书推进 surface、跨分支依赖调度。
