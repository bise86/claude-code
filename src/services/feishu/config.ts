import { z } from 'zod'
import type { FeishuConfig } from './types.js'

export const FeishuConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  receiveIdType: z.enum(['open_id','chat_id','user_id','union_id','email']).default('open_id'),
  receiveId: z.string().min(1),
  cardLanguage: z.string().default('zh'),
})

export function getFeishuConfig(settings: { feishu?: unknown }): FeishuConfig | null {
  const raw = settings?.feishu
  if (!raw || typeof raw !== 'object') return null
  const parsed = FeishuConfigSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.enabled) return null
  return parsed.data
}
