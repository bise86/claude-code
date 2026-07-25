import { describe, expect, it } from 'bun:test'
import { allowsPermissionDialogs } from './localJsxDialogs.js'
import efftask from '../../commands/efftask/index.js'

describe('local-jsx 命令的面板要不要给权限弹窗让路', () => {
  it('派子 agent 的命令让路', () => {
    expect(allowsPermissionDialogs({ spawnsSubagents: true })).toBe(true)
  })

  it('普通对话框命令不让路 —— 它自己没有在等任何审批', () => {
    // `/model`, `/config` 等:屏幕归它们own,权限弹窗盖上去只会打断用户。
    expect(allowsPermissionDialogs({})).toBe(false)
    expect(allowsPermissionDialogs({ spawnsSubagents: false })).toBe(false)
  })

  it('/et 必须声明它派子 agent', () => {
    // The whole point of the flag. `/et` 的执行阶段把会话真实的 canUseTool 交给带写工具的
    // 子 agent(efftask.tsx 直接透传 context.canUseTool),所以只要少了这一行,任务面板
    // 挂着的整段时间里 toolUseConfirm 队列都是不可见的:第一个需要审批的 Edit/Write/Bash
    // 就把 run 挂住 —— 有飞书桥时无声降级成"只能手机上批",没有桥时永远不返回。
    //
    // 这条断言守的是那一行本身。它下游还有两跳(processSlashCommand 把它写进
    // setToolJSX,REPL 用 `!toolJSX || toolJSX.shouldContinueAnimation` 读回来),那两跳
    // 都在没有测试接缝的大 React 模块里;REPL 那一跳今天由 forked 命令路径在生产上走着
    // (它一直显式传 shouldContinueAnimation: true)。
    expect(efftask.spawnsSubagents).toBe(true)
  })
})
