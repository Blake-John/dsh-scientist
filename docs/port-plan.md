# 移植与改进方案：artifact-registry + research-loop

> 状态：设计稿，待评审。目标版本 0.3.0。
> 范围：移植 dsh-science 的两个引擎（15 个工具），**不移植** remote-compute。

## 0. 为什么可以同名

`packages/core/tools/src/index.ts:747` 的报错文案明确写出：
> `tool "X" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`

同名冲突只在**同一层内**失败。我们的 preset 行挂在 agent scope，属于独立层，
因此可以注册与 dsh-science（HOST 平面）**同名的工具**并 shadow 它：

- 科学家模式 → 用我们的实现
- 其它 agent → 继续用 dsh-science 的

**收益**：16 个技能、人格文本、`check-patch` 白名单**全部不用改**；
用户不需要卸载 dsh-science；可以灰度切换、随时退回。

**风险**：shadowing 未实测。P0 必须先做一次最小验证（注册一个同名假工具看是否成功且生效）。
失败则退到 fallback：工具名加前缀 `vault_`，同步改 11 个技能。

## 1. 兼容策略（强约束）

文件格式**完全沿用**，只增字段不改语义：

```
artifacts/<name>/v<N>/            版本目录（不变）
artifacts/<name>/artifact.json    追加字段（links / provenance 细节）
artifacts/<name>/.../provenance.md  追加段落
artifacts/artifacts.json          索引（追加字段）
artifacts/.lock                   同一把锁
research-manifest.json            schema 2 → 3（带迁移）
```

要求：**用 dsh-science 造的数据，我们的工具必须能读；反之亦然**（P4 有专门的双向测试）。

## 2. 模块结构

```
vault-core.mjs      # 共享底座（~350 行）
vault-artifacts.mjs # 7 个 artifact 工具（~600 行）
vault-research.mjs  # 8 个 research 工具（~650 行）
```

`vault-core.mjs` 提供：
- `withFileLock(file, opts, fn)` — 与 dsh-science 相同的锁语义（timeoutMs/staleMs）
- `writeJsonAtomic` / `readJson`
- `hashFileStreaming` — 流式 SHA-256（复用 lit-core 的写法）
- `walkSources(dir, {ignore, followSymlinks:false})` — 带默认忽略集
- `sciErr(code, msg)` — 错误码化
- `resolveRoot` / `slugify` / `nowISO` / `optStr` / `requireStr`

## 3. 工具契约

### artifact 侧（7 个，名字不变）

| 工具 | 变更 | 新增参数/输出 |
|---|---|---|
| `artifact_save` | **加溯源执行上下文 + 关联** | 入参 +`experiment?` `hypothesis?` `citekeys?`<br>自动采集 `exitCode?` `durationMs` `host` `gitCommit?` `runtime{node,python}` |
| `artifact_list` | 加过滤 | 入参 +`tag?` `experiment?` `deprecated?` |
| `artifact_show` | 不变 | 输出含 `links` |
| `artifact_diff` | **加内容级差异** | 输出 `changed[].linesAdded/linesRemoved/diff?`（文本 <256 KB） |
| `artifact_verify` | **检测多余文件** | 输出 +`extras[]`；status 增加 `extra` |
| `artifact_deprecate` | 不变 | — |
| `artifact_reproduce` | 加缺失检查 | 输出 +`missingInputs[]` `envDrift?` |
| `artifact_prune` | **新增**（第 8 个） | 入参 `keep?` `deprecatedOnly?` `dryRun?` |

### research 侧（8 个，名字不变）

| 工具 | 变更 | 说明 |
|---|---|---|
| `research_init` | 不变 | 幂等 |
| `research_state` | 加摘要 | +评审摘要、+未读工件、+citekey 覆盖率 |
| `research_hypothesis` | **加文献关联** | 入参 +`citekeys?`（校验存在于 literature/notes/） |
| `research_experiment` | 加时间维度 | 入参 +`citekeys?`；记录 `startedAt` |
| `research_findings` | **归档旧问题** | `nextQuestion` 时把旧问题推入 `questionHistory` |
| `research_phase` | **允许逐级回退** | 入参 +`reason?`；只能退一级，且必须给原因 |
| `research_review` | 不变 | — |
| `research_report` | 加链接 | 输出含 hypothesis→experiment→artifact→citekey 拓扑 |
| `research_reviews` | **新增**（第 9 个） | 列出/对比评审 |

## 4. 改进清单（可逐条验收）

### artifact

- **A1 溯源补执行上下文**（🔴 最实质）
  从 `exec` 采集 `exitCode`/`durationMs`/`host`/`gitCommit`/`runtime`。
  验收：`artifact_show` 能看出上次跑成功与否、花了多久、在哪个 commit。
