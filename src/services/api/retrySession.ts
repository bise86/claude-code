import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export const SESSION_ROTATION_RETRIES = 3
export const MAX_SESSION_ROTATIONS = 2

export type SessionRetryDecision = {
  /** 0 表示更换后的首次请求,1 起才是重试。 */
  retryAttempt: number
  rotation: number
  rotated: boolean
}

/** 一轮模型响应的预算;建流失败和流中途失败必须使用同一个实例。 */
export class RetrySession {
  attempt = 1
  rotations = 0

  constructor(public nonce?: string, private readonly onRotate?: (nonce: string) => void) {}

  next(maxRetries: number): SessionRetryDecision | undefined {
    if (!Number.isFinite(maxRetries) || maxRetries < 0) return undefined
    // 首次请求 + 3 次重试都失败后才更换;更小的用户预算仍优先。
    if (maxRetries >= SESSION_ROTATION_RETRIES
      && this.attempt > SESSION_ROTATION_RETRIES
      && this.rotations < MAX_SESSION_ROTATIONS) {
      this.nonce = randomUUID()
      this.onRotate?.(this.nonce)
      this.rotations++
      this.attempt = 1
      return { retryAttempt: 0, rotation: this.rotations, rotated: true }
    }
    if (this.attempt > maxRetries) return undefined
    return { retryAttempt: this.attempt++, rotation: this.rotations, rotated: false }
  }
}

const scope = new AsyncLocalStorage<RetrySession>()
const FACTORY = Symbol.for('claude-code.roleFetch.retrySessionFactory')

export function setRetrySessionFactory(fetch: Function, factory: () => RetrySession): void {
  Object.defineProperty(fetch, FACTORY, { value: factory })
}

export function createRetrySession(fetch: unknown): RetrySession | undefined {
  if (typeof fetch !== 'function') return undefined
  const factory = (fetch as unknown as Record<symbol, unknown>)[FACTORY]
  return typeof factory === 'function' ? factory() : undefined
}

/** 只包真正的请求调用;并发请求各自携带自己的会话标识。 */
export function withRetrySession<T>(session: RetrySession | undefined, fn: () => T): T {
  return session ? scope.run(session, fn) : fn()
}

export function currentRetrySession(): RetrySession | undefined {
  return scope.getStore()
}
