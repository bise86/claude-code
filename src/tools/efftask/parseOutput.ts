// src/tools/efftask/parseOutput.ts
import type { NodeKind, NodePlan, Verdict } from './types.js'

/**
 * Fence tag each phase must wrap ITS ANSWER in. Generic ```json is reserved for
 * quoted context, so an answer is distinguishable from a recap of one.
 *
 * Selecting a block by "parses as JSON" or "is the newest" is not safe on its own.
 * Models echo the prompt before answering AND recap context after answering, and a
 * recap of a previous verdict has the same shape as this one's — so shape and
 * recency both mis-select it, silently turning a fail into a pass. The tag is what
 * actually separates answer from quotation.
 */
export const ANSWER_TAGS = { plan: 'plan', verdict: 'verdict', exec: 'exec', score: 'score', deps: 'deps', repair: 'repair' } as const
export type AnswerTag = (typeof ANSWER_TAGS)[keyof typeof ANSWER_TAGS]

/**
 * A per-call answer tag: the base tag plus random letters, e.g. `verdictqxrtplbz`.
 *
 * Defence in depth against a planted verdict. Evidence shown to a reviewer is written by
 * another agent, so a plain `verdict` tag is guessable and forgeable: an executor can embed
 * a ```verdict block claiming pass:true, and if the reviewer answers in prose that planted
 * block is the only tagged verdict in the reply. An agent cannot plant a tag it has never
 * seen. (Fences are also neutralised on the way in — see quote() in pipeline.ts — so this
 * is the second lock, not the only one.)
 *
 * Letters only: FENCE_RE captures `[A-Za-z]+`.
 */
export function answerTag(base: AnswerTag): string {
  // Crypto randomness, not Math.random: this tag is the control the whole
  // forged-verdict defence rests on, and a predictable PRNG stream would make it guessable.
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let n = ''
  for (const b of bytes) n += String.fromCharCode(97 + (b % 26))
  return `${base}${n}`
}

type Candidate = { obj: Record<string, unknown>; tagged: boolean }

/** Every fenced block plus the bare-brace slice, parsed; unparseable ones dropped. */
/**
 * Fenced blocks, anchored to line starts.
 *
 * Without the anchor, ANY stray ``` run earlier in the reply pairs with the answer's own
 * opening fence and swallows it. A reviewer that mentions the tag inline before answering —
 * which is a normal thing to do — then looks like it produced no block at all, and since
 * verdicts have no fallback (see pickAnswer's requireTag) that reads as "no verdict" and
 * blocks a node whose reviewer actually passed it.
 */
// The ANCHOR is the load-bearing part. The surrounding newlines stay OPTIONAL: requiring
// them rejects single-line fences and fences opened after a colon, which are normal
// markdown and which the prompt no longer discourages either way.
/**
 * The CLOSING fence is anchored too — to a line start OR an end of line.
 *
 * 只锚开头是不够的,而漏掉的那一半打死过一整棵树。实测事故(跑机 run 001 的 root):
 * `answerRule` 发给模型的原话里带着 ```` ```planfbqrkley ````,第 1 轮评审又提了
 * 「未按要求输出裁决代码块」,于是方案师在 `responses` 这个 **JSON 字符串字面量**里
 * 回了一句「本次输出严格为单个 ```planfbqrkley 代码块」—— 那三个反引号把它自己的代码块
 * 当场关掉。捕获到的 body 在 3994 字处断开,`Unterminated string`;
 * `sliceTopLevelObject` 在没配平的 body 上返回 null,所以连 `fixEscapes` 都没被调到,
 * 整份方案回退成散文:`acceptance` 空、`children` 全丢。评审于是再提一次
 * 「没解析成 JSON」,方案师再引用一次标记名 —— **引用动作本身就是病因**,轮数越多越出不去。
 * 五个方案席位里两个逐字同因,`maxIterations` 烧穿,一行代码没写。
 *
 * 为什么这一条是**结构性**的、而不是又一个启发式:JSON 不允许字符串字面量里出现裸换行,
 * 所以一个待在 JSON 字符串里的 ``` **前面**同一物理行上必然还有那个字符串的开引号
 * (于是不在行首)、**后面**同一行上必然还有闭引号(于是不在行尾)。真正的收尾围栏两者必居其一。
 *
 * 两条更省事的写法都被真实数据否掉了:
 *  - **贪婪匹配到最后一个 ```**:会把「先引一段 ```json/```bash 证据、再给裁决」这两种最常见的
 *    协作形态吞成一整块(实测 pass 直接读错)。
 *  - **要求收尾围栏独占一行**:run 001 里 acc50119 的真实收尾行是 ```` ```" ````(尾巴上多了
 *    一个引号),会静默降级成 untagged —— 对 plan 无害,对每一个 `requireTag` 的裁决都是失败关闭。
 */
