import { useEffect } from 'react'
import { getFeishuConfig } from '../services/feishu/config.js'
import { FeishuClient, type CardActionEvent } from '../services/feishu/FeishuClient.js'
import {
  createFeishuPermissionCallbacks,
  type FeishuPermissionCallbacks,
} from '../services/feishu/feishuPermissions.js'
import { formValueToAnswers, type QuestionSpec } from '../services/feishu/cards.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import { logError } from '../utils/log.js'

/**
 * Pure translation from a Feishu card.action.trigger event to a
 * FeishuPermissionResponse, routed through callbacks.resolve(requestId, ...).
 * Kept side-effect-free (besides the resolve call) so it's unit-testable
 * without a live FeishuClient/websocket.
 */
export function wireCardAction(
  callbacks: FeishuPermissionCallbacks,
  questionsById: Map<string, QuestionSpec[]>,
): (e: CardActionEvent) => void {
  return e => {
    const v = e.action.value ?? {}
    const requestId = v.requestId as string
    if (!requestId) return
    if (v.behavior === 'deny') {
      callbacks.resolve(requestId, { behavior: 'deny' })
      return
    }
    if (v.form && e.action.form_value) {
      const qs = questionsById.get(requestId) ?? []
      callbacks.resolve(requestId, {
        behavior: 'allow',
        updatedInput: formValueToAnswers(qs, e.action.form_value),
      })
      return
    }
    callbacks.resolve(requestId, {
      behavior: 'allow',
      ...(v.always && v.suggestion ? { permissionUpdates: [v.suggestion as any] } : {}),
    })
  }
}

/**
 * Always-on Feishu bridge: builds a FeishuClient + permission callbacks when
 * Feishu is configured/enabled (settings.feishu), routes card.action.trigger
 * events into feishuPermissionCallbacks.resolve(...), and stores the client +
 * callbacks + pending-questions map in AppState so interactiveHandler.ts can
 * reach them (mirrors channelPermissionCallbacks in useManageMCPConnections).
 *
 * connect() is fire-and-forget — never awaited — so a slow/unreachable
 * Feishu API never blocks REPL startup. Mount-once (empty deps): there's no
 * live toggle for Feishu yet, so settings are read once at mount via
 * store.getState() rather than subscribing with useAppState.
 */
export function useFeishuBridge(): void {
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  useEffect(() => {
    const cfg = getFeishuConfig(store.getState().settings)
    if (!cfg) return

    const callbacks = createFeishuPermissionCallbacks()
    const questionsById = new Map<string, QuestionSpec[]>()
    const client = new FeishuClient(cfg)
    client.onCardAction(wireCardAction(callbacks, questionsById))

    setAppState(prev => ({
      ...prev,
      feishuPermissionCallbacks: callbacks,
      feishuClient: client,
      feishuQuestionsById: questionsById,
    }))

    // Fire-and-forget: don't block first paint on the Feishu websocket.
    void client.connect().catch(logError)

    return () => {
      void client.close().catch(logError)
      setAppState(prev => ({
        ...prev,
        feishuPermissionCallbacks: undefined,
        feishuClient: undefined,
        feishuQuestionsById: undefined,
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only effect; store/setAppState are stable refs
  }, [])
}
