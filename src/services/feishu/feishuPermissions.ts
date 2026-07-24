import type { FeishuPermissionResponse } from './types.js'

export type FeishuPermissionCallbacks = {
  onResponse(requestId: string, handler: (r: FeishuPermissionResponse) => void): () => void
  resolve(requestId: string, r: FeishuPermissionResponse): boolean
}

export function createFeishuPermissionCallbacks(): FeishuPermissionCallbacks {
  const pending = new Map<string, (r: FeishuPermissionResponse) => void>()
  return {
    onResponse(requestId, handler) {
      pending.set(requestId, handler)
      return () => { pending.delete(requestId) }
    },
    resolve(requestId, r) {
      const h = pending.get(requestId)
      if (!h) return false
      pending.delete(requestId) // 删除在前，幂等
      h(r)
      return true
    },
  }
}