- **A2 verify 检出多余文件**
  验收：往 v1/ 塞一个文件 → `status != ok` 且 `extras` 含该路径。
- **A3 diff 内容级**
  文本文件 <256 KB 附 `diff` 与 `+N/-M`。
- **A4 symlink 默认跳过**（`lstat`）+ 结果里报告跳过项。
- **A5 默认忽略集**：`.git` `node_modules` `__pycache__` `.venv` `*.pyc` `.DS_Store`，支持 `exclude` 覆盖。
- **A6 cross-link**：`links{experiment,hypothesis,citekeys}`，并写入 manifest 的 `experiments[].artifacts[]`。
- **A7 prune**：`--keep N` / `--deprecated-only` / `--dry-run`；硬链接去重后按引用计数回收。

### research

- **R1 旧问题归档**（🔴 修数据丢失）
  `questionHistory: [{text, fromIteration, toIteration, closedBy}]`。
- **R2 历史溢出归档**
  超过 1000 条时先 append 到 `.science-history.jsonl` 再裁剪。
- **R3 假设 ↔ citekey**（★ 我们的独有优势）
  `hypothesis.citekeys[]`；写入前校验 `literature/notes/<citekey>.md` 存在。
- **R4 实验 ↔ 工件双向**
  `experiment.artifacts[]`；`artifact_save --experiment E01` 自动双向登记。
- **R5 逐级回退**
  只能退一级 + 必须 `reason`，写入 history。
- **R6 `research_reviews`** 列表 + `research_state` 显示评审摘要。
- **R7 时间维度**：`experiment.startedAt/finishedAt/durationMs`。

## 5. 与 lit-lib 的联动（自写的核心理由）

原版做不到，因为它是通用科研包；我们手里有 citekey 体系。

```
literature/notes/<citekey>.md
        │ citekeys[]
        ▼
research_hypothesis ──→ research_experiment ──→ artifact_save
        │                      │                      │
        └──────── questionHistory ────────────────────┘
                               │
                        research_report（拓扑）
                               │
                          cite-check（校验全链 citekey 有效）
```

新增校验：`cite-check --root .` 扩展为检查
`research-manifest.json` 与 `artifacts/*/artifact.json` 里引用的 citekey 是否都在库中。

## 6. 实施步骤与工作量

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P0** | shadowing 最小验证 + `vault-core.mjs` + 单测 | 半天 | 同名注册成功且生效；核心工具函数测试通过 |
| **P1** | artifact 7 工具 + A1–A5 | 1 天 | 7 套单测；与原版数据双向兼容 |
| **P2** | research 8 工具 + R1/R2/R4 | 1 天 | 状态机/迁移/归档测试 |
| **P3** | 联动（R3/R5/R6/R7 + A6/A7 + `research_reviews`） | 半天 | citekey 校验、双向链接、prune |
| **P4** | 接线：preset 2 行、技能更新、`check-patch` 白名单、`verify.sh`、CI | 半天 | 11 项 + 新增测试全绿 |
| 合计 | | **≈ 3.5 天** | 16 个工具上线 |

## 7. 测试计划

| 类型 | 内容 |
|---|---|
| 离线单测 | 锁（并发写不丢）、原子写（中断不半截）、流式哈希（大文件）、迁移（v2→v3）、状态机（非法转移被拒） |
| **兼容测试** | 用 dsh-science 生成的 fixture → 我们的工具读；我们的输出 → 原版工具读 |
| 变异测试 | 每个改进一条"改回旧实现应变红"的断言（沿用现有做法） |
| 挂载冒烟 | 真装 + 重启 + 问一句"有哪些工件工具"（唯一剩下的验证） |

## 8. 风险

| 风险 | 应对 |
|---|---|
| 同名 shadowing 未实测 | P0 先验证；失败退 fallback（`vault_` 前缀 + 改 11 技能） |
| 与原版格式漂移 | 锁 + schema 迁移 + 双向兼容测试进 CI |
| 上下文成本上升 | 15→16 个工具，描述按"一句话 + 参数说明"压缩，目标 ≤1500 tokens（原版 1941） |
| 我们自己写错（persona/delegation 教训） | 每阶段都跑 `check-patch` 的 config/包名审计 + 真装冒烟 |

## 9. 非目标

- 不移植 `remote-compute`（16 工具 / 1779 行）
- 不做 Web UI（原版 remote-hosts-ui / model-tier-ui）
- 不自动执行 prune（只提供命令）
- 不追求与 dsh-science 的 API 100% 一致（只保证**文件格式**与**工具名**）
