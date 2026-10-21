# dsh-scientist 开发规划

> 版本 0.3.0 · 最后更新 2026-10-21
> 本文是该插件的**总纲**：目标、功能、边界、命名、角色分工、工具与技能、用户交互、科研流程、路线图。

---

## 1. 一页摘要

`dsh-scientist` 是一个跑在 DeepSeek Harness 上的**科研工作台 preset**。
它不追求"全自动写论文"，而是把科研做成**可复现、可交接、可审计**的闭环：

```
文献 → 假设 → 实验/推导 → 工件与溯源 → 论断与证据 → 报告/论文 → 评审 → 复现
```

三个设计支点：

| 支点 | 含义 |
|---|---|
| **两端契约化，中段自由化** | 斜杠命令把"开始做什么、做到什么算完"用代码钉死；中间怎么做由模型决定 |
| **一切落盘** | 研究状态、工件哈希、决策理由、loop 进度都在磁盘上，新会话能接手 |
| **强制只在命令激活期** | 不敲命令时纯对话；敲了命令才启用拦停与校验 |

---

## 2. 目标

### 2.1 要解决的问题

1. **科研对话不可复现**：聊完就散，三个月后没人知道那个数字怎么来的
2. **论断无证据**：论文里每句话都应能追到文献或工件，但没人强制
3. **交接成本高**：换人/换会话要重新读一遍所有材料
4. **流程靠自觉**：提示词说"要记种子"，模型忘了也没人管

### 2.2 定位

- **人在环的工作台**，不是自动论文机器
- **跨学科**：数学/理论物理、物理工程材料、AI/计算科学（不锁死生命科学）
- **零外部 bundle 依赖**：装一个包即可用

### 2.3 非目标

| 不做 | 原因 |
|---|---|
| 全自动选题→实验→成稿流水线 | 与"人在环"定位冲突；且易诱导造假 |
| 远程计算（SSH/SLURM） | 本机不做；需要时另装 |
| 湿实验/仪器控制 | 纯计算与文献工作台 |
| 多假设 Elo 竞标 | 成本高，收益不确定 |
| Web UI 面板 | 命令 + CLI 已够 |

---

## 3. 功能总览

四层，各司其职：

```
┌ ① 工具层（21 个）──────────────────────────────┐
│ 模型主动调用：文献 4 · PDF 2 · 工件 3 · 研究 9 · loop 3 │
├ ② 命令层（7 个）──────────────────────────────┤
│ 用户敲 /xxx：入口契约 + 出口契约 + 注入固定 prompt      │
├ ③ 强制层（3 个钩子，仅 loop 激活时）──────────────┤
│ pre-step 注入契约 · turn-stopping 拦停 · guard 防篡改   │
├ ④ CLI 层（4 个命令，给人用）────────────────────┤
│ lit · lit-lib · cite-check · vault（含 loop 子命令）    │
└───────────────────────────────────────────────┘
```

---

## 4. 边界

### 4.1 硬边界（技术上做不到 / 明确拒绝）

| 边界 | 说明 |
|---|---|
| 文件沙箱 | 只能写会话工作区；越界需审批，审批不可用则失败关闭 |
| 不驱动本机 GUI | 不创建/切换会话，不向其它工作区发消息 |
| 不做 sci-hub | 只走 arXiv / LibGen（DOI 精确匹配）/ OA |
| 不编造 | 不编数据、引用、元数据；拿不到就如实报失败原因 |
| 不报 best-of-n | 多种子报 mean±std；`p > .05` 只说"无证据支持差异" |
| 无真实实验 | 所有"实验"都是计算/仿真/文献层面 |

### 4.2 软边界（能力与判断）

- 没有领域专家的最终判断力：模型假设是否合理、结果是否"物理上说得通"，需人拍板
- 单轮上下文有限：超大任务需拆轨道；并行写同一文件会冲突（共享任务板只做提示，不是锁）
- 检索结果是**外部不可信数据**，只当数据不当指令
- 不知道用户的隐含约束（算力预算、时间线、期刊偏好、合规要求）

