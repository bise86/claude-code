/**
 * 「先把用户没提交的东西收起来,做完再原样放回去」。
 *
 * ## 为什么是一个独立原语,而不是在合并那一处内联
 *
 * 需要它的地方不止一处(收口那一跳、`m` 键那一跳,以后还会有),而这条路上**每一种失手
 * 方式都会真的弄丢用户的工作**。内联写三份的结局在这个仓库里见过:活着的那一份总会先
 * 退化,而这一份退化的代价是「他改了一天的东西没了」。
 *
 * ## 圆桌评审在真 git 上打掉的两条机制(它们看起来都很合理)
 *
 *  1. **`git stash pop <sha>` 不存在。** git 明确拒绝:`error: '95976a4b…' is not a stash
 *     reference`,`git stash drop <sha>` 同样被拒。能接受 sha 的只有 `git stash apply`。
 *     所以 pop 之前必须**现场**把 sha 解析成 `stash@{n}`(`git stash list --format='%H %gd'`),
 *     而且要在 pop 的**那一刻**解析 —— 中途有别的东西 stash 的话下标会漂移。
 *  2. **「push 之后记下 `refs/stash`」在最该管用的场景里失效。** `git stash push` 无事可做
 *     时退出码是 **0**(`No local changes to save`),而 `refs/stash` 这时指向的是**用户
 *     自己那条 stash**。判据与按键之间隔着一屏确认(分钟级窗口),用户完全可能在这期间
 *     提交或撤销了改动 —— 于是「我们那一条」其实是他的,后面一 pop:内容被应用进工作区、
 *     条目被 `Dropped`。判据必须是**前后比较**:`BEFORE !== AFTER` 且 `AFTER` 非空。
 *
 * ## 另外三条同样是实测出来的
 *
 *  - **冲突态下 `stash push` 本身就失败**(`could not write index / needs merge`,退出码 1,
 *    一条都没建)。所以有 `MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD` 时这一档
 *    **不许出现** —— 那时屏幕该说的是「你正卡在一次没做完的合并里」。
 *  - **半合并态下 pop 必然失败**,得先 `merge --abort`。而合并失败**也要** pop 回来:
 *    否则用户的改动停在一个他没主动创建的 stash 里,而屏幕正在讲合并失败。
 *  - **耐久备份**:`git stash create` 给出 sha 且不动工作区,`update-ref` 把它钉住 ——
 *    之后即使条目被误 drop、被 gc,东西还在。成功路径上再删掉它。
 *
 * ## 未跟踪文件:不加 `-u`,而且不要复用 `utils/git.ts` 的 `stashToCleanState`
 *
 * `/et` 自己就往用户检出里写 `.claude/efftask/`,`-u` 会把它卷进 stash。而
 * `stashToCleanState` 比 `-u` 还糟:它先 `git add <untracked>` 再 stash,等于把用户的
 * 未跟踪文件塞进索引再打包带走。
 */

/** 跑一条 git 命令。和仓库其余各处同一个形状。 */
export interface StashGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface StashGuardDeps {
  git: StashGit
  /** 在**哪棵树**上 stash。永远是用户自己的检出,不是任何节点工作区。 */
  cwd: string
  /** 备份 ref 的名字要能认出是哪一趟留下的。 */
  runId: string
  /** 进度播报(可选)—— 这几步各自都可能卡住几秒。 */
  onProgress?: (s: string) => void
}

/** 这一档现在能不能提供给用户。 */
/**
 * 这一档现在能不能提供。**一个形状,不是可辨识联合** —— 这个仓库的 tsc 解析在联合收窄上
 * 本来就不可靠(全仓基线里同类报错上千条),而为了绕开它去写类型断言,等于把一个纯粹的
 * 工具类型变成噪声源。`why`/`hint` 只在 `available === false` 时有值。
 */
export interface StashAvailability {
  available: boolean
  /** 照着说给用户听的原话。 */
  why?: string
  /** 他能照做的下一步。 */
  hint?: string
}

