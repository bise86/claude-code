#!/usr/bin/env bash
# Mutation table from the P2a plan, Task 17 Step 12.
# Each row breaks the implementation one way; the named assertion MUST go red.
# An assertion that stays green does not test what it claims to.
export PATH="$HOME/.bun/bin:$PATH"
cd /home/hezx/tb/claude-code
O=src/tools/efftask/orchestrator.ts
P=src/tools/efftask/pipeline.ts
cp $O /tmp/mut_o.bak; cp $P /tmp/mut_p.bak
restore() { cp /tmp/mut_o.bak $O; cp /tmp/mut_p.bak $P; }

run_case () {
  local label="$1"; local expect="$2"
  local out
  out=$(timeout 120 bun test src/tools/efftask/concurrency.test.ts src/tools/efftask/pipeline.test.ts 2>&1 | grep -E '^\(fail\)' | sed 's/ \[.*//')
  if [ -z "$out" ]; then
    printf '  ✘ %-42s 无断言变红 —— 该断言测不到它声称测的东西\n' "$label"
  else
    printf '  ✔ %-42s 变红:\n' "$label"
    echo "$out" | sed 's/^(fail) /      /' | head -3
  fi
  restore
}

echo "=== 变异验证表 ==="

# 1. mutex chains an ALREADY-STARTED promise (the v1 form)
bun -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8")
s=s.replace("const task = kind === \x27execute\x27 ? (executeChain = executeChain.then(step, step)) : step()",
            "const started = step(); const task = kind === \x27execute\x27 ? (executeChain = executeChain.then(() => started, () => started)) : started")
fs.writeFileSync(p,s)' $O
run_case "互斥链一个已启动的 promise" ""


# 2. budget charged against inFlight instead of running (queued executes eat the pool)
bun -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8")
s=s.replace("const budget = Math.max(1, this.cfg.parallelism) - running","const budget = Math.max(1, this.cfg.parallelism) - inFlight.size")
fs.writeFileSync(p,s)' $O
run_case "预算按 inFlight 计(排队占名额)" ""

# 3. runStep no longer absorbs its own errors
bun -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8")
s=s.replace(/    \} catch \(e\) \{\n      \/\/ A step should not normally throw[\s\S]*?this\.safeUpdate\(\)\n    \}\n  \}/,
            "    } catch (e) { throw e }\n  }")
fs.writeFileSync(p,s)' $O
run_case "runStep 不自捕(直接抛出)" ""


# 5. reservation released per-return-path instead of finally
bun -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8")
s=s.replace(/  \} finally \{\n    \/\/ UNCONDITIONAL[\s\S]*?slots\.release\(\)\n  \}\n\}/,
            "  } catch (e) { throw e } finally { /* MUTATION: no release on throw */ }\n}")
fs.writeFileSync(p,s)' $P
run_case "额度不在 finally 释放" ""

# 6. interrupt sweeps without settling in-flight work
bun -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8")
s=s.replace("        await this.settleAll(inFlight)\n        if (this.byId.get(\x27root\x27)!.status === \x27ACCEPTED\x27) return { status: \x27completed\x27 }",
            "        if (this.byId.get(\x27root\x27)!.status === \x27ACCEPTED\x27) return { status: \x27completed\x27 }")
fs.writeFileSync(p,s)' $O
run_case "中断不等在飞步骤直接扫描" ""

restore
echo "=== 已恢复 ==="
timeout 180 bun test 2>&1 | tail -3
