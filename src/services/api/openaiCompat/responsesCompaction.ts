/**
 * Responses checkpoints travel through Anthropic history as opaque thinking
 * signatures, like encrypted reasoning. Keep this module leaf-only: message
 * normalization also needs to recognize these persistent checkpoints.
 */
const COMPACTION_SIG_PREFIX = 'openai-responses-compaction:'

export interface CompactionItem {
  type: 'compaction'
  id?: string
  encrypted_content: string
}

export function encodeCompactionSignature(item: CompactionItem): string {
  return COMPACTION_SIG_PREFIX + JSON.stringify({ id: item.id, enc: item.encrypted_content })
}

export function decodeCompactionSignature(signature: unknown): CompactionItem | undefined {
  if (typeof signature !== 'string' || !signature.startsWith(COMPACTION_SIG_PREFIX)) return undefined
  try {
    const value = JSON.parse(signature.slice(COMPACTION_SIG_PREFIX.length))
    if (typeof value?.enc !== 'string' || value.enc.length === 0) return undefined
    return {
      type: 'compaction',
      ...(typeof value.id === 'string' && value.id.length > 0 ? { id: value.id } : {}),
      encrypted_content: value.enc,
    }
  } catch {
    return undefined
  }
}

/** Checkpoints must survive thinking-only/trailing-thinking cleanup. */
export function isResponsesCompactionBlock(block: { type: string; signature?: unknown }): boolean {
  return block.type === 'thinking' &&
    typeof block.signature === 'string' && block.signature.startsWith(COMPACTION_SIG_PREFIX)
}
