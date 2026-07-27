import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { skipConflictLines } from './startupConfirm'
import { PHASE_LABEL, PHASE_NAMES, type EffTaskConfig, type PhaseName } from './types'

/**
 * 文档必须说真话。
 *
 * 这道闸门是被一句**上线了的错话**逼出来的:roles-setup.md 第 44 行写着
 * 「没配角色的环节整个不发生」,而实际上七个环节里有五个会照跑(主模型顶上)。
 * 那句话在仓库里活了很久,因为**没有任何东西检查文档**——测试全绿,文档全错。
 *
 * 所以这里不做「文档里有没有这个词」的检查(那种断言删掉代码照样绿),而是把
 * 文档的说法**钉在代码的取值上**:改了代码里的后果描述、加了新的冲突提示、
 * 换了融合席位的挑法,文档不跟着改就红。
 */

const ROOT = new URL('../../../', import.meta.url)
const README = norm(readFileSync(new URL('README.md', ROOT), 'utf8'))
const ROLES_DOC = norm(readFileSync(new URL('docs/roles-setup.md', ROOT), 'utf8'))
const DOCS: [string, string][] = [
  ['README.md', README],
  ['docs/roles-setup.md', ROLES_DOC],
]

/** 代码里的注释用半角标点,文档用全角。比对前抹平,否则闸门只在跟标点较劲。 */
function norm(s: string): string {
  return s.replace(/,/g, '，').replace(/:/g, '：').replace(/;/g, '；').replace(/\(/g, '（').replace(/\)/g, '）')
}

const cfg = (skip: PhaseName[]): EffTaskConfig => ({ skipSteps: skip }) as unknown as EffTaskConfig

describe('文档说的和代码干的是同一件事', () => {
  it('每个环节被跳过的后果,两份文档都逐条写出来了', () => {
    // 关口把后果说给用户听,文档也必须说 —— 用户是先读文档再决定跳不跳的。
    for (const p of PHASE_NAMES) {
      // 关口对这个环节的原话(rosterLines 里那句 `${PHASE_LABEL[p]}: ${SKIP_CONSEQUENCE[p]}`)。
      // SKIP_CONSEQUENCE 没导出,从关口的实际输出里取,顺带证明它真的被接上了。
      const line = norm(rosterLineFor(p))
      const core = line.replace(/^[^（]*（已跳过 —— /, '').replace(/）$/, '')
      expect(core.length).toBeGreaterThan(8)
      for (const [name, doc] of DOCS) {
        expect(`${name} 缺 ${PHASE_LABEL[p]}: ${doc.includes(core)}`).toBe(`${name} 缺 ${PHASE_LABEL[p]}: true`)
      }
    }
  })

  it('关口能弹出来的每一条冲突提示,文档里都有对应说法', () => {
    // 手写的映射:代码里的提示 → 文档里必须出现的那句话的核心。
    // 加了新的冲突规则却没登记在这里,下面那条穷举断言会红。
    const REQUIRED: [RegExp, string][] = [
      [/连报 3 轮空产出后阻断/, '3 轮空产出后阻断'],
      [/评审席位.*空方案/, '空方案'],
      [/不会有任何代码改动/, '不会有任何代码改动'],
      [/任务树基本只有根节点/, '任务树基本只有根节点'],
    ]
    // 穷举 2^7 种跳过组合,收集关口所有可能说出口的话。
    const produced = new Set<string>()
    for (let mask = 0; mask < 1 << PHASE_NAMES.length; mask++) {
      const skip = PHASE_NAMES.filter((_, i) => mask & (1 << i))
      for (const l of skipConflictLines(cfg(skip))) produced.add(norm(l))
    }
    expect(produced.size).toBeGreaterThan(0)
    for (const msg of produced) {
      const hit = REQUIRED.find(([re]) => re.test(msg))
      // 未登记 = 代码新增了一条提示但没写进文档。
      expect(`未登记的关口提示: ${hit ? '无' : msg}`).toBe('未登记的关口提示: 无')
      for (const [name, doc] of DOCS) {
        expect(`${name} 缺「${hit![1]}」: ${doc.includes(hit![1])}`).toBe(`${name} 缺「${hit![1]}」: true`)
      }
    }
    // 反向:登记了却没有任何组合能触发 = 文档在描述一个不存在的提示。
    for (const [re, frag] of REQUIRED) {
      expect(`死规则「${frag}」: ${[...produced].some(m => re.test(m))}`).toBe(`死规则「${frag}」: true`)
    }
  })

  it('两份文档都讲清了「跳过」和「没配角色」不是一回事', () => {
    // 这正是上一版那句错话的内容。少了这层区分,用户会用「不配角色」去省调用,
    // 结果那一步照跑,只是换成主模型一个人干。
    for (const [name, doc] of DOCS) {
      expect(`${name}: ${/跳过\s*[≠!=]=?\s*没配角色|跳过和「?没配角色」?是两回事|没配角色的环节不是不发生/.test(doc)}`)
        .toBe(`${name}: true`)
      expect(`${name} 主模型顶上: ${doc.includes('主模型')}`).toBe(`${name} 主模型顶上: true`)
    }
    // 那句错话本身不许回来。
    expect(ROLES_DOC).not.toContain('没配角色的环节**整个不发生**')
    expect(ROLES_DOC).not.toContain('没配角色的环节就整个不发生')
  })

  it('文档写的配置键名就是代码真正读的那个', () => {
    const reader = readFileSync(new URL('src/tools/efftask/roleDefsFromSettings.ts', ROOT), 'utf8')
    expect(reader).toContain('efftaskSkipSteps')
    for (const [name, doc] of DOCS) {
      expect(`${name}: ${doc.includes('efftaskSkipSteps')}`).toBe(`${name}: true`)
    }
  })

  it('文档说的融合席位就是代码挑的那一席', () => {
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 文档承诺「融合席位是最后一席」。代码换成 seats[0] 而文档不改,用户就会
    // 把最强的员工排在末位,以为那个人在做融合。
    expect(src).toContain('seats[seats.length - 1]')
    expect(src).toContain("ctx.config.caps.planConverge === '圆桌'")
    for (const [name, doc] of DOCS) {
      expect(`${name} 最后一席: ${doc.includes('最后一席')}`).toBe(`${name} 最后一席: true`)
      expect(`${name} 落选稿: ${doc.includes('备选方案')}`).toBe(`${name} 落选稿: true`)
    }
  })
})

/** 关口名册里这一环节被跳过时的那一行。 */
function rosterLineFor(p: PhaseName): string {
  // 直接调 rosterLines 需要一份完整 config;这里只要跳过分支那一句,
  // 用关口自己的格式重建会变成自说自话,所以从源码里取 SKIP_CONSEQUENCE 的字面量。
  const src = readFileSync(new URL('src/tools/efftask/startupConfirm.ts', ROOT), 'utf8')
  const m = src.match(new RegExp(`^\\s*${p}: '([^']+)',`, 'm'))
  if (!m) throw new Error(`SKIP_CONSEQUENCE 里没有 ${p} —— 环节加了却没写后果`)
  return `${PHASE_LABEL[p]}: ${m[1]}`
}