/** ref、说给用户听的名字、以及**收拾它要用的子命令**(三者必须配套,见收尾那一段)。 */
const IN_PROGRESS: readonly [string, string, string][] = [
  ['MERGE_HEAD', '一次没做完的合并', 'merge'],
  ['REBASE_HEAD', '一次没做完的 rebase', 'rebase'],
  ['CHERRY_PICK_HEAD', '一次没做完的 cherry-pick', 'cherry-pick'],
  ['REVERT_HEAD', '一次没做完的 revert', 'revert'],
]

/**
 * 现在提供这一档合不合适。
 *
 * **不是「脏不脏」** —— 脏是调用方自己判的(它才知道这次要做什么)。这里回答的是
 * 「按下去会不会当场失败」,而唯一会当场失败的形态是仓库正卡在一次没做完的操作里。
 */
export async function stashAvailability(deps: StashGuardDeps): Promise<StashAvailability> {
  for (const [ref, what, cmd] of IN_PROGRESS) {
    const r = await deps.git(['rev-parse', '-q', '--verify', ref], deps.cwd)
    if (r.code === 0) {
      return {
        available: false,
        why: `你正卡在${what}里 —— 这种状态下 git 连 stash 都做不了(索引写不出去)`,
        hint: `先把它解决掉(git status 看冲突文件),或者 git ${cmd} --abort 回到之前的状态`,
      }
    }
  }
  return { available: true }
}

export interface StashOutcome<T> {
  /**
   * **这一档自己失败了**(不是「没什么可 stash」)。
   *
   * 调用方据此决定要不要退回「不带保护直接做」—— 树本来就干净时那样做是对的,而
   * 「git 拒绝了 / 卡在一次没做完的操作里」时那样做等于把用户明确要的保护静默取消。
   */
  failed?: boolean
  /** 被包住的那件事的返回值。没跑成(前置失败)时缺席。 */
  result?: T
  /** 改动是不是已经原样回到工作区了。 */
  restored: boolean
  /** 照着说给用户听的话。**一条都不许吞** —— 这条路上每一句都对应一次真实的盘上状态。 */
  lines: string[]
  /** 备份 ref(还在的话)。撞冲突时用户要靠它。 */
  backupRef?: string
  /** 我们那条 stash 现在的下标(还在的话)。 */
  stashEntry?: string
}

const MSG = {
  nothingToStash: '没有执行:准备 stash 时你的工作区已经不脏了(可能你刚提交或撤销了改动)。'
    + '**没有创建任何 stash,也没有动你已有的 stash。**请重新按一次。',
} as const

/**
 * 把 `fn` 包在一次 stash / pop 之间。
 *
 * 契约:**只要走到了 stash 这一步,就一定会尝试把它放回去** —— 无论 `fn` 成功、失败、
 * 还是抛异常。放不回去时(撞冲突)也绝不吞:改动同时留在 stash 条目和备份 ref 两处,
 * 而两处的取回命令都会写进 `lines`。
 */
