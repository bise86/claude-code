import type { Command } from '../../types/command.js'

// Metadata only — the implementation (Ink UI + orchestrator wiring) is lazy-loaded so
// `/et` costs nothing at startup for the sessions that never invoke it.
const efftask = {
  type: 'local-jsx',
  name: 'et',
  aliases: ['efftask'],
  description: '高效任务模式:把提示词拆成可并行、带依赖、多角色评审/验收的任务树',
  argumentHint: '<任务提示词>',
  userInvocable: true,
  disableModelInvocation: true,
  load: () => import('./efftask.js'),
} satisfies Command

export default efftask