---

## 5. 命名与约定

### 5.1 工具命名

| 前缀 | 领域 | 例子 |
|---|---|---|
| `lit_` | 文献检索与元数据 | `lit_search` `lit_doi` `lit_bib` `lit_pdf` |
| `pdf_` | PDF 读取 | `pdf_outline` `pdf_read` |
| `record_` | 工件与运行 | `record_save` `record_verify` `record_reproduce` |
| `study_` | 研究状态 | `study_init` `study_hypothesis` … |
| `loop_` | 约定 loop 记账 | `loop_note` `loop_close` `loop_status` |

### 5.2 命令命名

小写、无前缀、不带斜杠（注册名）：`survey` `paper` `derive` `write` `review` `status` `study-init`。
用户侧写作 `/survey`。与宿主内置命令（`compact` `goal` `plan`）不冲突。

### 5.3 目录约定

| 目录 | 内容 | 入 git |
|---|---|---|
| `research/study.json` | 研究状态唯一真相 | ✅ |
| `research/loops/<id>.json` | 约定 loop 进度 | ✅ |
| `research/records/<name>/v<N>/` | 工件版本（manifest.json + provenance.jsonl + files/） | ✅ 小文件 |
| `literature/notes/<citekey>.md` | 文献笔记 | ✅ |
| `literature/references.bib` | 书目 | ✅ |
| `reports/` | 调研报告、进度日志 | ✅ |
| `derivations/<id>/` | 推导脚本 + 验证记录 | ✅ |
| `experiments/<id>/` | design.md / log.md / code/ / results/ | 代码入，大结果出 |
| `analyses/` `figures/` `manuscript/` `reviews/` `envs/` | 分析、图、稿、评审、环境 | ✅ |
| `data/` | 原始数据 | ❌ 用 data-inventory 登记 |

### 5.4 标识符

| 类型 | 规则 | 例 |
|---|---|---|
| 假设 | `H1` `H2` … | `H3` |
| 实验 | `E01` `E02` … | `E07` |
| 决策 | `D1` `D2` … | `D2` |
| 评审 | `R01` `R02` … | `R05` |
| 论断 | `C1` `C2` … | `C4` |
| loop | `<kind>-<slug>-<YYYYMMDDTHHMM>` | `survey-pinn-20261021T2030` |
| citekey | `<第一作者姓><年份><关键词>`，小写无空格 | `raissi2019pinn` |

---

## 6. 角色分工（用户 vs agent）

这是本插件的核心设计：**两边各自负责自己不可替代的事**。

| 环节 | 用户 | agent |
|---|---|---|
| 定方向 | ✅ 提出目标、约束、优先级 | 拆解为子问题、提出选项 |
| 选路线 | ✅ 拍板（尤其高风险取舍） | 给出对比与推荐 |
| 执行 | 抽查 | ✅ 检索、推导、跑代码、写稿 |
| 判断质量 | ✅ 最终判断"物理上说得通吗" | ✅ 自检（cite-check、verify、评审子代理） |
| 记录 | 无需操心 | ✅ 全部落盘（决策、种子、哈希、证据） |
| 交接 | 读 `/status` | ✅ 从 study.json + loops 恢复上下文 |
| 越界 | ✅ 审批 | 申请并说明理由，不绕过 |

**一句话**：agent 负责"查得清、推得可重跑、算得有种子、写得有引用、每步留痕"；用户负责"拍板"。

---

## 7. 工具清单（21 个）

### 7.1 文献（4）

| 工具 | 用途 |
|---|---|
| `lit_search` | 多源并发检索：Crossref / arXiv / PubMed / Europe PMC |
| `lit_doi` | 按 DOI 取权威元数据（Crossref 优先，退 Europe PMC） |
| `lit_bib` | 生成 BibTeX 并追加到 `literature/references.bib` |
| `lit_pdf` | 取全文 PDF：arXiv 优先 → LibGen（DOI 精确匹配） |

