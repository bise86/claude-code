/**
 * 「这条路径是别人机器上的」这条提示。
 *
 * 用户实测:任务里反复去读
 * `file:///Users/zhilin/Projects/cesi/app/src/app/App.tsx` —— 而他在 Linux 上跑
 * `/home/esgyn/work/tmp/3d-print-web`。这种路径的典型来源是 source map / 构建产物里嵌的
 * **打包那台机器**的绝对路径;Grep 一命中,模型就照着去 Read,然后一连串
 * 「File does not exist」。
 *
 * 它原来拿到的提示里一个字都没说这条路径不属于这台机器 —— 于是它接着换着法儿试。
 */
import { describe, expect, it } from 'bun:test'

import { foreignHomePathHint } from './file.js'

const CWD = '/home/esgyn/work/tmp/3d-print-web'

describe('认出别人机器上的家目录', () => {
  it('用户报的那一条', () => {
    const hint = foreignHomePathHint('/Users/zhilin/Projects/cesi/app/src/app/App.tsx', CWD)!
    expect(hint).toContain('/Users/zhilin')
    // 光说「不存在」没用,要说**为什么会出现这种路径**,以及**改怎么做**。
    expect(hint).toContain('source map')
    expect(hint).toContain('Glob')
  })

  it('另一个 Linux 用户的家目录同样算', () => {
    expect(foreignHomePathHint('/home/someoneelse/proj/a.ts', CWD)).toBeTruthy()
  })

  it('Windows 的形态也认', () => {
    expect(foreignHomePathHint('C:\\Users\\bob\\proj\\a.ts', 'D:\\work\\repo')).toBeTruthy()
  })
})

describe('不该误报的情况', () => {
  it('就在当前工作目录下的路径不算', () => {
    expect(foreignHomePathHint(`${CWD}/src/App.tsx`, CWD)).toBeUndefined()
  })

  it('**本机同一个家目录**下的别处也不算 —— 那只是路径写错了', () => {
    // 扯 source map 会把一次普通的笔误引向完全错误的方向。
    expect(foreignHomePathHint('/home/esgyn/别的项目/a.ts', '/home/esgyn/work/tmp/3d-print-web'))
      .toBeUndefined()
  })

  it('cwd 恰好就是家目录本身时也不算', () => {
    expect(foreignHomePathHint('/home/esgyn/a.ts', '/home/esgyn')).toBeUndefined()
  })

  it('不是家目录形态的绝对路径不提 —— 读 /etc、/tmp 失败时扯 source map 是纯噪音', () => {
    expect(foreignHomePathHint('/etc/hosts', CWD)).toBeUndefined()
    expect(foreignHomePathHint('/tmp/x/y.ts', CWD)).toBeUndefined()
    expect(foreignHomePathHint('/opt/tools/a', CWD)).toBeUndefined()
  })

  it('相对路径不提', () => {
    expect(foreignHomePathHint('src/App.tsx', CWD)).toBeUndefined()
    expect(foreignHomePathHint('./a.ts', CWD)).toBeUndefined()
  })

  it('前缀相同但不是同一个目录 —— 方向也要对', () => {
    // 关键是**这个**方向:目标在 /home/esgyn 下,而 cwd 在 /home/esgyn2 下。
    // 判据写成 cwd.startsWith(theirs) 不带分隔符的话,'/home/esgyn2/work' 会被判成
    // 「就在 /home/esgyn 里」,于是漏报 —— 而它们是两个不同的用户。
    expect(foreignHomePathHint('/home/esgyn/proj/a.ts', '/home/esgyn2/work')).toBeTruthy()
    // 反方向也要报。
    expect(foreignHomePathHint('/home/esgyn2/proj/a.ts', '/home/esgyn/work')).toBeTruthy()
  })
})