const FENCE_RE = /(?:^|\n)[ \t]*```([A-Za-z]+)?[ \t]*\r?\n?([\s\S]*?)(?:\r?\n[ \t]*```|[ \t]*```[ \t]*(?=\r?\n|$))/g

/**
 * First balanced `{...}` that is NOT nested inside an array, or null.
 *
 * Naive first-`{`..last-`}` slicing cannot see brackets, so on prose like
 * `这是配置: [{"pass":true}]` it happily lifts an element out of a JSON array and
 * hands it back as the model's answer — which is how a rejected verdict became an
 * accepted one. Tracking bracket depth (and string literals, so a brace inside a
 * quoted value doesn't confuse the scan) is what makes the repair safe.
 */
function sliceTopLevelObject(t: string): string | null {
  let inStr = false
  let esc = false
  let bracket = 0
  let brace = 0
  let start = -1
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    else if (ch === '[') bracket++
    else if (ch === ']') { if (bracket > 0) bracket-- }
    else if (ch === '{') {
      if (brace === 0 && bracket === 0) start = i
      brace++
    } else if (ch === '}') {
      if (brace > 0) brace--
      if (brace === 0 && start !== -1) return t.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 修掉模型写坏的 JSON 转义 —— **只在文本已经解析失败之后**才跑。
 *
 * 实测事故:方案师在 acceptance 里写 `` "最后一行含 \"Finished \`dev\` profile\"" ``,
 * `` \` `` 不是合法的 JSON 转义,`JSON.parse` 整份文档抛 `Invalid escape character`。
 * 后果不是「少一个字段」而是**整份方案回退成散文**(见 `parsePlanOutput` 的 fallback):
 * 一个字符换来一个没有验收点的节点,而 node.md 上看不出解析失败过。
 *
 * **写法必须是「左到右先消费合法转义对」,不能用 lookahead 逐个删非法反斜杠。** 评审实测:
 * `{"a":"x\\\`y"}` 里的 `\\` 是**合法**的(一个真反斜杠),而按「`\` 后面不是
 * `"\/bfnrtu` 就删掉」扫,正则会从第二个反斜杠重新起扫、把它当非法吃掉,合法的 JSON
 * 当场被改坏(`{"a":"C:\\path"}` → `{"a":"C:\path"}`,反而 parse 不了了)。
 *
 * 两个坑都是踩出来的:`u` **不能**并进简单转义那个字符类(否则 `\uZZZZ` 走第二支被原样
 * 保留,仍然 parse 失败);第二支用 `[\s\S]` 而不是 `.`(`\` 后面可能是换行)。
 */
function fixEscapes(s: string): string {
  return s.replace(
    /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])|\\([\s\S])/g,
    (m, bad: string | undefined) => (bad === undefined ? m : bad),
  )
}

/**
 * 收尾围栏**两侧都有字**的那一档 —— 只在严格扫描一个带标记的块都没找到时才用。
 *
 * 严格版把收尾围栏锚到行首或行尾,那是治 run 001 那个「JSON 字符串里的裸 ```」的
 * 结构性判据(见 FENCE_RE)。代价是一种真实存在的写法不再被接受:
 *
 *     ```verdictxy
 *     {"pass":true}``` 以上是我的裁决。
 *
 * 它在 CommonMark 里也不是合法的收尾,但模型确实会这么写,而裁决关口是 `requireTag`
 * **失败关闭**的 —— 一次就是一轮假的「未按要求输出裁决代码块」。
 *
 * 所以留一条回退,并且把它夹得很紧:
 *  - **只在严格扫描的 tagged 组为空时才跑**(严格版找到了就用严格版的);
 *  - **只收带标记的块**,generic 一概不要 —— 宽松版正是当年被 JSON 里的裸围栏骗到的那个;
 *  - 收进来的仍然要过 `consider` 那一整套(必须 parse 成对象、不许从数组里挖元素)。
 *
 * 它救不回 run 001 那个 bug:那时宽松版捕到的 body 是**截断**的,parse 不出对象,
 * 照旧被丢掉。也就是说这条回退只可能多认出「本来就完整、只是收尾写在行中间」的答案。
 */
const LENIENT_FENCE_RE = /(?:^|\n)[ \t]*```([A-Za-z]+)?[ \t]*\r?\n?([\s\S]*?)\n?[ \t]*```/g

/** 正则里的元字符。tag 由调用方给,不假定它一定是 `[a-z]+`。 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * **开头围栏不在行首的那一档 —— 从标记本身起扫。**
 *
 * 跑机实测(.13 qianbase-xtp run 001,2215 个节点):222 个节点身上留着
 * 「未按要求输出本轮的裁决代码块;按不通过处理」,而其中 **145 个的回复里明明就有**
 * 一个带本次标记的围栏 —— 只是模型把它接在上一句话屁股后面:
 *
 *     …我将读取模块根以核实 Datum 接线状态。```verdictjklyuyvw
 *     {"pass":false,"blocking":[…]}
 *
 * `FENCE_RE` 和 `LENIENT_FENCE_RE` 的开头都锚在行首(`(?:^|\n)[ \t]*`),两道都扫不到它。
 * 而裁决关口是 `requireTag` **失败关闭**的,于是一次**真实的、内容完整的**裁决被读成
 * 「他没答」:那一轮照样算 FAIL、照样吃掉一格 `maxIterations`,而 `blockingSummary` 从
 * 三条实测出来的阻断意见变成一句格式抱怨 —— 它随后被写进降级记录、写进返工提示词、
 * 写进回溯注入给执行者的那句话。一个正则的锚点,污染了整条链上的每一份证据。
 *
 * ## 为什么放开开头锚点是安全的,而当初锚它是对的
 *
 * 锚开头治的是**配对**:全局扫描下,回复里任何一个游离的 ``` 都会和答案自己的开头围栏
 * 配成一对,把答案吞掉(注释见 FENCE_RE 上方)。这一道不做全局配对 —— 它**从标记本身
 * 起扫**,而标记是这次调用一次性的、不可猜的 nonce(`answerTag`)。防伪造的那道锁一直是
 * nonce,不是行首:被引用进提示词的证据(别的 agent 写的 execStatus)猜不到这一串,
 * 所以「带着本次标记」这件事本身就把它和引文分开了。
 *
 * 三条边界:
 *  - **只在严格 + 宽松两道都没捞到 tagged 块时才跑**(和 LENIENT 那一道同一个闸);
 *  - **只认带标记的**,generic 一概不碰 —— 宽松化 generic 正是当年被 JSON 里的裸围栏骗到的那个;
 *  - 标记后面必须是**边界**(`(?![A-Za-z0-9_])`):否则期望 `verdictab` 时,
 *    一个 ```verdictabcd 块会被当成本次答案。**这一条今天被下面那句
 *    「第一个非空白字符必须是 `{`」盖住了**(前缀匹配剩下的 `cd` 不是 `{`,当场丢弃),
 *    变异测试实测它已经杀不动 —— 记在这儿,免得下一个人当成覆盖缺口去补假探针。
 *    留着的理由:它判的是**标记对不对**,那句判的是**形状对不对**,两件事;
 *    哪天形状那道松了(比如允许答案前面带一行说明),这一条就是唯一还站着的锁。
 *
 * 顺带把**收尾围栏整个缺席**那一档也收进来(截断、或模型忘了收尾):从标记之后一直取到
 * 文末,交给 `consider` 去 parse —— 它要么 parse 得出一个平衡的对象,要么原样丢弃。
 * 这一档不额外放松任何判据:`sliceTopLevelObject` 的「不许从数组里挖元素」照样管着。
 */
function taggedFromOpening(text: string, tag: string): string[] {
  const open = new RegExp('```[ \\t]*' + escapeRe(tag) + '(?![A-Za-z0-9_])[ \\t]*\\r?\\n?', 'gi')
  /**
   * 收尾的判据和 `FENCE_RE` 逐字一致:行首(可缩进)**或行尾**。两边共用一个含义,
   * 各写一份的话,哪天改了其中一处,这一道会和主路径对同一份回复给出不同的边界。
   *
   * **「或行尾」那一支今天是等价的 —— 记在这儿,免得下一个人当成缺口去补假探针。**
   * 实测七种形状(单行紧贴 / 单行后跟正文 / 单行后跟另一个对象 / 改口两个块 /
   * 行首多行 / 行中间多行 / 收尾缺席),去掉它之后**输出逐字相同**:body 少了精确边界会
   * 一路取到文末,而 `consider` 的散文打捞取的是**标记之后第一个平衡对象** —— 还是同一个。
   *
   * 那为什么留着:它让单行块走 `JSON.parse` 的**直路**,而不是退到打捞那条修复路
   * (打捞有它自己的前提:不许从数组里挖元素、只在 parse 失败后才跑)。
   * 判据窄一点、走的路稳一点,代价是零。
   */
  const close = /(?:\r?\n[ \t]*```|[ \t]*```[ \t]*(?=\r?\n|$))/g
  const out: string[] = []
  for (const m of text.matchAll(open)) {
    const start = m.index + m[0].length
    close.lastIndex = start
    const c = close.exec(text)
    const body = text.slice(start, c ? c.index : text.length)
    /**
     * **标记之后紧跟着的必须就是答案本身(第一个非空白字符是 `{`)。**
     *
     * 这一条不是收紧,是**把防伪造的锁装回去** —— 质量席实测出来的 P0,而我这一道的
     * 第一版把它打开了:
     *
     *  - 这一道从**标记**起扫,收尾围栏缺席时取到文末;
     *  - 而 `consider` 对 parse 失败的文本会跑 `sliceTopLevelObject` **散文打捞**。
     *
     * 两条合起来,判据退化成「回复里任何位置出现过本次标记 + 之后任何位置有一个带布尔
     * `pass` 的 `{…}`」。而**在正文里提一句标记名是评审员的常见写法**(`FENCE_RE` 上方
     * 那段注释原话:a normal thing to do),提示词里又铺着**另一个 agent 写的** execStatus
     * 当证据 —— 里面的 `{"pass":true}` 是裸 JSON,`quote()` 只中和三反引号,一个字都挡不住。
     *
     * 实测(873ce8c):评审员正文写着「我的结论:严重不通过,datum.rs 完全缺失」,
     * 而解析层读出 **pass=true**。修复前的老代码在这一格是 fail-closed 的。
     *
     * 加这一句之后:跑机原形(标记后换行接 JSON)、截断(没有收尾围栏)、
     * 单行紧贴(``` TAG {json}```)三种真实形态**全部保住**,而植入的四种形态全部回到
     * fail-closed。散文打捞在严格/宽松那两道里照旧有效(它们要求围栏成对,本来就没有这个敞口)。
     */
    if (!body.trimStart().startsWith('{')) continue
    out.push(body)
  }
  return out
}

function collectCandidates(text: string, preferTag?: string): Candidate[] {
  const tagged: string[] = []
  const generic: string[] = []
  for (const m of text.matchAll(FENCE_RE)) {
    const tag = (m[1] ?? '').toLowerCase()
    // 两边都 lowercase。左边一直是,右边不是 —— 今天不触发(`answerTag` 只产小写字母),
    // 但一个混大小写的 tag 会让 tagged 组恒空、**静默降级**到 generic 兜底,而那一层
    // 正是 requireTag 要挡的东西。
    if (preferTag && tag === preferTag.toLowerCase()) tagged.push(m[2])
    else generic.push(m[2])
  }
  // 严格扫描一个带标记的块都没找到 → 用宽松版**只补带标记的**。见 LENIENT_FENCE_RE。
  if (preferTag && tagged.length === 0) {
    for (const m of text.matchAll(LENIENT_FENCE_RE)) {
      if ((m[1] ?? '').toLowerCase() === preferTag.toLowerCase()) tagged.push(m[2])
    }
  }
  /**
   * 从标记本身起扫(开头围栏不在行首 / 收尾围栏缺席)。见 `taggedFromOpening`:
   * 跑机上 145 个节点的真裁决死在这一格。
   *
   * **无条件跑,不看严格扫描有没有收获** —— 这一条我改过一次口,而反悔的理由是量出来的。
   *
   * 第一版加了「严格扫描空手时才跑」的闸,理由是「别多捞出候选、别把一次真裁决判成
   * ambiguous」。对抗席顺着这条闸找到了它的代价,而那个代价比它买到的东西贵得多 ——
   * **模型改口的那一格**:
   *
   *     ```TAG {"pass":true}```
   *     改口:```TAG {"pass":false,"blocking":["其实不行"]}```
   *
   * 第一个块在行首(严格扫描收得到),更正那个在行中间(有闸时**永远看不见**)。
   * 实测结论:`pass=true` —— **陈旧的那个通过被当成本轮结论**,而模型明明改了口。
   * 这正是 `parseVerdict` 顶上那段话点名不可接受的那一种:「多烧一轮是可恢复的,
   * 放过一个陈旧的通过不是」;也是 `pickAnswer` 那句「两个带标记的块仍然是两个答案,
   * 别让『它带标记』替代『它是唯一一个』」。
   *
   * 无条件跑之后:改口那一格 → ambiguous → 失败关闭;行内引用过一份**完整的**旧裁决块
   * 的那一格同样失败关闭(代价是一轮),而 145 那种「只有行中间一个」照旧解析得出来 ——
   * 因为它本来就只有一个候选。同一个块被两道同时捞到时按内容去重(`consider` 的 `seen`),
   * 不会自己和自己打架。
   */
  if (preferTag) tagged.push(...taggedFromOpening(text, preferTag))
  const out: Candidate[] = []
  const seen = new Set<string>()
  const consider = (raw: string, isTagged: boolean): void => {
    const t = raw.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      // Unparseable: try to salvage an object out of surrounding prose. This is a
      // REPAIR for broken text, never a way to reach inside valid JSON — it only
      // runs when the source failed to parse at all, and it refuses objects that
      // sit inside an array.
      const slice = sliceTopLevelObject(t)
      if (slice === null) return
      try { parsed = JSON.parse(slice) } catch {
        // 最后一次机会:修掉坏转义再 parse。**只修 slice,不修整段** —— 上面那条
        // 「不许从数组里挖元素」的判据是 `sliceTopLevelObject` 给的,绕过它去修整段
        // 等于把那道防线拆掉。修不好就照旧丢弃。
        try { parsed = JSON.parse(fixEscapes(slice)) } catch { return }
      }
    }
    // Valid JSON that isn't a plain object (an array, a number, a string) is not
    // an answer. Disqualify the whole source rather than digging into it: an
    // object inside an array is an element, not the model's reply.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const key = `${isTagged}:${JSON.stringify(parsed)}`
    if (seen.has(key)) return // the whole-text pass often re-captures a fence
    seen.add(key)
    out.push({ obj: parsed as Record<string, unknown>, tagged: isTagged })
  }
  // Newest first within each group: a correction supersedes an earlier draft.
  for (let i = tagged.length - 1; i >= 0; i--) consider(tagged[i], true)
  for (let i = generic.length - 1; i >= 0; i--) consider(generic[i], false)
  // Finally, prose OUTSIDE every fence — a model that answered without any fence.
  // Fenced regions are stripped first: their contents were already judged above on
  // their own terms, and re-slicing across them would mine an object out of a fence
  // whose real content is an array (an element is not an answer).
  consider(text.replace(FENCE_RE, ' '), false)
  return out
}

