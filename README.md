# Claude Code Haha

<p align="right"><strong>中文</strong> | <a href="./README.en.md">English</a></p>

基于 Claude Code 泄露源码修复的**本地可运行版本**，支持接入任意 Anthropic 兼容 API（如 MiniMax、OpenRouter 等）。

> 原始泄露源码无法直接运行。本仓库修复了启动链路中的多个阻塞问题，使完整的 Ink TUI 交互界面可以在本地工作。

<p align="center">
  <img src="docs/00runtime.png" alt="运行截图" width="800">
</p>

## 功能

- 完整的 Ink TUI 交互界面（与官方 Claude Code 一致）
- `--print` 无头模式（脚本/CI 场景）
- 支持 MCP 服务器、插件、Skills
- 支持自定义 API 端点和模型
- 降级 Recovery CLI 模式
- **高效任务模式 `/et`**：把需求拆成可并行、带依赖、多角色评审的任务树（[用法](#高效任务模式-et)）
- **飞书集成**：确认关口、权限请求、升级通知都可以在飞书卡片上处理

---

## 架构概览

<table>
  <tr>
    <td align="center" width="25%"><img src="docs/01-overall-architecture.png" alt="整体架构"><br><b>整体架构</b></td>
    <td align="center" width="25%"><img src="docs/02-request-lifecycle.png" alt="请求生命周期"><br><b>请求生命周期</b></td>
    <td align="center" width="25%"><img src="docs/03-tool-system.png" alt="工具系统"><br><b>工具系统</b></td>
    <td align="center" width="25%"><img src="docs/04-multi-agent.png" alt="多 Agent 架构"><br><b>多 Agent 架构</b></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="docs/05-terminal-ui.png" alt="终端 UI"><br><b>终端 UI</b></td>
    <td align="center" width="25%"><img src="docs/06-permission-security.png" alt="权限与安全"><br><b>权限与安全</b></td>
    <td align="center" width="25%"><img src="docs/07-services-layer.png" alt="服务层"><br><b>服务层</b></td>
    <td align="center" width="25%"><img src="docs/08-state-data-flow.png" alt="状态与数据流"><br><b>状态与数据流</b></td>
  </tr>
</table>

---

## 快速开始

### 方式 A：下载编译好的二进制（不需要装 Bun）

从 [Releases](https://github.com/bise86/claude-code/releases) 下载对应平台的单文件二进制：

| 平台 | 文件 |
|------|------|
| Linux x64 | `claude-haha-linux-x64` |
| macOS Apple Silicon | `claude-haha-darwin-arm64` |
| macOS Intel | `claude-haha-darwin-x64` |
| Windows x64 | `claude-haha-windows-x64.exe` |

```bash
chmod +x claude-haha-linux-x64
./claude-haha-linux-x64 --version
```

二进制里已经打包了运行时和全部依赖，机器上不需要 Bun 和 node_modules。但**仍然需要配置 API 凭据**——见下面第 3 步，把 `.env` 放在二进制同目录，或直接用环境变量。

---

### 方式 B：从源码运行

### 1. 安装 Bun

本项目运行依赖 [Bun](https://bun.sh)。如果你的电脑还没有安装 Bun，可以先执行下面任一方式：

```bash
# macOS / Linux（官方安装脚本）
curl -fsSL https://bun.sh/install | bash
```

如果在精简版 Linux 环境里提示 `unzip is required to install bun`，先安装 `unzip`：

```bash
# Ubuntu / Debian
apt update && apt install -y unzip
```

```bash
# macOS（Homebrew）
brew install bun
```

```powershell
# Windows（PowerShell）
powershell -c "irm bun.sh/install.ps1 | iex"
```

安装完成后，重新打开终端并确认：

```bash
bun --version
```

### 2. 安装项目依赖

```bash
bun install
```

### 3. 配置环境变量

复制示例文件并填入你的 API Key：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# API 认证（二选一）
ANTHROPIC_API_KEY=sk-xxx          # 标准 API Key（x-api-key 头）
ANTHROPIC_AUTH_TOKEN=sk-xxx       # Bearer Token（Authorization 头）

# API 端点（可选，默认 Anthropic 官方）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic

# 模型配置
ANTHROPIC_MODEL=MiniMax-M2.7-highspeed
ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M2.7-highspeed
ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7-highspeed
ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M2.7-highspeed

# 超时（毫秒）
API_TIMEOUT_MS=3000000

# 禁用遥测和非必要网络请求
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

### 4. 启动

#### macOS / Linux

```bash
# 交互 TUI 模式（完整界面）
./bin/claude-haha

# 无头模式（单次问答）
./bin/claude-haha -p "your prompt here"

# 管道输入
echo "explain this code" | ./bin/claude-haha -p

# 查看所有选项
./bin/claude-haha --help
```

#### Windows

> **前置要求**：必须安装 [Git for Windows](https://git-scm.com/download/win)（提供 Git Bash，项目内部 Shell 执行依赖它）。

Windows 下启动脚本 `bin/claude-haha` 是 bash 脚本，无法在 cmd / PowerShell 中直接运行。请使用以下方式：

**方式一：PowerShell / cmd 直接调用 Bun（推荐）**

```powershell
# 交互 TUI 模式
bun --env-file=.env ./src/entrypoints/cli.tsx

# 无头模式
bun --env-file=.env ./src/entrypoints/cli.tsx -p "your prompt here"

# 降级 Recovery CLI
bun --env-file=.env ./src/localRecoveryCli.ts
```

**方式二：Git Bash 中运行**

```bash
# 在 Git Bash 终端中，与 macOS/Linux 用法一致
./bin/claude-haha
```

> **注意**：部分功能（语音输入、Computer Use、Sandbox 隔离等）在 Windows 上不可用，不影响核心 TUI 交互。

---

## 高效任务模式 `/et`

把一句需求拆成一棵**可并行、带依赖、多角色评审**的任务树，自动跑完。

```bash
/et 把登录模块重构成 JWT，补上测试
```

它会先弹一个**启动关口**让你确认：目标、并行数、名册（谁在什么环节干活）、预估调用数上限。确认之后自主执行，只在需要工具权限、触发安全阀、或合并冲突时才打扰你。跑完再弹一个**收口关口**，让你选合并 / 推送 / 保留 / 丢弃。

### 两个核心概念：员工与角色

这两个词很容易混，先分清：

| 概念 | 是什么 | 配在哪 |
|------|--------|--------|
| **员工（staff）** | 一个**可派遣的身份**，自带模型、API 地址、工具集 | `settings.json` 的 `roles[]` |
| **角色（role）** | 任务里的一个**职能**，比如「架构师」「安全」 | `settings.json` 的 `efftaskRoles[]`，或直接写在提示词里 |

**多对多**：一个员工可以担任多个角色，一个角色也可以由多个员工担任。

一个角色配了多个员工时，他们**必须收敛成一个产出**——具体怎么收敛，取决于环节（见下）。

### 环节：任务的七个步骤

每个节点先被定为**拆分型**或**执行型**，再按形态走一串环节：

- **拆分型**：分析 → 质疑讨论 →（等全部子任务完成）→ **集成验收** → 观察
- **执行型**：分析 → 质疑讨论 → 执行 → 测试验证 → 验收 → 观察 →（自动合并进集成分支）

> **集成验收不做合并。** 合并早就发生了——每个执行型节点自己通过验收时，就把它的工作区合进了集成分支。集成验收判的是另一件事：**「这些子任务的结果合起来，达成父节点的目标了吗」**。所以它必须等全部子任务完成——少一块就问不了这个问题。它也是唯一能发现「当初拆漏了」的地方：裁决不通过时可以直接提出补救子任务，挂上去跑完再重新验收。
>
> 执行型节点的合并是**机械**的，没有角色关口。所以「集成验收」这个环节只对拆分型节点生效。

**自由的是角色，固定的是环节。** 你可以定义任意多个角色、任意取名、指定任意员工担当、写任意的产出与作用。不自由的只有一件事：这个角色挂在**哪个环节**上。环节是流水线状态机的骨架，它决定这一席什么时候被调用、能不能拿到写工具、`--resume` 之后还在不在。

> 环节列表**会随版本增长**——这一版就从 5 个长到了 7 个。写一个不存在的环节名会被明确拒绝并告诉你合法值，而不是静默丢弃。

### 完整配置示例

`~/.claude/settings.json`（或项目下的 `.claude/settings.json`）：

```jsonc
{
  "roles": [
    // ── 员工：可派遣的身份 ──
    {
      "name": "opus-架构",
      "whenToUse": "架构与拆分合理性评审",
      "execMode": "api",
      "apiProtocol": "anthropic",
      "apiUrl": "https://api.anthropic.com",
      "apiToken": "sk-ant-xxx",
      "model": "claude-opus-4-8"
    },
    {
      "name": "ds-测试",
      "whenToUse": "跑测试、做变异验证",
      "execMode": "api",
      "apiProtocol": "openai",
      "apiUrl": "https://api.deepseek.com/v1",
      "apiToken": "sk-xxx",
      "model": "deepseek-chat",
      // 员工侧也能声明「我能当哪些角色」（双向配置）
      "efftaskRoles": ["测试官"]
    }
  ],

  "efftaskRoles": [
    // ── 角色：任务里的职能 ──
    {
      "name": "架构师",
      "step": "质疑讨论",
      "output": "通过/阻断裁决 + 每条阻断指向具体的边界问题",
      "purpose": "质疑这份拆分：有没有漏项、子任务间有没有隐藏依赖",
      "staff": ["opus-架构"]
    },
    {
      "name": "测试官",
      "step": "测试验证",
      "output": "实际执行的命令、原始输出、通过/阻断裁决",
      "purpose": "真的把测试跑起来，不读执行者的自述",
      "staff": ["ds-测试"]
    },
    {
      "name": "验收官",
      "step": "验收",
      "output": "验收裁决",
      "purpose": "逐条核对验收点"
      // 不写 staff = 由当前主模型兼任
    }
  ]
}
```

### 角色字段

四个必填字段缺任何一个，该角色**不生效**，并在启动关口上说明原因（不静默丢弃）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 角色名，任意取 |
| `step` | 是 | 在哪个环节用。见下表。旧键名 `stage` 仍然读得进来 |
| `output` | 是 | 产出什么 |
| `purpose` | 是 | 起什么作用 |
| `staff` | 否 | 由哪些员工担当。**省略 = 主模型兼任** |

`step` 的合法值（中文英文都收，落盘统一成英文）：

| 中文 | 英文 | 多员工时怎么收敛成一个产出 |
|------|------|--------------------------|
| 分析 | `plan` | **顺序精化**：第一位起草，后面每一位在前一稿上修订。全程一份稿子 |
| 质疑讨论 | `review` | **圆桌**：各自独立裁决，按通过门槛合成一个结论 |
| 执行 | `execute` | **只能一个员工**（物理约束：工作区路径不含员工维度） |
| 测试验证 | `verify` | 圆桌 |
| 验收 | `accept` | 圆桌 |
| 集成验收 | `integrate` | 圆桌。**只对拆分型节点生效**；没配时回落到验收席位。旧名「集成提交」仍可写 |
| 观察 | `observer` | **各自打分，取最低分**；其余人的理由一条不丢地记在旁边 |

### 用提示词临时改配置

不想改文件时，直接在指令里说：

```bash
/et 重构登录模块。评审用 opus-架构 和 ds-安全，测试验证交给 ds-测试，过半通过就行
```

提示词里**指名了员工**就按提示词换人（是真的换掉，不是再加一个）；没指名就沿用配置文件里的人。产出/作用以提示词为准。

### 三条护栏

多员工会把调用数**乘**起来，所以有三条护栏。它们不在 `settings.json` 里，用自然语言在指令里说即可，关口会把最终取值显示给你确认：

| 护栏 | 默认 | 怎么说 |
|------|------|--------|
| 每环节席位上限 | 5 | 「每阶段最多 3 席」 |
| 通过门槛（比例） | 100%（全票） | 「过半通过就行」「三分之二通过」 |
| 通过门槛（人数） | 无 | 「至少 2 个人通过」 |

> **为什么需要放宽门槛**：默认是全票——任一席位提出阻断，整体就不通过。席位越多越难通过：每席独立 80% 通过率的话，3 席是 51%，9 席只有 13%。所以配了多个员工之后通常要同时放宽门槛，否则「人多」反而让任务跑不完。

启动关口会显示预估调用数上限，例如 `预估上限 2400 次模型调用(每节点最多 24 次 × 节点上限 100;实际通常远低于此)`。这是**上限口径**——按节点数上限算，实际任务通常只有几个节点，真实用量往往低两个数量级。它不是并发数。

### 常见坑

- **`roles[]` 是严格校验的**：写入未声明的字段会让**整条员工被跳过**（表现为「这个员工不存在」），而不只是该字段失效。终端会输出一行 `[roles] "<名字>" skipped: <原因>`。
- **`step` 写错**会被拒绝并列出合法值，还会猜一个最接近的（写「测试」会提示「是不是想写『测试验证』」）。
- **`staff` 里的员工名找不到** → 该角色改由主模型兼任，关口会说明。这和「没写 staff」是两回事。
- **`execMode: 'cli'` 的员工** `/et` 目前派发不了，会被剔除并说明。

### 断点续跑

```bash
/et --resume            # 列出可恢复的 run
/et --resume 003        # 继续指定的 run
/et --resume 003 --retry-blocked   # 顺便重开被安全阀停下的节点
```

任务树持久化在 `.claude/efftask/<run-id>/`，是一棵和任务树同构的 md 目录。跑完但还没处置集成分支时，`--resume` 会重新弹出收口关口。

---

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `ANTHROPIC_API_KEY` | 二选一 | API Key，通过 `x-api-key` 头发送 |
| `ANTHROPIC_AUTH_TOKEN` | 二选一 | Auth Token，通过 `Authorization: Bearer` 头发送 |
| `ANTHROPIC_BASE_URL` | 否 | 自定义 API 端点，默认 Anthropic 官方 |
| `ANTHROPIC_MODEL` | 否 | 默认模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 否 | Sonnet 级别模型映射 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 否 | Haiku 级别模型映射 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 否 | Opus 级别模型映射 |
| `API_TIMEOUT_MS` | 否 | API 请求超时，默认 600000 (10min) |
| `DISABLE_TELEMETRY` | 否 | 设为 `1` 禁用遥测 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 否 | 设为 `1` 禁用非必要网络请求 |

---

## 降级模式

如果完整 TUI 出现问题，可以使用简化版 readline 交互模式：

```bash
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha
```

---

## 相对于原始泄露源码的修复

泄露的源码无法直接运行，主要修复了以下问题：

| 问题 | 根因 | 修复 |
|------|------|------|
| TUI 不启动 | 入口脚本把无参数启动路由到了 recovery CLI | 恢复走 `cli.tsx` 完整入口 |
| 启动卡死 | `verify` skill 导入缺失的 `.md` 文件，Bun text loader 无限挂起 | 创建 stub `.md` 文件 |
| `--print` 卡死 | `filePersistence/types.ts` 缺失 | 创建类型桩文件 |
| `--print` 卡死 | `ultraplan/prompt.txt` 缺失 | 创建资源桩文件 |
| **Enter 键无响应** | `modifiers-napi` native 包缺失，`isModifierPressed()` 抛异常导致 `handleEnter` 中断，`onSubmit` 永远不执行 | 加 try-catch 容错 |
| setup 被跳过 | `preload.ts` 自动设置 `LOCAL_RECOVERY=1` 跳过全部初始化 | 移除默认设置 |

---

## 自行编译

```bash
bun install

# 打包成单个 JS（需要目标机器有 bun）
bun run build            # → dist/cli.js

# 编译成单文件二进制（目标机器什么都不需要）
bun run build:compile    # → dist/claude-haha

# 交叉编译
bun run scripts/build.ts --compile --target bun-windows-x64 --outfile claude.exe
```

版本号来自构建时的环境变量，不注入则是 `999.0.0-local`：

```bash
CLAUDE_CODE_LOCAL_VERSION=v0.1.0 bun run build:compile
```

### 关于 `vendor/zod-v4.js`

仓库里提交了一份**压平后的 zod**。原因：bun 1.3.14 给 zod 的 `export *` 链生成的懒导出表会引用不存在的符号，主构建产物一跑就 `ReferenceError: _uppercase2 is not defined`（不是重复打包——产物里只有一份，而且单独打包 zod 完全正常）。先把它压平成一个文件、主构建再指向那一份，就绕开了出问题的那条 codegen 路径。

升级 zod 之后重新生成：

```bash
bun run vendor:zod
```

### 发布

打 tag 即触发 GitHub Actions，四个平台各自编译 + 冒烟测试（`--version` 和 `--help` 真的跑一遍）之后才进 Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

---

## 项目结构

```
bin/claude-haha          # 入口脚本
preload.ts               # Bun preload（设置 MACRO 全局变量）
.env.example             # 环境变量模板
src/
├── entrypoints/cli.tsx  # CLI 主入口
├── main.tsx             # TUI 主逻辑（Commander.js + React/Ink）
├── localRecoveryCli.ts  # 降级 Recovery CLI
├── setup.ts             # 启动初始化
├── screens/REPL.tsx     # 交互 REPL 界面
├── ink/                 # Ink 终端渲染引擎
├── components/          # UI 组件
├── tools/               # Agent 工具（Bash, Edit, Grep 等）
├── commands/            # 斜杠命令（/commit, /review 等）
├── skills/              # Skill 系统
├── services/            # 服务层（API, MCP, OAuth 等）
├── hooks/               # React hooks
└── utils/               # 工具函数
```

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh) |
| 语言 | TypeScript |
| 终端 UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | Commander.js |
| API | Anthropic SDK |
| 协议 | MCP, LSP |

---

## Disclaimer

本仓库基于 2026-03-31 从 Anthropic npm registry 泄露的 Claude Code 源码。所有原始源码版权归 [Anthropic](https://www.anthropic.com) 所有。仅供学习和研究用途。
