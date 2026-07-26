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
  it('skips a cli role with no command (would crash Bun.spawn(undefined)) instead of registering it', () => {
    const out = parseRoles([{ name: 'nocommand', whenToUse: 'w', execMode: 'cli' }], 'userSettings')
    expect(out).toHaveLength(0)
  })
  it('skips an api role missing apiUrl (would crash new URL(undefined)) instead of registering it', () => {
    const out = parseRoles([{ name: 'noapiurl', whenToUse: 'w', execMode: 'api', apiProtocol: 'openai', apiToken: 'sk', model: 'gpt-4o' }], 'userSettings')
    expect(out).toHaveLength(0)
  })
  it('validates roles individually: one bad role in a multi-role array does not drop its valid siblings', () => {
    const out = parseRoles([
      { name: 'good1', whenToUse: 'w1', execMode: 'cli', command: 'adapter1' },
      { name: 'good2', whenToUse: 'w2', execMode: 'cli', command: 'adapter2' },
      { name: 'bad-missing-apitoken', whenToUse: 'broken', execMode: 'api', apiUrl: 'https://x/v1', model: 'gpt-4o' },
      { name: 'good3', whenToUse: 'w3', execMode: 'api', apiUrl: 'https://y/v1', apiToken: 'sk', model: 'claude' },
      { name: 'good4', whenToUse: 'w4', execMode: 'cli', command: 'adapter4' },
    ], 'userSettings')
    const names = out.map(o => o.agentDef.agentType)
    expect(names).not.toContain('bad-missing-apitoken')
    expect(names).toContain('good1')
    expect(names).toContain('good2')
    expect(names).toContain('good3')
    expect(names).toContain('good4')
    expect(out).toHaveLength(4)
  })
})

describe('员工侧的 efftaskRoles 声明', () => {
  const api = (over: object = {}) => ({
    name: 'ds-安全', whenToUse: 'w', execMode: 'api',
    apiUrl: 'https://x', apiToken: 'sk-x', model: 'm', ...over,
  })

  it('带 efftaskRoles 的员工能被收下,字段原样保留', () => {
    // RoleSchema 是 .strict()。少了这个字段声明,后果不是「这个字段没生效」,而是
    // **整条员工被跳过 = 这个员工不存在** —— 用户看到的是自己配好的模型凭空消失。
    // 此前这条路径零覆盖:roleDefsFromSettings 的测试全部走注入的 read 接缝,
    // 完全绕开 zod,所以删掉那行声明整套测试依然全绿。
    const out = parseRoles([api({ efftaskRoles: ['架构师', '安全'] })], 'userSettings')
    expect(out).toHaveLength(1)
    expect(out[0].role.efftaskRoles).toEqual(['架构师', '安全'])
  })

  it('不写 efftaskRoles 的员工照常被收下', () => {
    expect(parseRoles([api()], 'userSettings')).toHaveLength(1)
  })

  it('efftaskRoles 写成字符串(漏了方括号)→ 整条员工被拒,这是 .strict() 的既定行为', () => {
    expect(parseRoles([api({ efftaskRoles: '安全' })], 'userSettings')).toHaveLength(0)
  })

  it('真正未声明的键仍然被拒 —— 这条声明没有把 schema 变松', () => {
    expect(parseRoles([api({ 完全没听说过的键: 1 })], 'userSettings')).toHaveLength(0)
  })
})
