import { describe, it, expect } from 'bun:test'
import { buildConflictCard, escalationLines } from './conflictEscalation.js'
import { createNode, emptyPhaseRoles } from './types.js'

const NOW = '2026-01-01T00:00:00.000Z'
const node = () =>
  createNode({ id: 'root/02', title: '接入支付回调', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('冲突升级卡', () => {
  it('carries every fact the human needs to act, without hunting for the run', () => {
    const lines = escalationLines(
      { node: node(), branch: 'efftask/007/n-ab12cd34', path: '/repo/.efftask-worktrees/n-ab12cd34', files: ['src/pay.ts', 'src/api.ts'] },
      '007',
    )
    const text = lines.join('\n')
    expect(text).toContain('接入支付回调')
    expect(text).toContain('root/02')
    expect(text).toContain('efftask/007/n-ab12cd34')
    expect(text).toContain('/repo/.efftask-worktrees/n-ab12cd34')
    expect(text).toContain('src/pay.ts、src/api.ts')
    // The resume command, spelled out with the real id. Without it the user has to go find
    // which run this was before they can restart it.
    expect(text).toContain('/et --resume 007')
    // It must say the machine already tried — otherwise the obvious first reaction is
    // "just retry the merge", which is exactly what already failed.
    expect(text).toContain('已自动尝试解决一次未成功')
  })

  it('still names the run even when the id was not threaded through', () => {
    // A placeholder is honest; silently omitting the resume step is not.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'] }).join('\n')
    expect(text).toContain('/et --resume <运行 ID>')
  })

  it('says so when the conflict file list could not be read', () => {
    // An empty "冲突文件:" line reads as "no files conflicted", which would be a lie about
    // the one thing the user is being woken up for.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: [] }, '1').join('\n')
    expect(text).toContain('未能读出文件列表')
  })

  it('renders a red-header card whose body is the same lines', () => {
    const e = { node: node(), branch: 'b', path: '/p', files: ['x.ts'] }
    const card = buildConflictCard(e, '007') as {
      header: { template: string; title: { content: string } }
      elements: { text: { content: string } }[]
    }
    // Red: this card is a stop, not a request — it must not look like the startup prompt.
    expect(card.header.template).toBe('red')
    expect(card.header.title.content).toContain('合并冲突')
    for (const line of escalationLines(e, '007')) expect(card.elements[0]!.text.content).toContain(line)
  })
})
