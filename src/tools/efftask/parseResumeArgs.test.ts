import { describe, expect, it } from 'bun:test'
import { parseResumeArgs } from './parseResumeArgs.js'

describe('parseResumeArgs', () => {
  it('a plain prompt stays a new run', () => {
    expect(parseResumeArgs('做个登录功能')).toEqual({ mode: 'new', guidance: '', rest: '做个登录功能', retryBlocked: false })
  })

  it('preserves the new-run prompt byte for byte', () => {
    // rest becomes goalPrompt → the root node's goal and title → every plan prompt.
    // Trimming or collapsing whitespace here silently edits the user's objective.
    const raw = '  第一行\n\n   第二行  '
    expect(parseResumeArgs(raw).rest).toBe(raw)
  })

  it('a prompt that merely mentions --resume is still a new run', () => {
    const raw = '给 /et 加一个 --resume 参数'
    expect(parseResumeArgs(raw)).toMatchObject({ mode: 'new', rest: raw })
  })

  it('--resume alone means "let me pick"', () => {
    expect(parseResumeArgs('--resume')).toEqual({ mode: 'resume', guidance: '', rest: '', retryBlocked: false })
    expect(parseResumeArgs('  --resume  ').runId).toBeUndefined()
  })

  it('--resume <id> targets one run', () => {
    expect(parseResumeArgs('--resume 003')).toMatchObject({ mode: 'resume', runId: '003', guidance: '' })
  })

  it('zero-pads a short id so --resume 3 finds directory 003', () => {
    expect(parseResumeArgs('--resume 3').runId).toBe('003')
    expect(parseResumeArgs('--resume 42').runId).toBe('042')
    // allocateRunId keeps counting past 999, so four digits must stay four digits.
    expect(parseResumeArgs('--resume 1024').runId).toBe('1024')
  })

  it('--resume latest is passed through for listRuns to resolve', () => {
    expect(parseResumeArgs('--resume latest')).toMatchObject({ mode: 'resume', runId: 'latest' })
  })

  it('everything after the id is guidance, spaces and all', () => {
    expect(parseResumeArgs('--resume 003 跳过压测部分,先把 API 打通'))
      .toMatchObject({ mode: 'resume', runId: '003', guidance: '跳过压测部分,先把 API 打通' })
    expect(parseResumeArgs('--resume latest 之前方案太复杂,后面从简').guidance).toBe('之前方案太复杂,后面从简')
  })

  it('a non-id first word is guidance, not a run id', () => {
    // '--resume 先从简' must not be read as run '先从简' and then 404 the user.
    const got = parseResumeArgs('--resume 先从简')
    expect(got.runId).toBeUndefined()
    expect(got).toMatchObject({ mode: 'resume', guidance: '先从简' })
  })
})

describe('--retry-blocked (触阀后人工重试, spec §9/§11)', () => {
  it('is off unless asked for — a valve must not re-arm itself', () => {
    expect(parseResumeArgs('--resume 003').retryBlocked).toBe(false)
    expect(parseResumeArgs('--resume 003 先做鉴权').retryBlocked).toBe(false)
  })

  it('is recognised after the run id, and does not become guidance', () => {
    // Guidance is interpolated into every later plan/execute prompt. A flag left in it would
    // reach the model as an instruction.
    const r = parseResumeArgs('--resume 003 --retry-blocked 先做鉴权')
    expect(r).toMatchObject({ mode: 'resume', runId: '003', guidance: '先做鉴权', retryBlocked: true })
  })

  it('is recognised BEFORE the run id too — the card shows one order, users type another', () => {
    expect(parseResumeArgs('--resume --retry-blocked 003')).toMatchObject({ runId: '003', retryBlocked: true })
  })

  it('works with no id and no guidance', () => {
    expect(parseResumeArgs('--resume --retry-blocked')).toEqual({ mode: 'resume', guidance: '', rest: '', retryBlocked: true })
  })

  it('works with latest', () => {
    expect(parseResumeArgs('--resume latest --retry-blocked')).toMatchObject({ runId: 'latest', retryBlocked: true })
  })

  it('does not touch a NEW run whose prompt happens to contain the words', () => {
    // rest becomes goalPrompt verbatim — the root node's goal, title, and every plan prompt.
    const raw = '给 /et 加一个 --retry-blocked 参数'
    expect(parseResumeArgs(raw)).toEqual({ mode: 'new', guidance: '', rest: raw, retryBlocked: false })
  })
})
