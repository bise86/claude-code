/**
 * 追加指令输入框的按键规则。
 *
 * 最重的一条是 `isActive`:`/et` 声明了 spawnsSubagents,权限对话框会画在这一屏**之上**,
 * 而 ink 的 useInput 是广播的 —— 缺了守卫,一下回车既提交了指令**又批准了待确认的工具**,
 * 而执行环节的确认可以是带写能力的 Bash。这是任务树面板刚修过的同一个坑,在新组件上重开,
 * 由验收员实测抓到。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render, Text, useInput } from '../../ink.js'
import { AddDirective } from './AddDirective.js'

/**
 * 必须**等过 ink 的转义消歧窗口**(App.tsx 里是 50ms)。30ms 的话裸 ESC 根本不会被
 * 派发,于是「Esc 取消」那条恒假 —— 本轮在别处也踩过同一个坑。
 */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 120))
// 字面量 ESC 会被写文件那一步吞掉,必须显式转义(本轮踩过)。
const ESC = '\u001b'

function fakeTty() {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

/** 冒充画在输入框之上的权限对话框:它也装了一个 useInput。 */
function FakePermissionDialog(props: { onApprove: () => void }): React.ReactElement {
  useInput((_i, key) => { if (key.return) props.onApprove() })
  return <Text>批准这次工具调用?</Text>
}

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('权限对话框画在上面时,键盘归它', () => {
  it('一下回车**不能**既提交指令又批准工具', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <>
        <AddDirective
          isActive={false}
          existing={0}
          onSubmit={x => log.push(`提交:${x}`)}
          onCancel={() => log.push('取消')}
        />
        <FakePermissionDialog onApprove={() => log.push('批准了工具')} />
      </>,
    )
    t.stdin.press('别动 src/legacy'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    // 输入框让出键盘之后,这一下回车只属于对话框。
    expect(log).toEqual(['批准了工具'])
  })

  it('对话框收走之后,输入框拿回键盘', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <AddDirective isActive existing={0} onSubmit={x => log.push(`提交:${x}`)} onCancel={() => {}} />,
    )
    t.stdin.press('改用 JWT'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(log).toEqual(['提交:改用 JWT'])
  })
})

describe('输入规则', () => {
  const submit = async (keys: string[], isActive = true) => {
    const log: string[] = []
    const { t, app } = await mount(
      <AddDirective isActive={isActive} existing={0} onSubmit={x => log.push(x)} onCancel={() => log.push('CANCEL')} />,
    )
    for (const k of keys) { t.stdin.press(k); await tick() }
    app.unmount()
    return log
  }

  it('粘贴多行时换行折成空格,而不是被静默拼掉', async () => {
    // 直接滤掉换行的话「不要动 A\n删掉 B」变成「不要动 A删掉 B」,语义都变了。
    expect(await submit(['不要动 A\n删掉 B', '\r'])).toEqual(['不要动 A 删掉 B'])
  })

  it('只输空格回车 = 取消,不提交一条空指令', async () => {
    // 空指令会在提示词里留一个空槽,而模型会努力去理解它。
    expect(await submit(['   ', '\r'])).toEqual(['CANCEL'])
  })

  it('Esc 取消', async () => {
    expect(await submit(['一些字', ESC])).toEqual(['CANCEL'])
  })

  it('控制字符不进正文 —— 它们会真的作用在终端上', async () => {
    // 实测:\u001b[2J 这类完整的转义序列被 ink 的输入解析器整个吃掉,**根本不会**
    // 作为文本派发过来 —— 比我原先假设的(只滤掉 ESC 那一个字节、留下 '[2J')更干净。
    // 断言写成实测结果,而不是写成我以为的那样。
    expect(await submit(['正常文字\u001b[2J尾巴', '\r'])).toEqual(['正常文字尾巴'])
    // 裸的控制字节(BEL)同样进不来。
    expect(await submit(['前\u0007后', '\r'])).toEqual(['前后'])
  })
})