export async function withStash<T>(
  deps: StashGuardDeps, fn: () => Promise<T>,
): Promise<StashOutcome<T>> {
  const { git, cwd, runId } = deps
  const lines: string[] = []
  /**
   * **备份 ref 的名字必须带上内容的 sha,不能只带 runId。**
   *
   * 验收席在真 git 上复现的 P0:同一趟 run 里每次按键都是同一个名字,`update-ref` 覆盖时
   * 退出码 0、一个字都不说。而这一档最典型的用法恰恰会连按两次 —— 第一次 pop 撞冲突,
   * 屏幕告诉用户「解完冲突后 `git stash drop`,备份仍在」;他照做之后**全世界只剩这一份
   * 备份**;他继续改、再按一次 `m`+`s`,第二次的 `update-ref` 把它悄悄覆盖掉,而成功路径
   * 上的 `update-ref -d` 又把它删了 —— 一整天的工作变成不可达对象,然后被 gc 掉。
   */
  let backupRef = `refs/et/stash-backup/${runId}`

  const avail = await stashAvailability(deps)
  if (!avail.available) {
    return {
      failed: true, restored: true,
      lines: [...(avail.why ? [avail.why] : []), ...(avail.hint ? [avail.hint] : [])],
    }
  }

  /**
   * 耐久备份。**先于 push** —— `stash create` 只是造一个提交对象,不动工作区,所以它
   * 失败了也什么都没发生;而 push 之后再造就来不及了(那时工作区已经干净)。
   */
  deps.onProgress?.('把你的改动先备份一份…')
  const created = await git(['stash', 'create'], cwd)
  const bak = created.stdout.trim()
  /**
   * **失败和「没什么可 stash」是两件事,退出码分得开。**
   *
   * 干净树:退出码 0 且输出空 —— 那是「没什么可 stash」。
   * 而 `Cannot save the current index state`(刚被自己 pop 冲突留下的 `UU` 态)、
   * `You do not have the initial commit yet`(空仓)都是**退出码 1**。上一版把它们一律
   * 说成「你的工作区已经不脏了」,把 git 的真实原因吞掉,而调用方随后会在**没有任何
   * 保护**的情况下把合并跑掉。
   */
  if (created.code !== 0) {
    return {
      failed: true,
      restored: true,
      lines: [
        `没有执行:准备备份你的改动时 git 拒绝了 —— ${oneLine(created.stderr) || `退出码 ${created.code}`}`,
        '先把工作区收拾到一个 git 能操作的状态(git status 看看),再按一次。',
      ],
    }
  }
  if (bak.length === 0) {
    return { restored: true, lines: [MSG.nothingToStash] }
  }
  backupRef = `refs/et/stash-backup/${runId}/${bak.slice(0, 12)}`
  const ref = await git(['update-ref', backupRef, bak], cwd)
  if (ref.code !== 0) {
    return {
      restored: true,
      lines: [`没有执行:备份你的改动失败(${oneLine(ref.stderr) || `退出码 ${ref.code}`})—— 什么都没动。`],
    }
  }

  const before = await stashTip(git, cwd)
  deps.onProgress?.('收起你未提交的改动…')
  const push = await git(['stash', 'push', '-m', `et: 自动 stash(${runId})`], cwd)
  const after = await stashTip(git, cwd)
  /**
   * **判据是「多了一条」,不是「退出码为 0」。** 无事可做时 push 也返回 0,而这时
   * `after === before`(甚至指向用户自己那条)—— 那种情况下再 pop 就是弹别人的东西。
   */
  /**
   * **变异复验说明**:单独把 `after === before` 去掉打不红任何探针 —— 因为上面那次
   * `stash create` 已经先把「树其实不脏」拦掉了(干净树时它输出空)。两道是**纵深**,不是
   * 重复:圆桌评审量到的失效场景发生在没有 `create` 那一步的设计里,而这一条保证的是
   * 「即使将来有人把 create 那步挪走,也不会去 pop 用户自己那条 stash」。
   */
  if (push.code !== 0 || after === undefined || after === before) {
    const cur0 = await git(['rev-parse', '--verify', '--quiet', backupRef], cwd)
    if (cur0.stdout.trim() === bak) await git(['update-ref', '-d', backupRef], cwd)
    return {
      failed: push.code !== 0,
      restored: true,
      lines: push.code !== 0
        ? [`没有执行:收起改动失败(${oneLine(push.stderr) || `退出码 ${push.code}`})—— 什么都没动。`]
        : [MSG.nothingToStash],
    }
  }

  /**
   * **改名成「按 stash 条目的 sha」。**
   *
   * `stash create` 和 `stash push` 造的是**两个不同的 commit** —— 回收那一侧要问的是
   * 「那条 stash 条目还在不在」,所以 ref 名里必须是**条目**的 sha,不是备份对象的。
   *
   * 先按备份 sha 写、再改名:两步之间工作区还没被动过(动它的是 push),所以那个窗口里
   * 即使崩了也没有东西可丢;而反过来(等条目 sha 出来再写)会让 push 之后有一小段
   * 完全没有备份的时间。
   */
  const entryRef = `refs/et/stash-backup/${runId}/${after.slice(0, 12)}`
  if (entryRef !== backupRef) {
    const moved = await git(['update-ref', entryRef, bak], cwd)
    if (moved.code === 0) {
      await git(['update-ref', '-d', backupRef, bak], cwd)
      backupRef = entryRef
    }
  }

  let result: T | undefined
  let threw: unknown
  try {
    result = await fn()
  } catch (e) {
    threw = e
  }

  /**
   * **无论如何都要收拾现场再 pop。** 合并撞冲突会留下 `MERGE_HEAD`,而那时 pop 必然
   * 失败(`could not write index / needs merge`)。abort 的成败不看退出码 —— 没有合并在
   * 进行时它本来就非零;看**收拾完之后现场还在不在**。
   */
  /**
   * **按操作类型 abort。** 上一版对 rebase / cherry-pick / revert 一律发 `merge --abort`,
   * 治不了 —— 实测 `.git/rebase-merge` 原样留着、`UU` 也还在,而屏幕却说「合并做完了」。
   */
  for (const [r, , cmd] of IN_PROGRESS) {
    if ((await git(['rev-parse', '-q', '--verify', r], cwd)).code === 0) {
      await git([cmd, '--abort'], cwd)
      break
    }
  }

  deps.onProgress?.('把你的改动放回去…')
  const entry = await entryFor(git, cwd, after)
  if (entry === undefined) {
    // 有人在这中间把我们那条 drop 了 —— 备份 ref 就是为这一刻留的。
    const applied = await git(['stash', 'apply', backupRef], cwd)
    lines.push(applied.code === 0
      ? '你的改动已经从备份恢复(中途那条 stash 条目不见了)。'
      : `**你的改动没能自动放回来**:stash 条目不见了,而从备份恢复也失败了(${oneLine(applied.stderr)})。`)
    lines.push(`备份仍在:git stash apply ${backupRef}`)
    return { restored: applied.code === 0, lines, backupRef, ...(threw ? {} : { result: result as T }) }
  }
  /**
   * **`pop --index` 先试**:裸 pop 会把「暂存 / 未暂存」的划分拍平(实测 `M ` 变成 ` M`),
   * 而用户可能是 `git add -p` 一块一块挑出来的 —— 那份工作不可逆地没了,而屏幕说的是
   * 「原样放回」。`--index` 在同一路径既有暂存又有工作区改动时会失败,那时退回裸 pop
   * (内容仍然完整,只是划分丢了),并把这件事说出来。
   */
  let pop = await git(['stash', 'pop', '--index', entry], cwd)
  let flattened = false
  if (pop.code !== 0) {
    const retry = await git(['stash', 'pop', entry], cwd)
    if (retry.code === 0) { flattened = true }
    pop = retry.code === 0 ? retry : pop
  }
  if (pop.code === 0) {
    // **只删自己写进去的那一个。** ref 名带 sha,再比对一次:别人同名写过就不动它。
    const cur = await git(['rev-parse', '--verify', '--quiet', backupRef], cwd)
    if (cur.stdout.trim() === bak) await git(['update-ref', '-d', backupRef], cwd)
    if (flattened) {
      lines.push('注意:你的改动回来了,但**暂存 / 未暂存的划分被拍平了**(同一个文件两边都有改动时 git 还原不了索引)。')
    }
    lines.push('你未提交的改动已经原样放回工作区。')
    if (threw) throw threw
    return { restored: true, lines, result: result as T }
  }

  /**
   * pop 撞冲突。**改动一个字节都没丢**,而且同时在两个地方 —— 但工作区现在带着冲突
   * 标记,再 pop 一次会失败(和冲突态下 push 同一个原因)。这三句都要说全。
   */
  lines.push('合并做完了,但把你的改动放回来时**撞了冲突** —— 你的改动一个字节都没丢,两处都在:')
  lines.push(`  · stash 条目:${entry}(git stash list 看得到,消息是「et: 自动 stash(${runId})」)`)
  lines.push(`  · 备份 ref:${backupRef}`)
  lines.push('工作区现在有冲突标记(git status 会显示 UU/AA),**在这个状态下再 pop 一次会失败**。')
  lines.push(`解完冲突后丢掉那条:git stash drop ${entry}`)
  lines.push(`想推倒重来:git reset --hard && git stash apply ${backupRef}`)
  if (threw) throw threw
  return { restored: false, lines, backupRef, stashEntry: entry, result: result as T }
}

