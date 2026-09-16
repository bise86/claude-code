import { randomUUID } from 'node:crypto'
import type { TaskNode } from './types.js'

/** ID 按原字符串比较,不截断、不改变大小写,也不拿它拼文件路径。 */
export function taskIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 明确写出的生成规则无需模型抽取。自然语言规则由需求解析器提取。 */
export function taskIdRuleFromPrompt(prompt: string): string | undefined {
  const match = prompt.match(/^[ \t]*(?:任务[ \t]*ID[ \t]*规则|taskIdRule)[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t\r]*$/im)
  return taskIdOf(match?.[1])
}

/** 所有会生成任务的席位共用同一份规则说明。 */
export function taskIdRulePrompt(rule: string): string {
  return `任务 ID 生成规则:${JSON.stringify(rule)}。\n` +
    '创建每个任务之前,根据该任务实际处理的对象计算具体的 taskId 字符串。' +
    '不同任务按各自对象生成 ID;同一任务在不同轮次、不同父任务下被再次提出时,必须得到同一个 ID。' +
    '不要把规则的文字当成 ID,不要复用父任务 ID,不要附加随机数、轮次或派发序号。' +
    '例如规则是“任务 ID 用文件相对路径”,处理 src/a.ts 的任务就填 src/a.ts,处理 src/b.ts 就填 src/b.ts。' +
    '相对路径以项目根目录为基准,统一使用 /,去掉多余的 ./;不要使用隔离工作区的绝对路径。\n'
}

export function ensureTaskId(node: TaskNode): string {
  return node.taskId = taskIdOf(node.taskId) ?? randomUUID()
}

/** 一棵活树共用一份预留表。预留和查重同步完成,不能在中间 await。 */
const reservations = new WeakMap<object, Set<string>>()
const scopeOf = (byId: Map<string, TaskNode>): object => byId.get('root') ?? byId

export function findTask(byId: Map<string, TaskNode>, taskId: string): TaskNode | undefined {
  for (const node of byId.values()) if (node.taskId === taskId) return node
  return undefined
}

export function taskExists(byId: Map<string, TaskNode>, taskId: string): boolean {
  return reservations.get(scopeOf(byId))?.has(taskId) === true || findTask(byId, taskId) !== undefined
}

export function reserveTaskId(byId: Map<string, TaskNode>, taskId: string): { release(): void } | null {
  if (taskExists(byId, taskId)) return null
  const scope = scopeOf(byId)
  let pending = reservations.get(scope)
  if (!pending) { pending = new Set(); reservations.set(scope, pending) }
  pending.add(taskId)
  let released = false
  return { release: () => { if (released) return; released = true; pending.delete(taskId) } }
}

/** 待执行的重复节点不挡首个执行者;已经开始/终结的同 ID 节点才挡。 */
export function executedDuplicate(node: TaskNode, byId: Map<string, TaskNode>): TaskNode | undefined {
  for (const candidate of byId.values()) {
    if (candidate !== node && !candidate.taskDuplicateOf && candidate.taskId === node.taskId &&
      (candidate.taskPlanningStarted === true || candidate.taskExecutionStarted === true ||
        candidate.startedAt !== undefined || (candidate.status !== 'CREATED' && candidate.status !== 'READY'))) return candidate
  }
  return undefined
}

const active = new WeakMap<object, Map<string, TaskNode>>()

export function claimTaskStep(node: TaskNode, byId: Map<string, TaskNode>):
  { duplicate: TaskNode } | { release(): void } {
  const scope = scopeOf(byId)
  let running = active.get(scope)
  if (!running) { running = new Map(); active.set(scope, running) }
  const duplicate = running.get(node.taskId) ?? executedDuplicate(node, byId)
  if (duplicate) return { duplicate }
  running.set(node.taskId, node)
  const taskId = node.taskId
  let released = false
  return { release: () => { if (released) return; released = true; running.delete(taskId) } }
}
