/**
 * 员工上下文窗口的**自适应上界** —— 从跑动中学到的那个数,而不是用户声明的那个。
 *
 * ## 为什么需要它
 *
 * `roleClientConfig.contextWindow` 是**用户写在 settings 里的一句声明**,而压缩阈值、
 * 封顶闸全按它算。声明对了皆大欢喜;声明大了,阈值就坐在对面真实上限的**外面** ——
 * 自动压缩永远够不着,直到上游回一个 400,而这个 fork 里 `feature('REACTIVE_COMPACT')`
 * 是 false、`reactiveCompact.ts` 根本不存在,撞上去之后那一席直接死掉。
 *
 * 而声明大了是**默认会发生**的事,不是意外:用户手上只有网关标称的窗口(「1M」),
 * 那个数不含系统提示词、工具 schema,也不含网关自己留给输出的那一段。2026-08-19 跑机
 * 那趟 run 的目标里逐字写着「所有用到的模型上下文均为 1MB,因此相关配置需调整为合适值」。
 *
 * ## 学什么:**只学上界,绝不拿下界冒充上界**
 *
 *  - 上游肯报 `N tokens > M maximum` 时(`errorDetails` 里),M 就是它的上限,直接用;
 *  - 不肯报时(第三方网关基本不报),退回**这次被拒绝的请求有多大**。它确实没被收下,
 *    所以是真实上限的上界;窗口取它之后阈值约等于 0.72×失败大小,下一次多半就过了,
 *    万一还超,再学一次更小的 —— 单调收敛,每一步都有一次真实观测背书。
 *
 * **不要用「上一次成功的请求有多大」。** 那是下界(它只证明上限 ≥ 那个数),拿下界当上界
 * 是把窗口往死里收。验收席实测过这条:上一轮响应小、而这一轮被一条几 MB 的工具产出撑爆时,
 * 一个 1M 的员工会被学成 5 万、夹到地板,而账本按员工名进程级共享、只减不增 ——
 * 于是**整趟 run 余下的所有节点**都按地板算,每一轮都在压缩。
 *
 * **不学我们自己判死的那一次。** 本地封顶闸(`query.ts`)在请求发出去之前就可能拦下
 * 一轮,那条消息和真拒收正文逐字相同(见 `errors.ts` 的 `LOCAL_CONTEXT_LIMIT_DETAIL`)。
 * 拿它去收窗口是自己咬自己:窗口收小 → 阈值降低 → 更早撞自己的闸 → 再收 —— 一条负反馈,
 * 几轮就把席位锁死在地板上。所以调用方**必须**先排除本地闸,判据见那个哨兵。
 *
 * ## 为什么有地板
 *
 * **不是**因为阈值会算成负数 —— 保留额度和缓冲区现在都按比例夹(0.2 / 0.1),阈值恒等于
 * 0.72×窗口,再小也不为负(`autoCompact.ts` 那段注释说的是按比例夹**之前**的世界)。
 *
 * 理由只有一条:**一次偶然的观测不能有权把整个员工锁死一整趟 run**。上游把别的错误也写成
 * PTL、或者某一次请求恰好被一条巨大的工具产出撑爆 —— 都会产生一个不代表真实上限的观测,
 * 而这份账本只减不增、按员工名共享、进程内不可恢复。地板是它的止损位。
 */

/**
 * 学到的上界不许低于这个数。见文件头「为什么有地板」。
 *
 * **不要和 `roleContextWindow.ts` 的 `MIN_ROLE_CONTEXT_WINDOW`(8000)搞混:** 那个管的是
 * 「用户在 settings 里写的值合不合法」,这个管的是「一次观测能把窗口自动压到多低」。
 * 后者要严得多 —— 它没有人复核。
 */
export const MIN_LEARNED_CONTEXT_WINDOW = 40_000

/**
 * 学到的上界按**员工名**存,不按 agentId。
 *
 * 判据是「这个员工背后的那台模型能吃多少」,而那是员工级的事实:同一个员工会被几十个
 * 节点、几百次调用共用,按 agentId 存等于每个节点各自重新撞一次墙再各自学一遍。
 *
 * 进程级 module state:`/et` 的编排器和它所有席位跑在同一个进程里(子 agent 走
 * 同进程 `runAgent`),所以这一份就是整趟 run 的共享账本。进程退出即丢 —— 这是**对**的:
 * 换一台网关、改一次配置,上一趟学到的数就不再成立。
 */
const learned = new Map<string, number>()

/**
 * 记一次「上游收不下这么多」。
 *
 * 只往**小**里收(`Math.min`),不往大里放:一次成功不能证明上限变高了(它只证明那一次
 * 没超),而一次拒收确实证明了上限比那次请求小。放大要靠重启进程。
 *
 * @param roleName  员工名(`roleClientConfig.roleName`)
 * @param observed  上游报的上限 M,或者最后一次成功请求的大小
 * @returns 生效后的上界;`undefined` = 没记(参数不可用)
 */
export function noteUpstreamContextLimit(
  roleName: string | undefined,
  observed: number | undefined,
): number | undefined {
  if (roleName === undefined || roleName === '') return undefined
  if (
    observed === undefined ||
    !Number.isFinite(observed) ||
    observed <= 0
  ) {
    return undefined
  }
  const floored = Math.max(MIN_LEARNED_CONTEXT_WINDOW, Math.floor(observed))
  const prev = learned.get(roleName)
  const next = prev === undefined ? floored : Math.min(prev, floored)
  learned.set(roleName, next)
  return next
}

/**
 * 这个员工**实际**该按哪个窗口算 —— 声明值和学到的上界取小。
 *
 * 返回 `undefined` = 不干预(主循环没有 `roleClientConfig`,以及没声明又没学到的员工),
 * 这一点和 `roleContextWindow` / `roleWindowChars` 的约定逐字一致:调用方拿到 undefined
 * 就回落引擎自己那套算术,主循环的行为一个字节都不变。
 */
export function effectiveRoleContextWindow(
  cfg: { roleName?: string; contextWindow?: number } | undefined,
): number | undefined {
  if (cfg === undefined) return undefined
  const declared = cfg.contextWindow
  const observed = cfg.roleName === undefined ? undefined : learned.get(cfg.roleName)
  if (declared === undefined) return observed
  if (observed === undefined) return declared
  return Math.min(declared, observed)
}

/**
 * 清空账本。**只给探针用** —— 这是模块级状态,测试之间没有别的清法。
 *
 * 没有配套的「读」函数:想看某个员工学到了什么,用
 * `effectiveRoleContextWindow({ roleName })`(不传声明值时它返回的就是学到的那个数)。
 * 多一个只有测试在用的读函数,下一个人会以为生产代码里也该那么读。
 */
export function resetLearnedContextWindows(): void {
  learned.clear()
}