/** `refs/stash` 现在指向谁。没有 stash 时返回 undefined(而不是让 git 往 stderr 吐 fatal)。 */
async function stashTip(git: StashGit, cwd: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--verify', '--quiet', 'refs/stash'], cwd)
  const sha = r.stdout.trim()
  return r.code === 0 && sha.length > 0 ? sha : undefined
}

/**
 * sha → `stash@{n}`。**必须在 pop 的那一刻算** —— 中途有别的东西 stash 的话下标会漂移
 * (实测:我们那条从 `stash@{0}` 变成 `stash@{1}`,而裸 `git stash pop` 会弹掉别人的)。
 */
async function entryFor(git: StashGit, cwd: string, sha: string): Promise<string | undefined> {
  const r = await git(['stash', 'list', '--format=%H %gd'], cwd)
  if (r.code !== 0) return undefined
  for (const line of r.stdout.split('\n')) {
    const [h, gd] = line.trim().split(/\s+/)
    if (h === sha && gd) return gd
  }
  return undefined
}

const oneLine = (s: string): string => s.trim().split('\n').filter(Boolean).slice(0, 2).join('; ')

/**
 * **备份 ref 的回收。**
 *
 * 这些 ref 是 `withStash` 留下的耐久备份(见文件头)。成功路径上它当场就删了,留下来的
 * 只有一种:**pop 撞冲突**那一次 —— 那时用户的改动同时在 stash 条目和这个 ref 上,而屏幕
 * 让他二选一去取。问题是取完之后没人清:每一次失败的按键永久留下一个 ref + 一个 commit
 * 对象,而它们还会把那批对象一直挡在 gc 之外。
 *
 * 判据是**「那次撞冲突处理完了没有」**,不是时间、也不是数量:
 *
 *  · stash 列表里还有同 sha 的条目 → **他还没处理完**,留着(这正是备份存在的那一刻);
 *  · 列表里没有了 → 要么已经 pop 回去(那时我们自己就删了)、要么他解完冲突后
 *    `git stash drop` 了 —— 两种都意味着这份备份的使命结束。
 *
 * 判据只看**本 run** 的 ref:别的 run 可能还开着,替它做决定不是这里的事。
 */
