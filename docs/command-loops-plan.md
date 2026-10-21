# 斜杠命令与约定 Loop：实施方案

> 状态：设计定稿（2026-10-21 评审通过）。目标版本 0.3.0（原定 0.4.0，总纲并入 0.3.0）。
> 核心思想：**两端契约化，中段自由化**；强制只在命令激活期生效。

## 0. 一句话

7 个斜杠命令 = 7 个"约定 loop"。命令用代码把**入口契约**和**出口契约**钉死，
中段交给 AI；loop 激活期间一个惰性插件接管强制执行（拦停 / 提醒 / 防作弊），
没有激活 loop 时它**完全不起作用**。

## 1. 三层架构

```
┌─ 命令层（代码）────────────────────────────────────────┐
│ /survey /paper /derive /write /review /status /study-init │
│ · 校验入口契约（不满足 → 直接报错，不启动）                  │
│ · 自动建项目（缺 study.json 时，可 --no-init 关闭）          │
│ · 创建 research/loops/<id>.json                           │
│ · 注入固定 prompt（契约 + 步骤骨架 + 技能引用）              │
└───────────────────────────────────────────────────────────┘
                          │ agent.followup(...)
                          ▼
┌─ 执行层（模型，自由）──────────────────────────────────┐
│ 怎么做、先做什么、用什么方法 —— 全由 AI 决定                │
│ 每完成一步：vault loop note <id> "…"                       │
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 强制层（插件，仅 loop 激活时）─────────────────────────┐
│ agent/pre-step       注入"还差什么"                        │
│ agent/turn-stopping  未完成不许收尾（最多 N 次）            │
│ tools/guard          禁止直接改 loop 文件（防作弊）          │
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 校验层（CLI）─────────────────────────────────────────┐
│ vault loop close <id>  跑出口检查，不合格拒绝关闭           │
└───────────────────────────────────────────────────────────┘
```

## 2. 命令契约总表

| 命令 | 参数 | 入口契约 | 出口契约（校验） | 技能 |
|---|---|---|---|---|
| `/study-init` | `[标题]` `--question` | 无（幂等；已存在则更新 title/question） | `research/study.json` 存在且含 title | — |
| `/survey` | `<方向>` | 可无项目（自动建） | `knowledge/surveys/<slug>/report.md` 本次新建或更新<br>≥5 条 key 式引用（`[@key]` / `\cite{key}`）<br>含 Markdown 方法对比表 + gap 清单<br>报告里的 citekey 都在 bib<br>work ≥3 条 | domain-survey |
| `/paper` | `<DOI\|arXiv id\|标题>` | 可无项目（自动建） | `knowledge/literature/notes/<citekey>.md` 本次新建或更新<br>「核心主张/方法要点/局限」三节有实质内容<br>该 citekey 在 bib 有条目<br>work ≥2 条 | literature-retrieval + pdf-reading |
| `/derive` | `<命题\|流程\|逻辑>` | 要求项目（缺则自动建） | `experiments/derivations/<id>/derive.py` 本次新建或更新且可执行<br>`validation.md` 本次新建或更新且含至少一条验证路线（数值/量纲/极限/反例/文献/小参数/不确定度）<br>work ≥3 条 | derivation-lab |
| `/write` | `[目标]`（默认进度日志）或 `§N` / `--section N` | 要求项目 | 目标文件本次新建或更新<br>`cite-check --deep` 通过 | — |
| `/review` | `[对象]`（默认全部未验证项） | 要求项目 | `study.json` 新增 review 记录 | scientific-reviewer |
| `/status` | `[loop-id]` `--abort` `--brief` `--json` | 无 | 无（只读，不创建 loop、不拦停） | — |

通用参数：`--no-init`（禁止自动建项目）、`--dry-run`（只打印将注入的 prompt，不启动）。

## 3. Loop 状态文件

`research/loops/<kind>-<slug>-<YYYYMMDDTHHMM>.json`：

```jsonc
{
  "id": "survey-pinn-20261021T2016",
  "kind": "survey",
  "arg": "PINN 求解器",
  "title": "PINN 求解器",           // 自动建项目时用
  "autoCreated": true,              // 项目是否由本命令自动创建
  "openedAt": "2026-10-21T20:16:00+08:00",
  "lastActivity": "2026-10-21T20:31:00+08:00",
  "baseline": { "notes": { "raissi2019pinn.md": 1761... } }, // 创建时笔记快照（paper-note 用）
  "status": "running",              // running | closed | failed | stalled | aborted

  "entry": { "requires": ["reports/"], "done": true },

  "work": [                          // AI 自由记账（可选，但部分命令要求非空）
    { "at": "20:03", "note": "检索 14 篇，锁定 3 个流派" }
  ],

  "exit": {
    "requires": ["knowledge/surveys/pinn/report.md"],
    "checks": ["cite-check"],        // 由 vault loop close 执行
    "workMin": 3,
    "done": false,
    "lastFailure": null              // 上次 close 失败的缺项清单
  },

  "nudges": 0,                       // 已拦停次数
  "maxNudges": 3,                    // derive=5，status=0（不拦）
  "closedAt": null,
  "failReason": null
}
```

