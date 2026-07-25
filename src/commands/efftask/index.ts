import type { Command } from '../../types/command.js'

// Metadata only — the implementation (Ink UI + orchestrator wiring) is lazy-loaded so
// `/et` costs nothing at startup for the sessions that never invoke it.
const efftask = {
  type: 'local-jsx',
  name: 'et',
  aliases: ['efftask'],
  description: '高效任务模式:把提示词拆成可并行、带依赖、多角色评审/验收的任务树',
  argumentHint: '<任务提示词> | --resume [运行ID] [--retry-blocked] [续跑指引]',
  userInvocable: true,
  disableModelInvocation: true,
  // The execute phase hands the session's real `canUseTool` to write-capable sub-agents
  // (efftask.tsx passes context.canUseTool straight through). Without this the confirm queue
  // stays invisible for as long as the task panel is mounted, so the first Edit/Write/Bash
  // needing approval hangs the run: with a Feishu bridge it silently degrades to
  // approve-from-phone, with none it never returns. See LocalJSXCommand.spawnsSubagents.
  spawnsSubagents: true,
  load: () => import('./efftask.js'),
} satisfies Command

export default efftask
