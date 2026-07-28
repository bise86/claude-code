/**
 * 探针:这台机器上没有 ripgrep 时,**模型收到的那句话**长什么样。
 *
 * 用户报了两次「File does not exist. Note: your current working directory is …」,
 * 而根因是搜索整个不可用之后子 agent 列不出文件、只能猜文件名。那条链上唯一能打断它的
 * 地方是**工具结果的文案** —— 裸的 `spawn rg ENOENT` 模型看不懂。
 *
 * 这个探针把 PATH 清空(等价于「机器上没装 rg」)后真的调一次搜索,把错误原文打出来。
 */
import { ripGrep } from '../../src/utils/ripgrep.js'

async function main(): Promise<void> {
  const out: Record<string, unknown> = {}
  try {
    const hits = await ripGrep(['-l', 'export'], process.cwd(), new AbortController().signal)
    out.ok = true
    out.hits = hits.length
  } catch (e) {
    out.ok = false
    out.message = e instanceof Error ? e.message : String(e)
    out.code = (e as { code?: unknown }).code
  }
  // 一行 JSON,调用方好解析。
  process.stdout.write(JSON.stringify(out) + '\n')
}

void main()
