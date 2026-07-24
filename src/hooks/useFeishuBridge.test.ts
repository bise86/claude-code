import { describe, it, expect } from 'bun:test'
import { wireCardAction } from './useFeishuBridge.js'
import { createFeishuPermissionCallbacks } from '../services/feishu/feishuPermissions.js'

describe('wireCardAction', () => {
  it('button click → allow with permissionUpdates from embedded suggestion when always', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    const handler = wireCardAction(cb, new Map())
    handler({ action: { value: { requestId: 'r1', behavior: 'allow', always: true, suggestion: { rule: 'x' } } } })
    expect(got.behavior).toBe('allow')
    expect(got.permissionUpdates).toEqual([{ rule: 'x' }])
  })
  it('form submit → allow with answers built from form_value', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    const qById = new Map([['r1', [{ header: 'DB', question: 'which?', multiSelect: false, options: [{ label: 'pg' }] }]]])
    const handler = wireCardAction(cb, qById)
    handler({ action: { value: { requestId: 'r1', behavior: 'allow', form: true }, form_value: { q0: 'pg' } } })
    expect(got.updatedInput).toEqual({ answers: { 'which?': 'pg' } })
  })
  it('deny → behavior deny', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    wireCardAction(cb, new Map())({ action: { value: { requestId: 'r1', behavior: 'deny' } } })
    expect(got.behavior).toBe('deny')
  })
})
