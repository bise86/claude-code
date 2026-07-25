import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// WHY THIS EXISTS.
//
// This repo has no typecheck — no `typescript` dependency, no script — so `bun test` is the
// only gate. Nothing in the suite imports the command entry points (they render Ink and
// touch the real store), which means a *syntax* error in one of them is invisible: a commit
// shipped `await` inside a non-async `.then(cfg => {...})` in efftask.tsx and the whole suite
// stayed green while `/et` could not even parse. The failure was not in logic anyone tested;
// it was that the file was not valid TypeScript at all.
//
// Parsing is the weakest possible check, and that is the point: it is the one thing a test
// can assert about a module it must not execute.
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('every source file parses', () => {
  it('parses all of src/ — the only syntax gate in a repo with no typecheck', () => {
    const files = sourceFiles('src')
    // A fixture that finds nothing would pass forever. This repo has hundreds of files.
    expect(files.length).toBeGreaterThan(100)
    // Per-extension loaders: parsing a .ts file as tsx makes `<T>` ambiguous with JSX, so a
    // single tsx transpiler reports syntax errors in six files that import and run fine.
    const ts = new Bun.Transpiler({ loader: 'ts' })
    const tsx = new Bun.Transpiler({ loader: 'tsx' })
    const broken: string[] = []
    for (const f of files) {
      try {
        ;(f.endsWith('.tsx') ? tsx : ts).transformSync(readFileSync(f, 'utf8'))
      } catch (e) {
        broken.push(`${f}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      }
    }
    expect(broken).toEqual([])
  })
})
