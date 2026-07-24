import { describe, it, expect } from 'bun:test'
import { parseRoles } from './rolesFromSettings.js'

describe('parseRoles', () => {
  it('parses an api role and KEEPS the api client fields (not stripped)', () => {
    const out = parseRoles([{ name: 'rev', whenToUse: 'review', execMode: 'api',
      apiProtocol: 'openai', apiUrl: 'https://x/v1', apiToken: 'sk', model: 'gpt-4o', thinkingDepth: 'high' }], 'userSettings')
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.agentType).toBe('rev')
    expect(out[0].agentDef.whenToUse).toBe('review')
    expect(out[0].agentDef.execMode).toBe('api')
    expect(out[0].agentDef.roleClientConfig).toEqual({ apiProtocol: 'openai', apiUrl: 'https://x/v1', apiToken: 'sk', backendModel: 'gpt-4o', thinkingDepth: 'high' })
  })
  it('parses a cli role keeping command/args/interactive', () => {
    const out = parseRoles([{ name: 'c', whenToUse: 'w', execMode: 'cli', command: 'adapter', args: ['--json'], interactive: true }], 'localSettings')
    expect(out[0].agentDef.execMode).toBe('cli')
    expect(out[0].agentDef.command).toBe('adapter')
    expect(out[0].agentDef.interactive).toBe(true)
  })
  it('skips invalid role (missing name) without throwing', () => {
    expect(parseRoles([{ whenToUse: 'w', execMode: 'api' }], 'userSettings')).toHaveLength(0)
  })
  it('wraps prompt string into getSystemPrompt', async () => {
    const out = parseRoles([{ name: 'p', whenToUse: 'w', execMode: 'cli', command: 'x', prompt: 'SYS' }], 'userSettings')
    const sp = await out[0].agentDef.getSystemPrompt?.({} as any)
    expect(sp).toContain('SYS')
  })
  it('normalizes a valid thinkingDepth into effort and roleClientConfig.thinkingDepth', () => {
    const out = parseRoles([{ name: 'rev', whenToUse: 'review', execMode: 'api',
      apiProtocol: 'anthropic', apiUrl: 'https://x/v1', apiToken: 'sk', model: 'claude', thinkingDepth: 'High' }], 'userSettings')
    expect(out[0].agentDef.effort).toBe('high')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBe('high')
  })
  it('drops an invalid thinkingDepth to undefined effort instead of forwarding a bad string', () => {
    const out = parseRoles([{ name: 'rev', whenToUse: 'review', execMode: 'api',
      apiProtocol: 'anthropic', apiUrl: 'https://x/v1', apiToken: 'sk', model: 'claude', thinkingDepth: 'deep' }], 'userSettings')
    expect(out[0].agentDef.effort).toBeUndefined()
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBeUndefined()
  })
  it('getSystemPrompt is always a callable function, even when prompt is absent', async () => {
    const out = parseRoles([{ name: 'noprompt', whenToUse: 'w', execMode: 'cli', command: 'x' }], 'userSettings')
    expect(typeof out[0].agentDef.getSystemPrompt).toBe('function')
    const sp = await out[0].agentDef.getSystemPrompt({} as any)
    expect(sp).toBe('')
  })
})