/** Best-effort object extraction with no shape or tag requirement. */
export function extractJsonBlock(text: string): unknown | null {
  return collectCandidates(text)[0]?.obj ?? null
}

/**
 * Answer selection: prefer the properly tagged answer; fall back to any block of
 * the right shape. Returns `ambiguous` when the fallback cannot tell two same-shaped
 * blocks apart, so safety-critical callers can fail closed instead of guessing.
 */
function pickAnswer(
  text: string,
  tag: string,
  matches: (o: Record<string, unknown>) => boolean,
  // When true, ONLY a block carrying `tag` counts. Used for verdicts, where the prompt
  // hands the model an unguessable per-call tag: anything else in the reply is quoted
  // context, and quoted context is attacker-controlled (a node's execStatus is written by
  // another agent and shown to the reviewer as evidence). Falling back to "any object of
  // the right shape anywhere in the reply" lets that evidence BE the verdict.
  requireTag = false,
): { obj: Record<string, unknown> | null; ambiguous: boolean } {
  const candidates = collectCandidates(text, tag).filter(c => matches(c.obj))
  const tagged = candidates.filter(c => c.tagged)
  if (requireTag) return { obj: tagged[0]?.obj ?? null, ambiguous: tagged.length > 1 }
  // Duplicates are ambiguous in BOTH groups. The tag says "this is my answer", so
  // two of them is still two answers — a model that re-tags a recap of a stale
  // verdict would otherwise win on recency, which is the exact failure this tag
  // was introduced to stop. Never let "it's tagged" substitute for "it's the only one".
  if (tagged.length > 0) return { obj: tagged[0].obj, ambiguous: tagged.length > 1 }
  if (candidates.length === 0) return { obj: null, ambiguous: false }
  // Untagged: the model ignored the output contract. One block is unambiguous;
  // several of the same shape are not — we cannot tell the answer from a recap.
  // A malformed (unparseable) tagged block lands here too: it never became a
  // candidate, so an honest typo degrades to the same tolerance as no tag at all.
  return { obj: candidates[0].obj, ambiguous: candidates.length > 1 }
}

