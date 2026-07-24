import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
export type FeishuReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
export type FeishuConfig = {
  enabled: boolean; appId: string; appSecret: string
  receiveIdType: FeishuReceiveIdType; receiveId: string
}
export type FeishuPermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
  feedback?: string
}