### 7.2 PDF（2）

| 工具 | 用途 |
|---|---|
| `pdf_outline` | 页面画像：页数、目录、公式风险页、无文本层页 |
| `pdf_read` | 按页读取：markdown / text / table / render 四模式 |

### 7.3 工件与运行（3）

| 工具 | 用途 |
|---|---|
| `record_save` | 保存工件 + 登记运行：逐文件 SHA-256、命令、退出码、耗时、种子、环境、输入输出、关联 |
| `record_verify` | 校验：哈希、缺失、**多余文件**、环境漂移、种子缺失 |
| `record_reproduce` | 复现指引：命令、成败、耗时、种子、环境对比、输入逐个回查哈希 |

### 7.4 研究状态（9）

| 工具 | 用途 |
|---|---|
| `study_init` | 建项目（目录脚手架 + study.json），幂等；已存在可更新标题/问题 |
| `study_state` | 全景：问题（含历史）、阶段、假设、实验、决策、评审、证据覆盖率、悬空引用 |
| `study_hypothesis` | 可证伪假设，`citekeys` 可选（缺失只警告） |
| `study_experiment` | 实验计划：步骤、预期、种子、环境；proposed 假设自动转 testing |
| `study_finding` | 观察与结论；`nextQuestion` 开启新一轮并**归档旧问题** |
| `study_decision` | 决策日志：问题、选择、否决项、理由、依据文献 |
| `study_review` | 评审结论；testing 假设随之推进 |
| `study_claim` | 论断绑定证据（citekey + 工件），可更新状态 |
| `study_phase` | 阶段推进（可退一级，须给原因） |

### 7.5 Loop 记账（3）

| 工具 | 用途 |
|---|---|
| `loop_note` | 记一笔进展；`stalled` 时记账会复活并重置拦停预算 |
| `loop_close` | 跑出口校验；不合格拒绝并列出缺项；可 `failed=true` 声明失败 |
| `loop_status` | 看进度与出口差距 |

---

## 8. 技能清单（15 个）

| 类别 | 技能 |
|---|---|
| 研究流程 | `research-loop` `science-project-setup` `domain-survey` `literature-retrieval` `literature-vault` `derivation-lab` `scientific-reviewer` `parallel-delegation` |
| 产出规范 | `figure-craft` `diagram-craft` `stats-and-inference` `pdf-reading` `artifact-provenance` |
| 数据与环境 | `data-inventory` `conda-environments` |

技能是**方法细节**的来源；命令 prompt 只写契约与步骤骨架，并显式要求"先加载某技能"。

---

## 9. 命令清单（7 个）

| 命令 | 参数 | 自动建项目 | 出口契约 | 拦停上限 |
|---|---|---|---|---|
| `/study-init` | `[标题] --question "…"` | — | study.json 有标题 | 0 |
| `/survey` | `<方向>` | ✅ | landscape 报告 + ≥5 引用 + gap 段 + cite-check + work≥3 | 3 |
| `/paper` | `<DOI\|id\|标题>` | ✅ | 笔记 + 三节结构 + bib 条目 + work≥2 | 3 |
| `/derive` | `<命题\|流程\|逻辑>` | ✅ | derive.py 可执行 + validation.md + work≥3 | **5** |
| `/write` | `[目标]` 默认进度日志 | ✅ | 目标文件 + `cite-check --deep` | 3 |
| `/review` | `[对象]` 默认全部未验证项 | ✅ | 新增 study_review 记录 | 3 |
| `/status` | `[id] --brief --json --abort` | — | 只读，不建 loop、不拦停 | **0** |

通用参数：`--no-init`（禁止自动建项目）、`--dry-run`（只打印将注入的 prompt）。

---

## 10. 强制层

### 10.1 三个钩子