/**
 * Caps on what a single model reply may put into a node.
 *
 * These bound node.md at the SOURCE. Capping only the rendered body was cosmetic: measured,
 * 3 rounds x 5 roles x 20 blocking entries of 2000 chars produced a 622 KB node.md of which
 * 597 KB was frontmatter (`yamlStringify({...node})` dumps the whole object), and every
 * commit rewrites the file — 8 rewrites for a plain leaf, so ~5 MB of writes for ONE node.
 *
 * Generous enough that no honest reply is truncated: the executor's own summary, a reviewer's
 * blocking list. `parseExecOutput`/`parsePlanOutput` fall back to the ENTIRE reply text when
 * the model ignores the schema, and that fallback is what actually blows up.
 */
export const MAX_FIELD_CHARS = 8000
export const MAX_BLOCKING_ITEMS = 20
export const MAX_BLOCKING_CHARS = 2000
/** The synthesized summary concatenates every reviewer's every blocking entry. */
export const MAX_SUMMARY_CHARS = 4000

/**
 * Cap a blocking list on BOTH axes, keeping a marker when anything was dropped.
 *
 * Shared by the parse boundary and the resume boundary, because they disagreed: parseVerdict
 * produced 20 entries + a "还有 N 条" marker (21), and the resume path then sliced to 20 —
 * deleting exactly the marker. A user resuming saw a full 20 with no sign anything was cut.
 */
export const DROPPED_MARKER = '…(还有'

export function capBlockingList(
  items: string[],
  /**
   * 被丢掉的**是什么**,写进标记里。
   *
   * 默认「阻断意见」= 这个函数原来唯一的调用场景,老行为逐字不变。`capResponses` 要传
   * 「回应」:一份标题为「执行者对上一轮**阻断意见**的逐条处置」的清单,末尾跟着一句
   * 「还有 3 条**阻断意见**未记录」,读起来是「系统又丢了 3 条意见」——而丢的是 3 条回应。
   * 没静默截断,但标错了东西,和静默截断一样会让人对着一份残缺的清单做判断。
   */
  what = '阻断意见',
): string[] {
  // IDEMPOTENT. A list that already carries the marker is passed through untouched: the
  // resume path runs this over values the parse path already capped, and re-deriving the
  // count there rewrote "还有 30 条" into "还有 1 条" — a number that describes this pass
  // rather than what was actually lost.
  const alreadyCapped =
    items.length === MAX_BLOCKING_ITEMS + 1 && items[items.length - 1].startsWith(DROPPED_MARKER)
  if (alreadyCapped) return items.map(b => capText(b, MAX_BLOCKING_CHARS))
  const capped = items.map(b => capText(b, MAX_BLOCKING_CHARS))
  if (capped.length <= MAX_BLOCKING_ITEMS) return capped
  return [...capped.slice(0, MAX_BLOCKING_ITEMS), `${DROPPED_MARKER} ${items.length - MAX_BLOCKING_ITEMS} 条${what}未记录)`]
}

/** Truncate by CODE POINTS, marking the cut so a reader knows it happened. */
export function capText(s: string, max = MAX_FIELD_CHARS): string {
  const cps = Array.from(s)
  return cps.length > max ? `${cps.slice(0, max).join('')}…(已截断,原文 ${cps.length} 字)` : s
}

function str(v: unknown, fallback = ''): string {
  // Capped HERE, at the single boundary every parsed field crosses. plan.solution and
  // execStatus both fall back to the ENTIRE model reply when the schema is ignored, and that
  // fallback is what actually blows the file up.
  return capText(typeof v === 'string' ? v : fallback)
}

/**
 * 「逐条处置」列表的解析 + 夹取。
 *
 * 走 `capBlockingList` 的**同一对上限**(20 条 × 2000 字)不是偷懒:这份列表是**对着**
 * blocking 列表写的,一条意见一项。给它一个更小的上限,回应就会在阻断意见还看得见的
 * 时候先被截掉 —— 裁决员于是读到「第 18 条没有回应」,而其实是我们没给它地方写。
 *
 * 非数组、非字符串项、空白项一律丢掉:这个字段会原样进裁决提示词,`[object Object]`
 * 在那里读起来像一条真的回应。
 */
export function capResponses(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const items = v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(s => s.length > 0)
  return items.length === 0 ? [] : capBlockingList(items, '回应')
}

/**
 * 占位词。写了字但等于没写。
 *
 * 验收实测:`keyPoints/risks/acceptance` 填 `'无'/'无'/'无'`、`'a'/'b'/'c'`、`'-'`、`'。'`
 * 时 planGaps **一条都不报** —— 那个函数的立意是挡「模型偷懒」,而模型写三个「无」就
 * 完全绕过,连那次自动重拟都不会触发。只判空白是不够的。
 *
 * **住在这个文件里,而不是 `rootPlan.ts`。** 它原来在那边,而现在 `pipeline.ts` 也要用它
 * (子节点的验收点同样不能只判 `=== ''`,否则刚补上的洞在另一扇门上重开)——
 * 但 `rootPlan.ts` 已经 `import … from './pipeline.js'`,反向再导一次就成环。
 * `parseOutput.ts` 是叶子(只 import `types.js`),放这里两边都能拿。
 */
const PLACEHOLDER = new Set([
  '无', '暂无', '没有', '不适用', '略', '待定', '待补充', '同上', 'n/a', 'na', 'none', 'nil', 'tbd', 'todo', '-', '--', '/',
])
/** 字段短到这个程度也只能是占位。 */
export const MIN_FIELD_CHARS = 4

