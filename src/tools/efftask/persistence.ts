import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import type { EffTaskConfig, TaskNode } from './types.js'
import { uiStatus } from './stateMachine.js'

export interface FsLike {
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  mkdir(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
  exists(p: string): Promise<boolean>
}

export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '')
  // Array.from + slice on CODE POINTS: a plain .slice(0,40) can cut a surrogate pair in
  // half and produce a lone surrogate in a filesystem path.
  return Array.from(s || 'node').slice(0, 40).join('')
}

export function childId(parentId: string, index: number, title: string): string {
  const nn = String(index).padStart(2, '0')
  return `${parentId}/${nn}-${slugify(title)}`
}

export async function allocateRunId(fs: FsLike, effRoot: string): Promise<string> {
  let max = 0
  // Read directly rather than gating on fs.exists(effRoot): mkdir() implementations
  // (real recursive mkdir, and the in-memory test fake) don't necessarily register an
  // entry for every ancestor path, so an exists() pre-check can false-negative even
  // when effRoot has numbered children. readdir on an empty/missing dir yields no
  // matches either way, which is exactly the documented "空/不存在→'001'" fallback.
  let names: string[] = []
  try { names = await fs.readdir(effRoot) } catch { names = [] }
  for (const name of names) {
    const m = name.match(/^(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return String(max + 1).padStart(3, '0')
}

// machine-state frontmatter fields (everything except derived human body)
export function serializeNode(node: TaskNode): string {
  const fm = { ...node }
  const body =
    `# ${node.title}\n\n` +
    `## 完整方案\n${node.plan.solution}\n\n` +
    `## 重点\n${node.plan.keyPoints}\n\n` +
    `## 风险点\n${node.plan.risks}\n\n` +
    `## 验收点\n${node.plan.acceptance}\n\n` +
    `## 执行状态\n${node.execStatus}\n\n` +
    (node.blockedReason ? `## 阻断原因\n${node.blockedReason}\n\n` : '') +
    `## 评审记录\n${node.reviewLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 验收记录\n${node.acceptLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 评分\nplan: ${node.score.plan?.score ?? '-'} / exec: ${node.score.exec?.score ?? '-'}\n`
  return `---\n${yamlStringify(fm)}---\n\n${body}`
}

export function parseNodeFile(text: string): TaskNode {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error('efftask: node.md missing frontmatter')
  // UNVALIDATED CAST: yamlParse returns `any`-shaped data straight off disk. P1 only
  // round-trips files it wrote itself, so this is safe here. P2's resume path reads
  // user-editable / possibly-stale files and MUST validate (status is a legal NodeStatus,
  // deps/childIds are string[], iteration counters are numbers) BEFORE feeding the state
  // machine — a malformed status would silently deadlock or skip the dependency gate.
  return yamlParse(m[1]) as TaskNode
}

function nodeMdPath(runDir: string, nodeId: string): string {
  return `${runDir}/${nodeId}/node.md`
}

export async function writeNode(fs: FsLike, runDir: string, node: TaskNode): Promise<void> {
  await fs.mkdir(`${runDir}/${node.id}`)
  await fs.writeFile(nodeMdPath(runDir, node.id), serializeNode(node))
}

export async function readNode(fs: FsLike, runDir: string, nodeId: string): Promise<TaskNode> {
  return parseNodeFile(await fs.readFile(nodeMdPath(runDir, nodeId)))
}

// Recursively walk the run dir; every `node.md` is parsed into a TaskNode. The physical
// layout mirrors node.id (runDir/<id>/node.md), so a DFS over subdirs recovers all nodes.
export async function loadRun(fs: FsLike, runDir: string): Promise<{ nodes: TaskNode[] }> {
  const nodes: TaskNode[] = []
  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { return } // not a dir (e.g. a file) → skip
    for (const name of entries) {
      const path = `${dir}/${name}`
      if (name === 'node.md') nodes.push(parseNodeFile(await fs.readFile(path)))
      else await walk(path) // recurse into child node dirs; non-dirs (run.md) readdir-throw and skip
    }
  }
  await walk(runDir)
  return { nodes }
}

export function renderTreeSnapshot(nodes: TaskNode[]): string {
  const lines = nodes.map(n => `${'  '.repeat(n.depth)}- [${uiStatus(n.status)}] ${n.title} (${n.status})`)
  return `# Efficient Task Run\n\n${lines.join('\n')}\n`
}

export async function writeRunManifest(
  fs: FsLike,
  runDir: string,
  cfg: EffTaskConfig,
  nodes: TaskNode[],
  // Final run outcome, written only on the last call so run.md records how the run ended.
  result?: { status: 'completed' | 'blocked'; reason?: string },
): Promise<void> {
  // run-level createdAt from the root node (fallback: first node) for a stable manifest timestamp.
  const createdAt = nodes.find(n => n.parentId === null)?.createdAt ?? nodes[0]?.createdAt ?? ''
  const header = `---\n${yamlStringify({
    createdAt,
    parallelism: cfg.parallelism,
    phaseRoles: cfg.phaseRoles,
    caps: cfg.caps,
    goalPrompt: cfg.goalPrompt,
    ...(result ? { status: result.status, reason: result.reason ?? '' } : {}),
  })}---\n\n`
  await fs.mkdir(runDir)
  await fs.writeFile(`${runDir}/run.md`, header + renderTreeSnapshot(nodes))
}
