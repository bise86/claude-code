import { describe, it, expect } from 'bun:test'
import { buildPermissionCard, buildResolvedCard, formValueToAnswers } from './cards.js'

describe('buildPermissionCard', () => {
  it('normal tool → three button actions carrying requestId+behavior', () => {
    const card: any = buildPermissionCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls -la', kind: 'buttons' })
    const flat = JSON.stringify(card)
    expect(flat).toContain('允许一次'); expect(flat).toContain('总是允许'); expect(flat).toContain('拒绝')
    expect(flat).toContain('"requestId":"r1"'); expect(flat).toContain('"behavior":"allow"'); expect(flat).toContain('"behavior":"deny"')
  })
  it('plan kind → approve/keep-refining buttons', () => {
    const flat = JSON.stringify(buildPermissionCard({ requestId: 'r1', toolName: 'ExitPlanMode', summary: 'plan', kind: 'plan' }))
    expect(flat).toContain('批准计划'); expect(flat).toContain('继续完善')
  })
  it('question kind → form with select per question, not bare buttons', () => {
    const card: any = buildPermissionCard({ requestId: 'r1', toolName: 'AskUserQuestion', summary: '', kind: 'question',
      questions: [{ header: 'DB', question: 'which?', multiSelect: false, options: [{ label: 'pg' }, { label: 'mysql' }] }] })
    const flat = JSON.stringify(card)
    expect(flat).toContain('form'); expect(flat).toContain('pg'); expect(flat).toContain('mysql')
  })
})

describe('buildResolvedCard', () => {
  it('renders terminal state and disables interaction', () => {
    const flat = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'terminal', 'allow'))
    expect(flat).toContain('已允许'); expect(flat).toContain('终端')
    expect(flat).not.toContain('"behavior":"allow"') // 无可点回传按钮
  })
  it('renders a readable label (not raw English) for hook/classifier/recheck winners', () => {
    const hook = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'hook', 'allow'))
    expect(hook).toContain('钩子'); expect(hook).not.toContain('hook')
    const classifier = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'classifier', 'allow'))
    expect(classifier).toContain('分类器'); expect(classifier).not.toContain('classifier')
    const recheck = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'recheck', 'allow'))
    expect(recheck).toContain('复核'); expect(recheck).not.toContain('recheck')
  })
  it('falls back to the raw winner string for an unknown winner', () => {
    const flat = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'bridge', 'allow'))
    expect(flat).toContain('bridge')
  })
})

describe('formValueToAnswers', () => {
  const qs = [
    { header: 'DB', question: 'which db?', multiSelect: false, options: [{ label: 'pg' }, { label: 'mysql' }] },
    { header: 'Feat', question: 'features?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
  ]
  // The real AskUserQuestionTool consumes answers via
  // Object.entries(answers).map(([questionText, answer]) => ...) — so the
  // result MUST be a plain Record<questionText, answerString>, keyed by the
  // question TEXT, not an array of {header,question,answers[]} objects.
  it('maps single-select to a string keyed by question text', () => {
    const out = formValueToAnswers(qs, { q0: 'pg', q1: ['a', 'b'] })
    expect(out).toEqual({ answers: {
      'which db?': 'pg',
      'features?': 'a, b',
    }})
  })
  it('is a plain Record whose Object.entries pairs are [questionText, answerString]', () => {
    const out = formValueToAnswers(qs, { q0: 'pg', q1: ['a', 'b'] })
    expect(out.answers.constructor).toBe(Object)
    expect(Object.entries(out.answers)).toEqual([
      ['which db?', 'pg'],
      ['features?', 'a, b'],
    ])
  })
  it('joins multi-select labels with ", "', () => {
    const out = formValueToAnswers(qs, { q0: 'mysql', q1: ['a', 'b'] })
    expect(out.answers['features?']).toBe('a, b')
  })
  it('uses Other free-text when provided', () => {
    const out = formValueToAnswers(qs, { q0: '__other__', q0_other: 'sqlite', q1: [] })
    expect(out.answers['which db?']).toBe('sqlite')
  })
})