export function hollow(v: unknown): boolean {
  if (typeof v !== 'string') return true
  const t = v.trim()
  if (t.length === 0) return true
  // 去掉标点空白再判,'。'、'——'、'…' 这类也算空
  const core = t.replace(/[\s\-—…·。,.;:!?、"'`~*#\[\]()（）【】]/g, '')
  if (core.length === 0) return true
  if (PLACEHOLDER.has(core.toLowerCase())) return true
  return Array.from(core).length < MIN_FIELD_CHARS
}

/**
 * 带本轮 tag 的围栏里,有没有哪一个**连修完转义都 parse 不出对象**。
 *
 * 单独扫一遍,而不是从 `collectCandidates` 的返回值里推 —— 那里推不出来:tagged/generic
 * 分组是函数内的局部变量,解析失败的那些直接 `return` 掉了,`pickAnswer` 往外只透
 * `{obj, ambiguous}`。用 `obj === null` 近似会把三件事混成一件(**围栏坏了** / 围栏好但
 * 缺 plan 字段 / 压根没有围栏),而这个布尔的唯一用途是让重拟提示词对模型说一句
 * 「你上一轮的 JSON 没解析成功」—— 后两种情形下那句话是**假的**,而「提示词里说假话」
 * 正是这个仓库反复在修的那一类。
 */
function taggedBlockBroken(text: string, tag: string): boolean {
  const want = tag.toLowerCase()
  for (const m of text.matchAll(FENCE_RE)) {
    if ((m[1] ?? '').toLowerCase() !== want) continue
    const t = m[2].trim()
    const ok = (raw: string): boolean => {
      try {
        const o: unknown = JSON.parse(raw)
        return !!o && typeof o === 'object' && !Array.isArray(o)
      } catch { return false }
    }
    if (ok(t) || ok(fixEscapes(t))) continue
    return true
  }
  return false
}

export function parsePlanOutput(text: string, tag: string = ANSWER_TAGS.plan): {
  kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[]
  /** 本轮 tag 的围栏在场、但解析不出对象。见 `taggedBlockBroken`。 */
  parseFailed: boolean
  /**
   * 这次回复里**真的挑出了一个方案对象**吗。
   *
   * `parseFailed` 回答不了这个问题:它只在「本轮围栏在场但内容坏了」时为真,而最常见的
   * 那种退化 —— 回复里**根本没有方案对象**(答非所问、答成了别的环节的 schema)——
   * 走的是下面那条兜底:`solution` 变成整段回复原文,`parseFailed` 是 false。
   *
   * 分析环节可以接受那条兜底(有总比没有强,而且后面有人会质疑它)。**质疑修复不行**:
   * 那一关手上已经有一份真方案,拿一坨散文去覆盖它是净损失,而且没有任何下游环节能把它
   * 变回来。所以那一关的判据是这个字段,不是 `parseFailed`。
   */
  structured: boolean
} {
  // A plan carries at least one plan-ish key; a bare echo of the goal has none.
  // Ambiguity is tolerated here: a wrong plan is caught by the review roundtable.
  const { obj } = pickAnswer(text, tag, o => 'solution' in o || 'kind' in o || 'children' in o)
  const plan: NodePlan = {
    solution: str(obj?.solution, text.trim()),
    keyPoints: str(obj?.keyPoints),
    risks: str(obj?.risks),
    acceptance: str(obj?.acceptance),
  }
  // 逐条处置。只在模型真的给了非空数组时挂上去 —— 缺席和「一条都没回应」在评审员眼里
  // 是同一件该被看见的事(见 NodePlan.responses),补一个空数组只会让 node.md 多一节空标题。
  const responses = capResponses(obj?.responses)
  if (responses.length > 0) plan.responses = responses
  const rawChildren = Array.isArray(obj?.children) ? (obj!.children as unknown[]) : []
  const children = rawChildren
    .map(c => {
      const co = c as Record<string, unknown>
      return { title: str(co?.title).trim(), deps: Array.isArray(co?.deps) ? (co!.deps as unknown[]).map(d => str(d)).filter(Boolean) : [] }
    })
    .filter(c => c.title.length > 0)
  const kind: NodeKind = obj?.kind === 'decompose' && children.length > 0 ? 'decompose' : 'executable'
  // 只在**回退发生了**的时候才去扫围栏(obj 非空 = 解析成功,没什么可报告的),省掉
  // 正常路径上每个节点一次的额外正则遍历。
  return { kind, plan, children, parseFailed: obj === null && taggedBlockBroken(text, tag), structured: obj !== null }
}

/**
 * **协议失败**那两条 blocking —— 它们说的是「这份回复没按格式答」,不是「这份产出哪里不对」。
 *
 * 提成常量是因为下游要按它们分流,而各写一份字面量的后果是现成的:哪天改一个字,
 * 下游那条过滤就静默失效,而它挡的正是「把一句格式抱怨当成整改要求发给执行者」。
 *
 * 跑机实测(.13 run 001):242 个集成验收判不通过的节点里,**222 个**的最后一条记录是
 * `PROTOCOL_NO_BLOCK`,于是降级理由、返工提示词、回溯注入的那句话全都变成了
 * 「未按要求输出本轮的裁决代码块」—— 而真正的三条阻断意见还躺在前几轮的记录里。
 */
export const PROTOCOL_NO_BLOCK = '未按要求输出本轮的裁决代码块;按不通过处理'
export const PROTOCOL_AMBIGUOUS = '回复中有多个裁决块,无法判定哪个是本轮结论;请只输出一个本轮要求的裁决块'
/**
 * 这一条意见是不是「协议失败」而不是对产出的判断。
 *
 * **按包含判,不是相等判**,而这不是宽松、是必需:`synthesizeVerdicts` 合成出来的
 * `blockingSummary` 会给每一条加上席位抬头(跑机上逐字是
 * `[测试] 未按要求输出本轮的裁决代码块;按不通过处理`)。按相等判的话,这个函数对
 * **真实数据里最常见的那一条**恒为假 —— 而那正是它要挡的东西。
 * 反过来的误伤面很窄:一条把这句话原样抄进去的意见,本身讲的也是格式。
 */
export function isProtocolBlocking(s: string): boolean {
  return s.includes(PROTOCOL_NO_BLOCK) || s.includes(PROTOCOL_AMBIGUOUS)
}

export function parseVerdict(text: string, role: string, tag?: string): Verdict {
  // FAIL CLOSED. A verdict is the one output where guessing wrong in the "pass"
  // direction lets unfinished work through, so anything short of one unmistakable
  // verdict — none found, or two same-shaped blocks we cannot rank — is a rejection.
  // Costing an iteration is recoverable; silently accepting a stale pass is not.
  //
  // When the caller supplied a per-call tag, the prompt told the reviewer that exact,
  // unguessable string, so ONLY a block carrying it is this reviewer's answer. Everything
  // else in the reply is quoted context — and context is attacker-controlled: a node's
  // execStatus is written by another agent and shown to the reviewer as evidence, so a
  // planted `{"pass":true}` there would otherwise be read as the verdict itself.
  const expected = tag ?? ANSWER_TAGS.verdict
  const { obj, ambiguous } = pickAnswer(text, expected, o => typeof o.pass === 'boolean', tag !== undefined)
  if (!obj) {
    return {
      role,
      pass: false,
      // Do NOT name the tag here: this string becomes blockingSummary, which the rework
      // prompt shows the EXECUTOR. Handing it a live tag is handing it the forgery key.
      blocking: [PROTOCOL_NO_BLOCK],
      comments: capText(text.trim(), 2000),
    }
  }
  if (ambiguous) {
    return {
      role,
      pass: false,
      blocking: [PROTOCOL_AMBIGUOUS],
      comments: capText(text.trim(), 2000),
    }
  }
  // Bounded on BOTH axes. A reviewer that returns 200 entries of 2000 chars each puts
  // 400 KB into the node — which yamlStringify then dumps into node.md on every commit.
  // Capped ONCE, from the raw value. Going through str() first truncated at 8000 and then
  // again at 2000, so the marker reported "原文 8017 字" for a 50000-character entry — wrong
  // on the very first write.
  const rawBlocking = Array.isArray(obj.blocking)
    ? (obj.blocking as unknown[]).map(b => (typeof b === 'string' ? b : '')).filter(Boolean)
    : []
  const blocking = capBlockingList(rawBlocking)
  /**
   * 本轮撤回的历史意见 (`Verdict.retracted`)。
   *
   * **和 `blocking` 走同一条预算**,理由也逐字相同:它是模型自由填写的字符串数组,而它会
   * 随 verdicts 一起被 yamlStringify 进 node.md。标记里的名词要说准 —— 一份「本轮撤回的
   * 意见」清单末尾跟着「还有 3 条阻断意见未记录」,读起来是系统丢了 3 条阻断意见。
   *
   * **不参与 `pass` 的计算。** 撤回一条老意见既不是通过也不是否决,判决完全由 `blocking`
   * 决定 —— 一个撤回了 3 条、同时新提 1 条的裁决,仍然是不通过。
   *
   * 空数组不落字段:`retracted: []` 会给每一条老 verdict 记录凭空加一行 YAML,而
   * 「省略 = 什么都没撤回 = 逐字相同」是这个字段对老 node.md 的承诺。
   */
  const rawRetracted = Array.isArray(obj.retracted)
    ? (obj.retracted as unknown[]).map(r => (typeof r === 'string' ? r : '')).filter(Boolean)
    : []
  const retracted = rawRetracted.length > 0 ? capBlockingList(rawRetracted, '撤回项') : []
  /**
   * **修改建议** (`Verdict.advice`) —— 「接下来该怎么改」,和 `blocking` 的「哪里不对」分开。
   *
   * 用户原话:「每次质疑不能给出修改建议吗?然后一起传给下面的阶段去。」
   *
   * 为什么值得单独一个字段,而不是「让评审员把修复方式写进 blocking 里就行」——
   * 后者其实**已经在发生**:跑机 run 001 的评审员逐条写了「修复方式:在方案 JSON 中实际
   * 给出 children 数组」「应改为 `git worktree add --detach …`」。它们没能传到下一轮,
   * 病根不在有没有人写,而在 `planFeedbackPrompt` 的**逐条预算**:13 条意见时每条只有
   * 261 字,而那几条最有价值的意见,修复方式全都写在第 261 字**之后**,被
   * 「…(已截断,原文 518 字)」整段吃掉。单独成字段的唯一理由,就是让它有一个**结构上
   * 定位得到、可以单独保预算**的位置(见 reviewConvergence 的 adviceOf)。
   *
   * 和 `remedy` 一样只在**不通过**时收:通过了的裁决没有要改的东西,而一条挂在 pass 上的
   * 建议谁也读不到(`feedbackItems` 只看有 blocking 的裁决),留着只会让人以为它传下去了。
   * 空数组不落字段 —— 和 `retracted` 同一条:老 node.md 逐字不变。
   */
  const rawAdvice = Array.isArray(obj.advice)
    ? (obj.advice as unknown[]).map(a => (typeof a === 'string' ? a : '')).filter(Boolean)
    : []
  const advice = rawAdvice.length > 0 ? capBlockingList(rawAdvice, '修改建议') : []
  const pass = obj.pass === true && blocking.length === 0
  return {
    role, pass, blocking, comments: str(obj.comments),
    ...(retracted.length > 0 ? { retracted } : {}),
    ...(!pass && advice.length > 0 ? { advice } : {}),
    // 补救子任务 (spec §4.1). Read from the SAME tag-verified object as the verdict itself,
    // which is exactly what makes it safe: `obj` came from a pick that required this call's
    // unguessable tag, so a `remedy` planted in the quoted evidence is unreachable here.
    // Dropped entirely on a PASS — a reviewer that approved the work has nothing to remedy,
    // and honouring one would let a passing verdict grow the tree.
    ...(pass ? {} : { remedy: parseRemedy(obj) }),
  }
}

/** Corrective children ONE reviewer may propose. Deliberately far below MAX_NEW_CHILDREN. */
export const MAX_REMEDY_CHILDREN = 3

/**
 * 补救子任务, shape-checked.
 *
 * Capped at 3 rather than the 20 `newChildren` allows, because these siblings are by
 * definition all closing the SAME integration gap — so they touch the same files, and spec
 * §16 names worktree merge conflict as the run's single biggest risk. Three is enough to say
 * "the gap has a few parts" and small enough that the caller can chain them into a line.
 *
 * No `parent` field, unlike NewChildSpec: these attach to the node being integrated and
 * nowhere else. Letting a reviewer name an arbitrary target would bypass growTree's
 * safe-target rules, which exist because grafting onto a CREATED/READY node silently
 * overwrites its own plan and execute phases.
 */
export function parseRemedy(o: Record<string, unknown>): { title: string; deps: string[] }[] {
  const raw = o.remedy
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, MAX_REMEDY_CHILDREN)
    .map(c => ({
      title: typeof c.title === 'string' ? capText(c.title.trim(), 200) : '',
      deps: Array.isArray(c.deps)
        ? c.deps.filter((d): d is string => typeof d === 'string').slice(0, MAX_REMEDY_CHILDREN).map(d => capText(d, 200))
        : [],
    }))
    .filter(c => c.title.length > 0)
}

/**
 * 依赖重算的回答里,**一个依赖**最多认多少项。
 *
 * 这是**解析层的防御上限**,不是发给模型的那个数(提示词里的软上限是 8,见 depsRecalc.ts
 * 的 `RECALC_SOFT_LIMIT`)。两者必须分开,而且这个数必须**明显高于** `MAX_DEPS_PER_DEP`:
 * 归一化的「某节点的全部子任务都在集合里 → 可以卷成它」这一判据跑在解析**之后**,
 * 解析层先 `slice` 掉几项的话,那个判据会恒不成立,按需上卷整个失效 —— 而截断本身
 * 在屏幕上一个字都没有。照 `parseRemedy` 的 3 抄下来就是这个后果。
 */
export const MAX_RECALC_NEEDS = 50
/**
 * 一个节点 id 最长认到这里。
 *
 * **不能用 `parseRemedy` 的 200**:合法 id 的长度是 `4 + 44 × depth`(`childId` = 父 id +
 * `/NN-` + 40 码点的 slug),默认 `maxDepth 5` 就已经是 224 —— 按 200 夹会把一个**合法**
 * id 截成一个不存在的 id,而域约束随后会如实报告「不在子树里」,病因完全看不出来。
 */
export const MAX_RECALC_ID_CHARS = 1000
/** 每一项的理由。短,因为它的作用是**逼模型别滥列**,不是让它写论文。 */
export const MAX_RECALC_WHY_CHARS = 40

export interface RecalcNeed {
  id: string
  /**
   * 模型自己写的标题。**用来和 id 对账**(见 depsRecalc.ts 的 `resolveNeed`)——
   * 整个系统对模型说的语言是标题(依赖段、方案 schema、子任务按标题解析),所以
   * 「答标题而不是 id」是最可能的抄错形态,而两个字段一起要才让「答错」从不可观测
   * 变成可观测。
   */
  title: string
  why: string
}
export interface RecalcAnswer { deps: { dep: string; needs: RecalcNeed[] }[] }

/**
 * 依赖重算的回答。
 *
 * **`requireTag: true`**,和 `parseNewChildren` 走的那次 pick 同级、同因:改一个节点的
 * `deps` 是**结构性变更**(它直接动调度门),而宽松的 pick 会匹配回复里任何同形对象 ——
 * 包括被我们自己铺进提示词的、**别的 agent 写的**文本(依赖子树里带着 keyPoints/acceptance,
 * 而 `planPrompt` 的 schema 行本身就长着 `"deps":[…]`)。
 *
 * 三个诊断位都要带出去,因为**它们对应三种完全不同的下一步**(见 §7.3 的关口文案):
 *  - `ambiguous`:两个带标记的块 → 失败关闭,重拟时说「只输出一个块」;
 *  - `broken`:本轮围栏在场但内容 parse 不出 → 重拟时可以诚实地说「你的 JSON 没解析成功」;
 *  - `truncated`:真的截掉了几项 → 必须报出来,不许静默。
 */
export function parseDepsRecalc(text: string, tag: string = ANSWER_TAGS.deps): {
  answer: RecalcAnswer | null
  ambiguous: boolean
  broken: boolean
  truncated: number
} {
  const { obj, ambiguous } = pickAnswer(text, tag, o => Array.isArray(o.deps), true)
  const broken = taggedBlockBroken(text, tag)
  if (!obj) return { answer: null, ambiguous, broken, truncated: 0 }
  let truncated = 0
  const deps = (obj.deps as unknown[])
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d))
    .map(d => {
      const rawNeeds = Array.isArray(d.needs) ? d.needs : []
      const kept = rawNeeds
        .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n))
      truncated += Math.max(0, kept.length - MAX_RECALC_NEEDS)
      return {
        dep: typeof d.dep === 'string' ? capText(d.dep.trim(), MAX_RECALC_ID_CHARS) : '',
        needs: kept.slice(0, MAX_RECALC_NEEDS).map(n => ({
          id: typeof n.id === 'string' ? capText(n.id.trim(), MAX_RECALC_ID_CHARS) : '',
          title: typeof n.title === 'string' ? capText(n.title.trim(), 200) : '',
          why: typeof n.why === 'string' ? capText(n.why.trim(), MAX_RECALC_WHY_CHARS) : '',
        })),
      }
    })
    // 没有 dep 名的条目挂不到任何原依赖上 —— 丢掉而不是猜。
    .filter(d => d.dep.length > 0)
  return { answer: { deps }, ambiguous, broken, truncated }
}

