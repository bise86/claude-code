import { describe, it, expect } from 'bun:test'
import { resolveRoleFetch } from '../../../query.js'

describe('resolveRoleFetch', () => {
  it('returns a role fetch when roleClientConfig present', () => {
    const f = resolveRoleFetch({ apiProtocol: 'anthropic', apiUrl: 'https://r', apiToken: 't', backendModel: 'm' }, undefined)
    expect(typeof f).toBe('function')
  })
  it('falls back to dumpPromptsFetch when no roleClientConfig', () => {
    const dump = (() => {}) as any
    expect(resolveRoleFetch(undefined, dump)).toBe(dump)
  })
})
