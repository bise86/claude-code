// src/tools/efftask/parseOutput.test.ts
import { describe, expect, it } from 'bun:test'
import { extractJsonBlock, parsePlanOutput, parseVerdict, parseExecOutput } from './parseOutput.js'

describe('parseOutput', () => {
  it('extractJsonBlock finds fenced json', () => {
    expect(extractJsonBlock('noise\n```json\n{"a":1}\n```\ntail')).toEqual({ a: 1 })
  })
  it('extractJsonBlock finds bare object', () => {
    expect(extractJsonBlock('prefix {"a":2} suffix')).toEqual({ a: 2 })
  })
  it('extractJsonBlock returns null when none', () => {
    expect(extractJsonBlock('no json here')).toBeNull()
  })
  it('extractJsonBlock prefers the LAST parseable fence when there are two', () => {
    const text = 'blah\n```json\n{"a":1}\n```\nmiddle\n```json\n{"a":2}\n```\ntail'
    expect(extractJsonBlock(text)).toEqual({ a: 2 })
  })
  it('extractJsonBlock: echoed plan fence then verdict fence => verdict wins', () => {
    const text =
      '我先回顾一下上一阶段的方案:\n```json\n{"kind":"executable","solution":"旧方案"}\n```\n' +
      '基于以上,我的裁决是:\n```json\n{"pass":false,"blocking":["缺验收点"],"comments":""}\n```'
    expect(extractJsonBlock(text)).toEqual({ pass: false, blocking: ['缺验收点'], comments: '' })
  })
  it('parsePlanOutput decompose with children', () => {
    const out = parsePlanOutput('```json\n{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a","children":[{"title":"c1","deps":[]},{"title":"c2","deps":["c1"]}]}\n```')
    expect(out.kind).toBe('decompose')
    expect(out.plan.solution).toBe('s')
    expect(out.children).toEqual([{ title: 'c1', deps: [] }, { title: 'c2', deps: ['c1'] }])
  })
  it('parsePlanOutput defaults to executable on garbage', () => {
    const out = parsePlanOutput('the model rambled with no json')
    expect(out.kind).toBe('executable')
    expect(out.children).toEqual([])
  })
  it('parseVerdict pass', () => {
    const v = parseVerdict('```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```', 'main')
    expect(v).toEqual({ role: 'main', pass: true, blocking: [], comments: 'ok' })
  })
  it('parseVerdict unparseable => fail with blocking', () => {
    const v = parseVerdict('garbage', 'main')
    expect(v.pass).toBe(false)
    expect(v.blocking.length).toBeGreaterThan(0)
  })
  it('parseExecOutput falls back to raw text', () => {
    expect(parseExecOutput('did the thing').execStatus).toContain('did the thing')
    expect(parseExecOutput('```json\n{"execStatus":"done X"}\n```').execStatus).toBe('done X')
  })
})