export interface NewChildSpec { parent?: string; title: string; deps: string[] }

/**
 * Child specs an executor asked to graft onto the tree (spec §4 动态生长).
 *
 * Shape-checked here, not trusted: `parent` merely NAMES a node id the caller must still
 * resolve, and a spec with no usable title is dropped rather than creating a node titled
 * "undefined". Everything that needs the tree — does the target exist, is it terminal, does
 * it fit under the depth and node caps — is the caller's job.
 */
/** Children a single execute reply may graft. Beyond this the reply is not a task list. */
export const MAX_NEW_CHILDREN = 20

export function parseNewChildren(o: Record<string, unknown>): NewChildSpec[] {
  const raw = o.newChildren
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    // CAPPED, like every other parsed field. This function does not go through str(), so a
    // 200000-character title landed verbatim in a node — and growTree copies refusals back
    // into execStatus AFTER the caps, so 200 of them produced a 24 MB node.md. Measured.
    .slice(0, MAX_NEW_CHILDREN)
    .map(c => ({
      parent: typeof c.parent === 'string' && c.parent.length > 0 ? capText(c.parent, 200) : undefined,
      title: typeof c.title === 'string' ? capText(c.title.trim(), 200) : '',
      deps: Array.isArray(c.deps) ? c.deps.filter((d): d is string => typeof d === 'string').slice(0, MAX_NEW_CHILDREN).map(d => capText(d, 200)) : [],
    }))
    .filter(c => c.title.length > 0)
}

