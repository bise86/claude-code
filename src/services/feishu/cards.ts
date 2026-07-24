export type QuestionSpec = { header: string; question: string; multiSelect: boolean; options: { label: string }[] }
export type Answer = { header: string; question: string; answers: string[] }
export type PermissionCardData = {
  requestId: string; toolName: string; summary: string
  kind: 'buttons' | 'plan' | 'question'; questions?: QuestionSpec[]; suggestion?: unknown
}
const txt = (content: string) => ({ tag: 'plain_text', content })
function button(content: string, value: Record<string, unknown>) {
  return { tag: 'button', text: txt(content), behaviors: [{ type: 'callback', value }] }
}
export function buildPermissionCard(d: PermissionCardData): object {
  const header = { title: txt(`确认：${d.toolName}`) }
  const body: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: '```\n' + d.summary + '\n```' } }]
  if (d.kind === 'plan') {
    body.push({ tag: 'action', actions: [
      button('批准计划', { requestId: d.requestId, behavior: 'allow' }),
      button('继续完善', { requestId: d.requestId, behavior: 'deny' }),
    ]})
  } else if (d.kind === 'question' && d.questions) {
    const elements = d.questions.flatMap((q, i) => {
      const opts = q.options.map(o => ({ text: txt(o.label), value: o.label }))
      opts.push({ text: txt('其它(填写)'), value: '__other__' })
      const selector = q.multiSelect
        ? { tag: 'multi_select_static', name: `q${i}`, placeholder: txt(q.question), options: opts }
        : { tag: 'select_static', name: `q${i}`, placeholder: txt(q.question), options: opts }
      return [{ tag: 'div', text: txt(q.question) }, selector,
        { tag: 'input', name: `q${i}_other`, placeholder: txt('如选其它，请在此填写') }]
    })
    body.push({ tag: 'form', name: 'form', elements: [
      ...elements,
      { tag: 'button', text: txt('提交'), action_type: 'form_submit',
        behaviors: [{ type: 'callback', value: { requestId: d.requestId, behavior: 'allow', form: true } }] },
    ]})
  } else {
    body.push({ tag: 'action', actions: [
      button('允许一次', { requestId: d.requestId, behavior: 'allow' }),
      button('总是允许', { requestId: d.requestId, behavior: 'allow', always: true, suggestion: d.suggestion ?? null }),
      button('拒绝', { requestId: d.requestId, behavior: 'deny' }),
    ]})
  }
  return { config: { wide_screen_mode: true }, header, elements: body }
}
export function buildResolvedCard(d: PermissionCardData, winner: string, behavior: 'allow'|'deny'|'cancelled'): object {
  const label = behavior === 'allow' ? '✅ 已允许' : behavior === 'deny' ? '❌ 已拒绝' : '⏹ 已取消'
  const via = winner === 'terminal' ? '终端' : winner === 'feishu' ? '飞书' : winner
  return { config: { wide_screen_mode: true }, header: { title: txt(`确认：${d.toolName}`) },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: '```\n' + d.summary + '\n```' } },
      { tag: 'div', text: txt(`${label}（${via}）`) }] }
}
export function formValueToAnswers(questions: QuestionSpec[], formValue: Record<string, unknown>): { answers: Answer[] } {
  const answers = questions.map((q, i) => {
    const raw = formValue[`q${i}`]
    let picked = Array.isArray(raw) ? raw.slice() : raw != null ? [raw as string] : []
    if (picked.includes('__other__')) {
      const other = formValue[`q${i}_other`]
      picked = picked.filter(v => v !== '__other__')
      if (typeof other === 'string' && other.trim()) picked.push(other.trim())
    }
    return { header: q.header, question: q.question, answers: picked }
  })
  return { answers }
}