**惰性超时**：读取时若 `status=running` 且 `lastActivity` 超过 24h → 自动置 `stalled`（不引入定时器）。

## 4. `vault loop` CLI

```
vault loop new <kind> <arg> [--max-nudges N]    创建并返回 id
vault loop list [--status running]               列出
vault loop show <id>                             详情
vault loop note <id> "…"                         追加 work 记录（刷新 lastActivity）
vault loop close <id> [--failed --reason "…"]    跑出口检查；通过则 closed，失败则拒绝
vault loop abort <id>                            手动中止
```

`close` 的输出（成功）：

```
✓ loop survey-pinn-… 已关闭
  产物 1 个 · 引用 7 条 · cite-check 无错误 · work 4 条
```

`close` 的输出（失败，退出码 1）：

```
✗ 出口契约未满足（loop 保持 running）
  · 缺产物：knowledge/surveys/pinn/report.md
  · 引用不足：需要 ≥5 条，实际 2 条
  · work 记录不足：需要 ≥3 条，实际 1 条
  补完后重试，或声明失败：vault loop close <id> --failed --reason "…"
```

## 5. 命令实现

```js
// vault-commands.mjs
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['commands', 'tools']

export function apply(ctx) {
  for (const spec of COMMANDS) {
    ctx.effect(function* () {
      yield ctx.commands.register({
        definitionId: CommandDefinitionId(`dsh-scientist/${spec.name}`),
        name: spec.name,              // 'survey'（不带斜杠）
        description: spec.description,
        input: spec.input,            // 客户端提示
        handler: makeHandler(ctx, spec),
      })
    }, `command-${spec.name}`)
  }
}

function makeHandler(ctx, spec) {
  return async (invocation) => {
    const arg = invocation.rawInput.trim()
    if (spec.requiresArg && !arg) return { kind: 'error', text: `用法：/${spec.name} ${spec.usage}` }

    // ① 入口契约
    const root = await resolveRoot()
    let study = await readJson(join(root, 'research/study.json'), null)
    if (!study && !flags.noInit) {
      study = await createStudy(root, { title: arg, question: arg, autoCreated: true })
    }
    if (!study && spec.requiresProject) return { kind: 'error', text: '没有研究项目；先 /study-init 或去掉 --no-init' }

    // ② 同类 loop 互斥（guard ② 在命令层实现，因为 guard 只看工具）
    const running = await findRunningLoop(root, spec.kind)
    if (running) return { kind: 'error', text: `已有 ${spec.kind} loop 在跑（${running.id}）；先 close 或 --abort` }

    // ③ 创建 loop
    const loop = await createLoop(root, { kind: spec.kind, arg, ...spec.exit, maxNudges: spec.maxNudges })

    // ④ 注入 prompt（--dry-run 只打印）
    const prompt = buildPrompt(spec, loop, study)
    if (flags.dryRun) return { kind: 'success', text: prompt }
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    return { kind: 'success', text: `已启动 /${spec.name}（loop ${loop.id}）\n出口契约：${spec.exitSummary}` }
  }
}
```

## 6. 注入 prompt 的结构（C 方案）

```markdown
/survey 已启动 · loop survey-pinn-20261021T2016

## 出口契约（不满足不能关闭）
- 产物：knowledge/surveys/pinn/report.md
- 必须含：≥5 条编号引用、方法对比表、gap 清单
- 校验：cite-check（由 vault loop close 执行）
- 过程留痕：work ≥3 条

## 步骤骨架（怎么做由你决定）
1. 界定边界与子问题
2. 流派与代表工作（每条带引用）
3. 时间线与方法对比
4. 开放问题与 gap
5. 最小切入点建议

方法细节：先加载 `domain-survey` 技能。

## 记账
- 每完成一步：`vault loop note <id> "…"`
- 全部完成：`vault loop close <id>`（会自动校验；不合格会被拒绝并列出缺项）
- 判断做不成：`vault loop close <id> --failed --reason "…"`（诚实失败优于凑数）
```

## 7. 强制插件（`vault-enforce.mjs`）

