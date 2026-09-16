import { ANSWER_TAGS, answerTag, parseTaskIdOutput } from './parseOutput.js'
import { taskIdRulePrompt } from './taskIdentity.js'

/** 手工新增没有方案作者替它生成 ID,因此在占额度、改树之前完成这一小步。 */
export async function generateTaskId(args: {
  rule: string
  title: string
  prompt: string
  modelJson: (prompt: string) => Promise<string>
}): Promise<string> {
  const tag = answerTag(ANSWER_TAGS.identity)
  const prompt = '请根据 ID 生成规则和下面这个任务实际处理的对象,计算该任务的 ID。' +
    '本次只生成 ID,不要执行任务,也不要派发子任务。\n' +
    taskIdRulePrompt(args.rule) +
    `任务标题:${JSON.stringify(args.title)}\n任务内容:${JSON.stringify(args.prompt)}\n` +
    '只输出一个本次回答的代码块,语言标记(fence info string)写成 ' + tag +
    ',内容是 {"taskId":"根据实际任务计算出的具体字符串"}。无法确定任务对象时 taskId 填 null,不要编造 ID。'
  const id = parseTaskIdOutput(await args.modelJson(prompt), tag)
  if (id === undefined || id === args.rule) throw new Error('无法根据任务 ID 规则确定具体 ID,本次没有新增任务。请在任务内容中写明要处理的对象。')
  return id
}