/**
 * 执行者自陈没做的那几件,从 `execStatus` 里逐行摘出来。
 *
 * 措辞由 `strictness.ts` 的执行侧那一段规定:「不做的每一件,在 execStatus 里**单起一行**写
 * 『本轮未做:…(原因)』」。所以这里按行认,而不是在整段里搜关键词 —— 后者会把
 * 「本轮未做的判断标准是…」这种叙述句也收进来。
 *
 * 两条容错都是照着真实回复加的(.13 run 001,610 个节点写过这几行):
 *  - 冒号半角/全角都认(实测同一份报告里两种都出现);
 *  - 允许 markdown 列表前缀(`- 本轮未做:…`)—— 提示词说「单起一行」,没说不许带项目符号。
 *
 * 走 `capBlockingList` 的同一对上限:这份清单每次 commit 都会被写进 node.md,
 * 而它的来源是模型自由文本。
 */
export const UNDONE_PREFIX = '本轮未做'
/**
 * 「什么都没欠」的各种写法。**必须挡掉**,而这是质量席实测出来的:
 * `strictness.ts` 的执行侧提示词原话是「不做的每一件……**也不要不写**」——
 * 它明确在诱导模型在没有未做项时**也写一行**。收成一条「自陈未做:无」的后果一路朝坏:
 * 一个完全健康的子任务进回溯的保守名单被重执行,而集成验收席位收到一条内容为「无」的
 * 整改要求(中级及以上的档位判据是「列出的各项凡是落在验收点上的,不通过」)。
 */
