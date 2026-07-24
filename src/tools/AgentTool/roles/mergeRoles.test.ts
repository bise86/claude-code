import { describe, it, expect } from 'bun:test'
import { filterCollidingRoles } from '../loadAgentsDir.js'

describe('filterCollidingRoles', () => {
  it('drops roles whose name collides with a built-in agentType and keeps others', () => {
    const builtinTypes = new Set(['general-purpose', 'Explore'])
    const roles = [
      { agentType: 'general-purpose' } as any,  // 撞名 → 丢
      { agentType: 'reviewer' } as any,          // 保留
    ]
    const kept = filterCollidingRoles(roles, builtinTypes)
    expect(kept.map(r => r.agentType)).toEqual(['reviewer'])
  })
})
