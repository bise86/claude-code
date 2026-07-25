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

  // Recency alone is not a safe selector: models recap context AFTER answering just
  // as often as they echo it before. Each parser must take the newest block that
  // matches ITS shape, so a trailing distractor of a different shape is skipped.
  it('parseVerdict: real verdict first, trailing plan recap => still the verdict', () => {
    const text =
      '我的裁决:\n```json\n{"pass":false,"blocking":["仍缺压测数据"],"comments":"不通过"}\n```\n' +
      '供参考,本节点的方案是:\n```json\n{"solution":"旧方案","acceptance":"a"}\n```'
    const v = parseVerdict(text, 'sec')
    expect(v.pass).toBe(false)
    expect(v.blocking).toEqual(['仍缺压测数据'])
  })
  it('parsePlanOutput: real plan first, trailing goal echo => still the plan', () => {
    const text =
      '方案如下:\n```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":[]}]}\n```\n' +
      '再贴一下目标供参考:\n```json\n{"goal":"把功能做完","owner":"me"}\n```'
    const out = parsePlanOutput(text)
    expect(out.kind).toBe('decompose')
    expect(out.plan.solution).toBe('s')
    expect(out.children).toEqual([{ title: 'AA', deps: [] }])
  })
  it('parseExecOutput: real status first, trailing template echo => still the status', () => {
    const text =
      '```json\n{"execStatus":"已完成:实现缓存层,单测全通过"}\n```\n' +
      '(模板提醒)\n```json\n{"note":"请按上面格式填写"}\n```'
    expect(parseExecOutput(text).execStatus).toBe('已完成:实现缓存层,单测全通过')
  })
  it('prefers an explicitly json-tagged fence over a stray code fence that parses', () => {
    const text =
      '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```\n' +
      '附上工具输出:\n```bash\n{"pass":false,"blocking":["来自无关的日志"]}\n```'
    const v = parseVerdict(text, 'main')
    expect(v.pass).toBe(true)
  })
  it('never throws on empty or whitespace input', () => {
    for (const t of ['', '   \n\t ']) {
      expect(() => parsePlanOutput(t)).not.toThrow()
      expect(() => parseVerdict(t, 'r')).not.toThrow()
      expect(() => parseExecOutput(t)).not.toThrow()
      expect(extractJsonBlock(t)).toBeNull()
    }
    expect(parseVerdict('', 'r').pass).toBe(false) // fails closed
  })
})
