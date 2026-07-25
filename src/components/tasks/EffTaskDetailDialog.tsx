import React from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { EffTaskTaskState } from '../../tasks/EffTaskTask/EffTaskTask.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<EffTaskTaskState>
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
}

/**
 * `/tasks` detail for a `/et` run (spec §10).
 *
 * Deliberately NOT a second task tree. The interactive tree already exists in the `/et` view
 * itself and it owns the keyboard there; duplicating it here would be a second renderer of
 * the same state that can disagree with the first. What this view owes the user is the two
 * things the panel cannot show inline: how the run ENDED, and where its durable record is —
 * run.md is what survives after the view is gone, and a path nobody is told is indis-
 * tinguishable from no record at all.
 */
export function EffTaskDetailDialog({ task, onDone, onBack, onKill }: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0)
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      onDone()
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`高效任务 ${task.runId}`}
        subtitle={
          <Text dimColor>
            {elapsedTime} · 已完成 {task.counts.accepted}/{task.counts.total} · 阻断{' '}
            {task.counts.blocked} · 待处理 {task.counts.pending}
          </Text>
        }
        onCancel={onDone}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {task.status === 'running' && onKill && (
                <KeyboardShortcutHint shortcut="x" action="stop" />
              )}
            </Byline>
          )
        }
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>状态:</Text>{' '}
            {task.status === 'running' ? (
              <Text color="background">运行中</Text>
            ) : task.status === 'completed' ? (
              <Text color="success">已完成</Text>
            ) : (
              <Text color="error">{task.status === 'killed' ? '已中断' : '被阻断'}</Text>
            )}
            {/* The REASON, not just the label. A run that stopped without finishing has one,
                and it is the only thing that tells the user whether to resume or to fix. */}
            {task.reason ? <Text dimColor> — {task.reason}</Text> : null}
          </Text>
          <Box flexDirection="column">
            <Text dimColor>任务树与全部记录: {task.runDir}/run.md</Text>
            {/* ONLY for a run that stopped without finishing, and it names BOTH commands.
                A bare `继续: /et --resume <id>` was untrue twice over: for a COMPLETED run
                there is nothing to continue (root is ACCEPTED, `run()` returns immediately),
                and for a run stopped by a safety valve a plain `--resume` reopens nothing —
                reseatTransientNodes only reseats interrupted / merge-conflict nodes, so it
                reproduces the identical block having made zero model calls. */}
            {task.status === 'failed' || task.status === 'killed' ? (
              <>
                <Text dimColor>继续未完成的部分: /et --resume {task.runId}</Text>
                <Text dimColor>
                  若有节点被安全阀停下(迭代/返工/超时上限): /et --resume {task.runId} --retry-blocked
                </Text>
              </>
            ) : null}
          </Box>
        </Box>
      </Dialog>
    </Box>
  )
}