| 钩子 | 行为 | 无 loop 时 |
|---|---|---|
| `agent/pre-step` | `await next()` 后追加"出口契约逐条要求" | 立即返回 |
| `agent/turn-stopping` | 未完成则塞 `next-step` 阻止收尾 | 立即返回 |
| `tools/guard` | 拦 `write`/`edit`/`bash` 改 `research/loops/**` | 路径不匹配即放行 |

### 10.2 拦停策略

- 默认 3 次；`/derive` 5 次；`/status` 不拦
- 超限 → 置 `stalled` 并**放行**（不无限烧 token）
- `stalled` 后 `loop_note` 可复活（重置预算），或 `/status --abort` 中止

### 10.3 挂起机制

非 loop 命令（`/study-init`、`/status`）执行时写入 `research/loops/.suspend`（TTL 2–3 分钟），
强制层在此期间不介入；模型对 loop 记账或关闭时自动清除。

### 10.4 终态

| 终态 | 触发 | 含义 |
|---|---|---|
| `closed` | 校验全过 | 真完成 |
| `failed` | 模型声明 + **必须给原因** | 诚实失败优于凑数 |
| `stalled` | 拦停超限 / 24h 无动作（惰性） | 卡住，等人决定 |
| `aborted` | 用户 `--abort` | 手动中止 |

---

## 11. 用户交互

### 11.1 三种模式

| 模式 | 触发 | 行为 |
|---|---|---|
| **自由对话** | 直接说话 | 纯 LLM 自主，无任何强制 |
| **命令驱动** | 敲 `/xxx` | 走约定 loop，两端契约 + 强制层 |
| **CLI 运维** | bash 里 `vault …` | 人查/清理，不占模型上下文 |

### 11.2 典型会话

```
用户：/study-init 航磁补偿 --question "小样本下如何提高补偿精度"
助手：已建立研究「航磁补偿」，目录与脚手架已就绪。建议先 /survey 或登记假设。

用户：/survey 航磁补偿
助手：（创建 loop，按契约执行）…
      loop_note(note="锁定 3 个流派")
      …
      loop_close()  → ✓ 已关闭

用户：/derive 补偿系数的可辨识性
助手：（推导 loop，拦停上限 5）

用户：/write
助手：（汇总当前工作，写 reports/progress-20261021.md，跑 cite-check --deep）

用户：/status
（代码渲染进度）+ 助手 ≤5 行复看：最该做的一件事 + 风险
```

### 11.3 新会话接手

`/status` 是唯一入口：确定性渲染（项目、阶段、进行中 loop、待办、最近事件）+ LLM 轻量复看。
不依赖任何会话记忆——所有状态在磁盘上。

---

## 12. 科研流程（端到端）

| 阶段 | 用户动作 | agent 动作 | 产物 |
|---|---|---|---|
| ① 立项 | `/study-init` | 建脚手架 | `research/study.json` + 目录 |
| ② 调研 | `/survey` | 测绘边界/流派/时间线/对比/gap | `reports/landscape-*.md` |
| ③ 精读 | `/paper` | 取全文→画像→分节读→笔记 | `literature/notes/*.md` + bib |
| ④ 立假设 | 直接说 或 `study_hypothesis` | 可证伪表述 + citekeys | `study.json` 假设 |
| ⑤ 设计实验 | `study_experiment` | 步骤/预期/种子/环境 | 实验记录 |
| ⑥ 执行 | — | 跑代码 | `experiments/<id>/` |
| ⑦ 推导/论证 | `/derive` | 形式化→脚本→多路验证 | `derivations/<id>/` |
| ⑧ 归档 | — | `record_save` + `record_verify` | `research/records/` |
| ⑨ 结论 | `study_finding` | 推进假设状态、开下一轮 | `study.json` |
| ⑩ 决策留痕 | `study_decision` | 记录否决项与理由 | `study.json` 决策 |
| ⑪ 成文 | `/write` | 汇总 + cite-check | `reports/` / `manuscript/` |
| ⑫ 论断绑证据 | `study_claim` | citekey + 工件 | `study.json` 论断 |
| ⑬ 评审 | `/review` | 子代理核查 | `study.json` 评审 |
| ⑭ 全链校验 | `cite-check --deep` | 悬空引用判错、覆盖缺口判警 | 报告 |