const NOTHING_UNDONE = /^[(()\[【]?\s*(无|没有|暂无|均无|全部完成|全部已完成|无遗留项?|none|n\/?a)\s*[)))\]】]?\s*[。.!!]?$/i
export function undoneItems(execStatus: string): string[] {
  const out: string[] = []
  for (const raw of execStatus.split('\n')) {
    /**
     * 列表符号在前、加粗标题在后,**而列表符号那条不许吃掉 `**` 的第一个星号**
     * (探针第一版就栽在这儿:`**本轮未做**` 被啃成 `*本轮未做**`,加粗那条再也匹配不上)。
     * 所以 `*` 只在**后面不是 `*`** 时才算列表符号。
     */
    const line = raw.trim()
      .replace(/^(?:[-·•]|\*(?!\*))\s*/, '')
      .replace(/^\*\*\s*(本轮未做)\s*\*\*/, '$1')
    if (!line.startsWith(UNDONE_PREFIX)) continue
    /**
     * **冒号是必需的,不是可选的。** 探针第一版就抓到了:「本轮未做**的判断标准是**:…」
     * 这种叙述句同样以这四个字开头,而按前缀切会把它收成一条「未做项」,内容是
     * 「的判断标准是:…」—— 它随后会被印进集成验收的证据段,并让回溯把这个节点拉回来重跑。
     */
    const rest = line.slice(UNDONE_PREFIX.length)
    const m = /^[ \t]*[:：][ \t]*/.exec(rest)
    if (!m) continue
    const item = rest.slice(m[0].length).trim()
    if (item.length > 0 && !NOTHING_UNDONE.test(item)) out.push(item)
  }
  return capBlockingList(out, '自陈未做')
}

export function parseExecOutput(
  text: string, tag: string = ANSWER_TAGS.exec,
): { execStatus: string; newChildren: NewChildSpec[]; responses: string[]; undone: string[] } {
  const { obj } = pickAnswer(text, tag, o => typeof o.execStatus === 'string')
  // newChildren is read from a SEPARATE, tag-REQUIRED pick. Grafting nodes onto the tree is
  // a structural change, and the lenient pick above matches any same-shaped object anywhere
  // in the reply — including text quoted INTO the prompt. Reusing it meant an untagged
  // ```json block, or even bare prose, could grow the tree (reproduced).
  const { obj: tagged } = pickAnswer(text, tag, o => typeof o.execStatus === 'string', true)
  // responses 走**宽松**的那次 pick,和 execStatus 同源 —— 它不是结构性变更(不动树、
  // 不放行任何东西),只是一段给下一关读的说明。绑到 tagged 上的话,一个漏打标签的
  // 回复会把自述留下、把回应丢掉,而裁决员看到的是「他一条都没回应」。
  /**
   * **「本轮未做」要在截断**之前**摘出来。**
   *
   * 规范席实测到的:`str()` 在解析边界就 `capText(…, 8000)` 了,而这几行按提示词的要求
   * 写在报告**末尾** —— 一份 8000 字以上的报告里,`node.undone` 恒空。而 `TaskNode.undone`
   * 立项的第一条理由逐字就是「`capText` 砍的是尾巴,最该被看见的几行最先被砍掉」:
   * 从截断**之后**的字符串里摘,等于这条理由一次都没兑现。
   *
   * 两条路都要摘:结构化那条从 `obj.execStatus` 原值摘;无标记兜底那条从**整段原始回复**摘。
   */
  if (obj) {
    const raw = typeof obj.execStatus === 'string' ? obj.execStatus : ''
    return {
      execStatus: str(obj.execStatus),
      newChildren: tagged ? parseNewChildren(tagged) : [],
      responses: capResponses(obj.responses),
      undone: undoneItems(raw),
    }
  }
  // Untagged fallback: the whole reply becomes the status. A growth request must NOT be
  // honoured from untagged text — grafting nodes onto the tree is a structural change, and
  // the tag is the only thing separating "my answer" from text quoted into the prompt.
  // Capped like every other field: this fallback is the single biggest contributor to
  // node.md's size, because it takes the model's ENTIRE reply verbatim.
  return { execStatus: capText(text.trim()), newChildren: [], responses: [], undone: undoneItems(text) }
}

/**
 * An observer's scores for a node: plan quality and execution quality, 0-100, with reasons.
 *
 * Out-of-range or unparseable numbers are CLAMPED rather than rejected. A score is advisory
 * by default (it only gates anything when caps.scoreThreshold is set), so failing the phase
 * over a malformed number would cost a real rework round for a field nobody is gating on.
 * A missing number reads as 0, and 0 is the most conservative reading — with a threshold
 * configured it triggers the rework rather than waving the work through.
 */
export function parseScoreOutput(
  text: string, tag: string,
): { plan: { score: number; rationale: string }; exec: { score: number; rationale: string } } {
  const clamp = (v: unknown): number => {
    const n = typeof v === 'number' ? Math.round(v) : Number.NaN
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  // requireTag: the score is read out of a reply that also QUOTES the node's plan and
  // execStatus, both written by other agents. Without the tag an executor could plant a
  // score block in its own report and grade itself.
  const { obj } = pickAnswer(text, tag, o => 'plan' in o || 'exec' in o, true)
  if (!obj) {
    const miss = '未按要求输出评分代码块'
    return { plan: { score: 0, rationale: miss }, exec: { score: 0, rationale: miss } }
  }
  const o = obj
  const planO = (o.plan ?? {}) as Record<string, unknown>
  const execO = (o.exec ?? {}) as Record<string, unknown>
  return {
    plan: { score: clamp(planO.score), rationale: str(planO.rationale) },
    exec: { score: clamp(execO.score), rationale: str(execO.rationale) },
  }
}

/**
 * 节点修复的回答(详情页 `g` 键)。
 *
 * **`requireTag: true`**,和 `parseDepsRecalc` / `parseNewChildren` 同级同因,而且这里
 * 更硬:提示词会把**损坏文件的原文**整段铺进去,而那段原文里本来就有这个节点上一版的
 * 方案 JSON。宽松的 pick 会把那块旧内容当成本轮回答捡回来 —— 于是「修复」的结果是把
 * 坏掉之前的半份数据原样抄回去,而屏幕上写着模型帮你恢复好了。
 *
 * 返回原始对象而不是收好的补丁:白名单、空值、以及「盘上已有真值就不采纳」那三条
 * 判据全在 `nodeRepair.sanitizeRepair` 里,那里才看得见节点此刻的样子。
 */
export function parseRepair(text: string, tag: string): {
  answer: Record<string, unknown> | null
  ambiguous: boolean
  broken: boolean
} {
  const { obj, ambiguous } = pickAnswer(
    text, tag,
    // 形状判据:至少带一个可修复的键。少了它,一个 `{}` 会被当成一次成功的修复,
    // 而屏幕上会说「已恢复」——实际上一个字段都没补。
    o => ['title', 'goal', 'kind', 'solution', 'acceptance'].some(k => typeof o[k] === 'string'),
    true,
  )
  return { answer: obj, ambiguous, broken: taggedBlockBroken(text, tag) }
}