export async function sweepStashBackups(
  deps: Pick<StashGuardDeps, 'git' | 'cwd' | 'runId'>,
): Promise<{ removed: string[]; kept: { ref: string; why: string }[] }> {
  const { git, cwd, runId } = deps
  const removed: string[] = []
  const kept: { ref: string; why: string }[] = []
  const listed = await git(['for-each-ref', '--format=%(refname) %(objectname)', `refs/et/stash-backup/${runId}`], cwd)
  if (listed.code !== 0) return { removed, kept }
  /**
   * 现存 stash 条目的**内容指纹**(tree),不是它们的 commit sha —— `stash create` 和
   * `stash push` 对同一批改动造出的是两个不同的 commit,而它们的 tree 相同。
   */
  const stashTrees = new Set(
    (await git(['stash', 'list', '--format=%T'], cwd)).stdout.split('\n').map(l => l.trim()).filter(Boolean),
  )
  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(/\s+/)
    if (!ref || !sha) continue
    /**
     * **判据落在「这份备份的内容还需不需要」上,而不是 ref 的名字。**
     *
     * 名字里那一段本该是 stash 条目的 sha 前缀,但它靠一次**尽力而为**的改名写上去
     * (`update-ref` 失败就静默保留旧名),而且 P0 修复之前的旧格式 ref 压根没有这一段。
     * 评审席在真 git 上复现:两种情况下 sweep 都会把**还活着的**备份直接删掉 —— 而屏幕
     * 刚让用户敲 `git stash apply <那条 ref>`。
     *
     * 新判据用**内容**:备份对象的 tree 只要和任何一条现存 stash 条目的 tree 相同,
     * 就说明那次撞冲突还没处理完(条目还在),留着。名字对不上也不影响。
     */
    const mine = (await git(['rev-parse', `${sha}^{tree}`], cwd)).stdout.trim()
    if (mine.length > 0 && stashTrees.has(mine)) {
      kept.push({ ref, why: '那一次 pop 撞了冲突,而对应的 stash 条目还在 —— 你还没处理完它' })
      continue
    }
    // **按 sha 删**,不按名字:两次之间有人往同名 ref 上写过东西的话,删的就不是我们看到的那个。
    const del = await git(['update-ref', '-d', ref, sha], cwd)
    if (del.code === 0) removed.push(ref)
    else kept.push({ ref, why: `删不掉(${oneLine(del.stderr) || `退出码 ${del.code}`})` })
  }
  return { removed, kept }
}