```js
export const inject = ['tools']

export function apply(ctx) {
  let agent = null            // preset 行按 agent 挂载，模块实例即 per-agent

  // ① 每步提醒：还差什么
  ctx.on('agent/pre-step', ({ agent: a, messages }, next) => {
    agent = a
    const loop = activeLoopSync()        // 读 research/loops/*.json（同步缓存 + 异步刷新）
    if (!loop) return next()             // ← 无 loop：完全惰性
    return { kind: 'enter', messages: [...messages, reminder(loop)] }
  })

  // ② 未完成不许收尾（最多 N 次）
  ctx.on('agent/turn-stopping', ({ turn }) => {
    const loop = activeLoopSync()
    if (!loop || loop.status !== 'running') return
    if (loop.nudges >= loop.maxNudges) { markStalled(loop); return }
    bumpNudges(loop)
    agent?.send(nudgeMessage(loop), 'next-step', false)   // ← 阻止 break
  })

  // ③ 防作弊：禁止直接改 loop 文件
  ctx.tools.guard((exec) => {
    const targets = ['write', 'edit', 'bash']
    if (!targets.includes(exec.name)) return
    if (touchesLoopDir(exec.arguments)) return 'research/loops/** 只能通过 `vault loop` 命令修改'
  })
}
```

**关键点**：
- 无 loop 时 `pre-step` 直接 `next()`、`turn-stopping` 直接 return、guard 只在碰 loop 目录时命中 → **零影响**
- `nudges` 落盘（不是内存计数），重启后仍有效
- 拦停超限后置 `stalled` 并**放行**，`/status` 标红

## 8. `/status` 的实现

1. **代码渲染**（确定性）：study.json + loops + records index + INDEX.md 新鲜度
2. **LLM 轻量复看**（默认开启）：注入 ≤5 行 / ≤120 字的复看 prompt
3. `--brief` 跳过第 2 步；`--json` 只输出第 1 步的结构化数据

## 9. 文件布局

```
vault-loop-core.mjs      loop 读写 / 校验执行 / 终态机（~300 行）
vault-commands.mjs       7 个命令 handler + prompt 构造（~450 行）
vault-enforce.mjs        强制插件（pre-step / turn-stopping / guard）（~180 行）
scripts/vault.mjs        扩展 `loop` 子命令组（~150 行）
scripts/test-vault-loop.mjs       loop 状态机与校验（~180 行）
scripts/test-vault-commands.mjs   命令 handler（~200 行）
scripts/test-vault-enforce.mjs    强制插件（~150 行）
```

新增 preset 两行：`vault-commands`、`vault-enforce`（`vault-loop-core` 是共享模块，不挂行）。

## 10. 上下文成本

- **工具面不变**：仍是 18 个（loop 走 CLI，不加工具）
- **命令面**：7 个命令的 name + description，客户端发现用，约 300 tokens
- **pre-step 注入**：仅在 loop 激活时，每次约 60–100 tokens

## 11. 实施步骤

| 阶段 | 内容 | 工期 |
|---|---|---|
| P0 | `vault-loop-core.mjs` + `vault loop` CLI + 状态机测试 | 半天 |
| P1 | `vault-commands.mjs`：7 个 handler + prompt 构造 + `--dry-run` | 1 天 |
| P2 | `vault-enforce.mjs`：pre-step / turn-stopping / guard + 拦停计数 | 半天 |
| P3 | 接线：preset 两行、exports、check-patch 审计、技能补命令说明、verify | 半天 |
| | **合计** | **≈2.5 天** |

## 12. 测试计划

| 类型 | 内容 |
|---|---|
| 单测 | loop 状态机（四种终态、超时降级、nudges 上限）、close 校验（缺产物/引用不足/work 不足/失败声明） |
| 命令测试 | 用假 invocation：断言 loop 文件生成、followup 被调用且 prompt 含出口契约、`--dry-run` 不调用 followup、无参报错、同类互斥 |
| 强制测试 | 假 agent：pre-step 注入、turn-stopping 塞 next-step、超限放行并置 stalled、无 loop 时零动作、guard 命中 loop 目录 |
| 变异测试 | 每个关键行为改坏后测试必须变红 |
| 真装冒烟 | 装包 → 重启 → 输入框敲 `/` 能看到 7 个命令 |

## 13. 风险

| 风险 | 应对 |
|---|---|
| `turn-stopping` 里 `agent` 不可得 | 从 `pre-step` 捕获（payload 含 agent），模块实例本就 per-agent |
| 拦停导致 token 燃烧 | 上限 3（derive 5）+ stalled 放行 + `--abort` |
| 自动建项目污染目录 | `autoCreated: true` 标记 + `--no-init` + `/study-init` 可更新标题 |
| 命令与宿主内置命令重名 | 名字限定 `survey/paper/derive/write/review/status/study-init`，与 compact/goal/plan 不冲突；注册表同层重名会直接报错 |
| 模型绕过 loop 直接改文件 | guard 拦 loop 目录；产物文件本身不拦（AI 必须能写） |

## 14. 非目标

- 不做全自动流水线（与"人在环"定位冲突）
- 不给每个命令单独加工具（走 CLI，保持 18 个工具面）
- 不做定时器（超时用惰性判断）