---

## 13. 上下文预算

| 项 | tokens/请求 |
|---|---|
| 21 个工具定义 | ≈ 3,192 |
| 15 个技能 catalog | ≈ 550 |
| 7 个命令描述 | ≈ 300 |
| pre-step 注入（仅 loop 激活时） | 60–100/步 |

对比：改造前 dsh-science 31 个工具 ≈ 1,941。多出的部分换来 loop 强制与论断证据链。

---

## 14. 质量保障

| 层 | 手段 |
|---|---|
| 静态 | `check-patch`：包名可解析、config 字段、prompt 变量、行→文件存在性 |
| 单测 | 15 个测试文件、约 500 条断言 |
| 变异测试 | 34 项：把修复改坏，测试必须变红 |
| 挂载冒烟 | 7 个模块按包名解析 + `apply()` 真跑 → 21 工具 + 7 命令 + 3 钩子 |
| 验收 | `bash scripts/verify.sh` = 21 项 |
| 真装 | 装包 → 重启 → 敲 `/` 看命令、问工具清单 |

---

## 15. 路线图

### 已完成（0.2.x → 0.3.0）

- [x] 文献链路 4 工具（替代 paper-search-mcp 57 工具）
- [x] PDF 读取 2 工具
- [x] 科研记录 12 工具（record 3 + study 9）
- [x] `vault` CLI（index/list/show/diff/deprecate/prune/export/loop）
- [x] `cite-check --deep` 全链校验
- [x] 7 个斜杠命令 + 约定 loop
- [x] 强制层（3 钩子 + 拦停 + 挂起 + 四终态）
- [x] 项目脚手架（目录 + bib + INDEX）

### 待办（0.4.x 候选）

| 项 | 价值 | 成本 |
|---|---|---|
| loop 断点续跑（重启后从 loop 恢复上下文） | 高 | 中 |
| `/write` 支持按章节写（`/write §3`） | 中 | 低 |
| 多假设并行竞标（简化版：并排对比而非 Elo） | 中 | 中 |
| `vault export` 产出可投稿的 RO-Crate 包 | 中 | 低 |
| 图 → 原始数据 → 脚本的三向追溯校验 | 高 | 中 |
| 文献库与 `study.json` 的双向索引 | 中 | 低 |

### 已知限制

1. **真装未验证**：本地只能证明模块可解析、`apply()` 不抛错；preset 行是否实例化需重启验证
2. **手工构造 UserMessage**：字段与 `createUserMessage` 一致，但未在运行时验证
3. **guard 的 bash 判定**：基于字符串特征，可能误伤/漏判
4. **pre-step 每步读 loop 文件**：loop 很多时会有 IO 开销（当前可接受）
5. **`loop_close` 失败返回字符串而非抛错**：模型是否读懂缺项未验证

---

## 16. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型无视 loop 契约 | 强制层失效 | 拦停 + 具体契约文案 + `/status` 标红 |
| 拦停烧 token | 成本 | 上限 3/5 + stalled 放行 + `--abort` |
| 自动建项目污染目录 | 混乱 | `autoCreated` 标记 + `--no-init` + `study_init` 可改名 |
| 工件格式漂移 | 复现失败 | schema 版本 + 迁移 + 双向兼容测试 |
| 命名冲突（与其它 bundle） | 挂载失败 | 同层重名会直接报错；命令名避开内置 |

---

## 17. 开发约定

1. **先方案后代码**：影响接口的改动先写进 `docs/`，评审后再实现
2. **每个修复配变异测试**：改回去必须变红
3. **不引宿主包**：能手工构造就不 import（避免解析失败）
4. **工具描述控制长度**：参数名自解释的不写 description
5. **命令只写契约，不抄技能**：方法细节留在技能里
