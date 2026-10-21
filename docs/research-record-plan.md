# 科研记录（Research Record）：移植 + 重构方案

> 状态：设计稿，待评审。目标版本 0.3.0。
> 定位：**不是移植 dsh-science，而是按可复现性标准重新设计**一套服务于我们科研流程的工具。

## 1. 调研结论

### 1.1 依据的来源

| 来源 | 提供什么 |
|---|---|
| [W3C PROV / RO-Crate Provenance Run Crate 0.2](https://www.researchobject.org/workflow-run-crate/profiles/0.2/provenance_run_crate.html) | 执行的机器可读建模：`CreateAction`（工具执行）含 `instrument`（工具）/ `object`（输入）/ `result`（输出）/ `startTime` / `endTime` / **`actionStatus`（成功/失败）** / **`error`**；内容寻址（`@id` 直接用哈希） |
| [Sandve et al. 2013, *Ten Simple Rules for Reproducible Computational Research*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3812051/) | 可复现的十条规则：**①记录每个结果怎么产生**（程序名+版本+参数+输入）②避免手工步骤 ③归档程序精确版本 ④代码版本控制 ⑤记录中间结果 ⑥**记录随机种子** ⑦**图必须留原始数据** ⑧分层输出 ⑨**文字论断必须连到具体结果** |
| [Schnell 2015, *Ten Simple Rules for a Computational Biologist's Lab Notebook*](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1004385) | 实验记录本规范：④**记录全部科研活动**（不只实验，还有推理与讨论）⑤每条含日期/主题/**背景动机** ⑥记录每个结果如何产生 ⑨**必须有目录索引** |
| [DVC `dvc.yaml` / `dvc.lock`](https://doc.dvc.org/user-guide/project-structure/dvcyaml-files) | 声明式阶段描述（`cmd`/`deps`/`params`/`outs`/`metrics`）+ 锁文件记录实际哈希；内容寻址缓存 |
| [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking/) | run 模型：params / metrics / artifacts / tags / source（含 git commit） |
| [FAIR Principles](https://www.go-fair.org/fair-principles/) | F1 持久标识符、F2 富元数据、R1 可复用（含出处） |
| [PrunE / CliVER 等论断验证工作](https://openreview.net/forum?id=cYAFwjY2bY) | 论断（claim）↔ 证据（evidence）图：把文本断言连到支撑它的具体结果 |

### 1.2 提炼出的六条不变式

这六条是设计约束，任何工具都必须让它们**可被记录、可被校验**：

| # | 不变式 | 来源 |
|---|---|---|
| **I1** | 每个结果都能回答"**怎么产生的**"：命令 + 程序版本 + 参数 + 输入哈希 | Sandve R1/R3、PROV |
| **I2** | 每个执行有**明确成败**与耗时 | PROV `actionStatus`/`error` |
| **I3** | 涉及随机性的运行必须记录**种子** | Sandve R6 |
| **I4** | 图必须能追溯到底层**原始数据** | Sandve R7 |
| **I5** | 文字论断必须连到**具体证据**（文献 citekey / 工件哈希） | Sandve R9、FAIR F1 |
| **I6** | 一切记录可**索引检索**，且有**推理与决策**（不只结果） | 笔记本 R4/R5/R9 |

### 1.3 dsh-science 对照：它覆盖了几条？

| 不变式 | dsh-science artifact | dsh-science research |
|---|---|---|
| I1 怎么产生 | ✅ command/inputs/envFile | ❌ |
| I2 成败与耗时 | ❌ 只有 command 字符串 | ❌ |
| I3 随机种子 | ❌ | ❌ |
| I4 图的原始数据 | ❌ | ❌ |
| I5 论断↔证据 | ❌ | ❌（假设无 citekeys） |
| I6 索引 + 决策 | 部分（list） | ❌ 无决策日志 |

**六条里它覆盖 1.5 条。** 这就是重设计的价值所在——不是"重写更快"，而是"目标不同"。

---

## 2. 设计：四类实体 + 一个索引

```
                ┌──────────────┐
                │  Hypotheses  │  假设（可证伪，带 citekeys）
                └──────┬───────┘
                       │ testing
                ┌──────▼───────┐        ┌──────────────┐
                │  Experiments │───────▶│   Decisions  │  推理与取舍
                │  （计划）     │        │  （为什么）   │
                └──────┬───────┘        └──────────────┘
                       │ 执行
                ┌──────▼───────┐
                │   Records    │  工件（内容寻址 + 运行溯源）
                │ （结果/失败）  │
                └──────┬───────┘
                       │ 支撑
                ┌──────▼───────┐
                │   Claims     │  论断（连到 citekey + record）
                └──────────────┘
```

- **Hypothesis**：proposed → testing → supported/refuted/inconclusive；
  必须带 `citekeys[]`（I5），结论不能直接设。
- **Experiment**（prospective，计划）：`id` / `hypothesis` / `plan` / `seed` / `env` / `status`
- **Record**（retrospective，执行）：`command` / `exitCode` / `durationMs` / `seed` / `env` / `inputs[]` / `outputs[]` / `links`
- **Decision**：`question` / `chosen` / `alternatives[]` / `rationale` / `evidence{citekeys,records}`
- **Claim**：`text` / `evidence{citekeys,records}` / `status(unverified|supported|contradicted)`
- **Index**：自动生成 `INDEX.md` + `index.json`（笔记本 R9）

---

## 3. 工具清单（10 个）

命名空间 `study_`（研究状态 6 个）+ `record_`（工件与运行 4 个）。

| # | 工具 | 一句话 | 关键参数 | 覆盖不变式 |
|---|---|---|---|---|
| 1 | `study_init` | 初始化研究（目录 + study.json，幂等） | `question` `title?` | — |
| 2 | `study_state` | 摘要视图：问题/假设/实验/决策/工件/证据覆盖率 | `detail?` `since?` | I6 |
| 3 | `study_hypothesis` | 登记可证伪假设，**必须引用文献** | `text` `citekeys` `rationale?` | I5 |
| 4 | `study_experiment` | 登记实验计划（含种子与环境） | `hypothesis` `plan` `seed?` `env?` `expect?` | I3 |
| 5 | `study_finding` | 记录观察/结论（推进假设状态与阶段） | `experiment` `finding` `conclusion?` `nextQuestion?` | I5/I6 |
| 6 | `study_decision` | **决策日志**：选了什么、否了什么、为什么 | `question` `chosen` `alternatives` `rationale` `citekeys?` | I6 |
| 7 | `record_save` | 保存工件/登记运行（成败+耗时+种子+环境+关联） | `name` `sources` `command?` `exitCode?` `durationMs?` `seed?` `kind?` `raw?` `experiment?` `citekeys?` | I1/I2/I3/I4 |
| 8 | `record_verify` | 校验：哈希或缺失、**多余文件**、env 漂移、**种子缺失** | `name` `version?` | I1/I3 |
| 9 | `record_reproduce` | 复现指引 + 输入预检（缺哪个、哈希是否一致） | `name` `version?` | I1 |
| 10 | `record_claim` | 把论断绑定到证据（citekey + record），可校验 | `text` `citekeys?` `records?` `status?` | I5 |

### 刻意不做的工具（交给 CLI）

| 需求 | 为什么不做成工具 |
|---|---|
| `record_list` / `record_diff` / `record_prune` | `study_state` 已给概览；细查用 `vault list/diff/prune` CLI，省 3 个工具的常驻上下文 |
| `vault_export`（RO-Crate 导出） | 重操作、低频，CLI：`vault export --ro-crate` |
| `cite-check` 全链校验 | 已有 CLI，扩展而非新增工具 |

**目标上下文**：10 个工具 ≈ **900–1,100 tokens**（对比 dsh-science 的 15 个 = 1,510）。

---

## 4. 数据格式

```
research/
├── study.json                 # 唯一真相（schema 1）
├── records/
│   ├── objects/<aa>/<sha256>  # 内容寻址 blob（跨工件去重）
│   ├── <slug>/v<N>/           # 人类可读版本目录（硬链接到 objects）
│   │   └── manifest.json      # 一版一条记录
│   ├── <slug>/provenance.jsonl # append-only 事件流
│   └── index.json
├── INDEX.md                   # 自动生成目录（笔记本 R9）
└── .lock
```

`study.json` 片段：

```jsonc
{
  "schema": 1,
  "question": { "text": "...", "history": [{ "text": "...", "iteration": 0 }] },
  "loop": { "phase": "experiment", "iteration": 2 },
  "hypotheses": [{
    "id": "H1", "text": "...", "status": "testing",
    "citekeys": ["vaswani2017attention"],          // I5
    "experiments": ["E01"], "reviews": [],
    "history": [{ "at": "...", "from": "proposed", "to": "testing" }]
  }],
  "experiments": [{
    "id": "E01", "hypothesis": "H1", "plan": ["..."],
    "seed": 42,                                     // I3
    "env": "envs/exp.yml@sha256:...",
    "startedAt": "...", "finishedAt": "...",
    "records": ["rmse-v1"]                          // I4
  }],
  "decisions": [{
    "id": "D1", "question": "选 PINN 还是有限元？", "chosen": "PINN",
    "alternatives": ["FEM"], "rationale": "...",
    "citekeys": ["raissi2019pinn"], "records": []
  }],
  "claims": [{
    "id": "C1", "text": "PINN 在该算例上误差 <1%",
    "evidence": { "citekeys": [], "records": ["rmse-v1"] },
    "status": "supported"
  }]
}
```

`records/<slug>/v1/manifest.json` 片段（对照 PROV）：

```jsonc
{
  "name": "rmse", "version": 1, "kind": "data|figure|table|code|model",
  "createdAt": "...", "durationMs": 8412,
  "activity": {                       // PROV CreateAction
    "command": "python train.py --seed 42",
    "exitCode": 0,
    "actionStatus": "CompletedActionStatus",   // 或 FailedActionStatus + error
    "seed": 42,
    "runtime": { "node": "24.19.0", "python": "3.11.9" },
    "host": "...", "gitCommit": "abc1234"
  },
  "inputs":  [{ "path": "data/x.csv", "sha256": "...", "bytes": 1234 }],
  "outputs": [{ "path": "out/rmse.json", "sha256": "...", "bytes": 88 }],
  "raw": [{ "path": "data/x.csv", "sha256": "..." }],   // I4：图的原始数据
  "links": { "experiment": "E01", "hypothesis": "H1", "citekeys": [] },
  "env": { "file": "envs/exp.yml", "sha256": "..." },
  "deprecated": null
}
```

---

## 5. 相对 dsh-science 的改进清单

### 保留（它做对的地方）

文件锁 + 原子写、append-only 废弃、硬链接去重、单文件上限、错误码化、假设状态转移约束、阶段推进。

### 修正（真缺陷）

| # | 问题 | 我们的做法 | 不变式 |
|---|---|---|---|
| F1 | 只记 command，不记成败/耗时 | `actionStatus` + `exitCode` + `durationMs` | I2 |
| F2 | `verify` 不检测多余文件 | 加 `extras[]`，`status=extra` | I1 |
| F3 | `diff` 只有哈希级 | 文本 <256 KB 附行级差异 | — |
| F4 | symlink 被跟随 | `lstat` 跳过并报告 | — |
| F5 | 无默认忽略集 | `.git`/`node_modules`/`__pycache__`/`.venv`/`*.pyc` | — |
| F6 | 换迭代覆盖旧问题 | `question.history[]` 归档 | I6 |
| F7 | 历史溢出丢弃 | 溢出转 `provenance.jsonl` 归档 | I6 |
| F8 | 假设无文献关联 | `citekeys[]` 且**强制校验存在** | I5 |
| F9 | 实验与工件无链接 | 双向 `experiment.records[]` / `links.experiment` | I1 |
| F10 | 阶段回退是全局开关 | 允许退一级 + 必须写 `reason` | — |
| F11 | 评审只能写不能查 | `study_state` 汇总 + CLI `vault reviews` | I6 |

### 新增（标准要求、原版没有）

| # | 能力 | 来源 |
|---|---|---|
| N1 | **随机种子**字段与缺失告警 | Sandve R6 |
| N2 | **图的原始数据**（`kind: figure` + `raw[]`） | Sandve R7 |
| N3 | **决策日志** `study_decision` | 笔记本 R4/R5 |
| N4 | **论断↔证据** `record_claim` | Sandve R9 / FAIR |
| N5 | **内容寻址 blob 存储**（跨工件去重） | RO-Crate @id / DVC |
| N6 | **INDEX.md 自动目录** | 笔记本 R9 |
| N7 | **RO-Crate 导出**（CLI） | 互操作 |
| N8 | **env 漂移检测**（当前环境 vs 记录） | Sandve R3 |

---

## 6. 与既有构件的联动（我们独有的优势）

```
lit-lib（citekey）
      │  study_hypothesis --citekeys
      ▼
 study.json ──study_decision──► decisions
      │                            │
      └──record_save --experiment──┴──► manifest.links
                                       │
                              record_claim --records
                                       │
                            cite-check --deep（全链校验）
```

`cite-check --deep` 新增校验：
1. `study.json` 里所有 `citekeys` 都在 `literature/notes/` 中
2. 所有 `claims` 至少有一条证据（citekey 或 record）
3. 所有 `records[].links.citekeys` 有效
4. `experiments[].records` 指向的工件存在
5. 报告"无文献支撑的假设"与"无证据的论断"

---

## 7. 实施步骤

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| **P0** | `vault-core.mjs`（锁/原子写/流式哈希/内容寻址/walk）+ 单测 | 半天 | 并发写、中断、大文件、去重全通过 |
| **P1** | `record_*` 4 工具 + F1–F5 + N1/N2/N5 | 1 天 | 工件可存可验可复现；失败运行也留痕 |
| **P2** | `study_*` 6 工具 + F6–F11 + N3 | 1 天 | 状态机、归档、决策日志、citekey 校验 |
| **P3** | N4 `record_claim` + N6 索引 + N7 导出 + `cite-check --deep` | 半天 | 全链校验能揪出无证据论断 |
| **P4** | 接线：preset 2 行、技能更新、`check-patch` 审计、CI、删除 remote-compute | 半天 | 11 项 + 新增测试全绿 |
| | **合计** | **≈3.5 天** | 10 个工具 |

## 8. 上下文预算

| 项 | tokens/请求 |
|---|---|
| 现有 6 个工具（lit_* + pdf_*） | ~600 |
| **新增 10 个工具** | **~1,000** |
| 技能目录（16 个） | ~553 |
| **dsh-science 31 工具（现状）** | **~1,941** |
| **改造后净变化** | **−941 → 约 1,000** |

（前提：删掉 remote-compute 并停止依赖 dsh-science 的这两个引擎。）

## 9. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 自写的正确性（persona/delegation 教训） | 每阶段跑 `check-patch` 审计 + 真装冒烟；所有工具先离线单测 |
| 内容寻址存储实现复杂 | N5 标注为 P1 可选，先做硬链接去重，二期再上 blob store |
| 与 dsh-science 数据并存 | 目录名不同（`research/` vs `artifacts/`），互不干扰；提供 `vault migrate` 一次性导入 |
| 强制 citekeys 造成录入摩擦 | `study_hypothesis` 的 `citekeys` 允许为空但**记入"无文献支撑"清单**，由 `cite-check --deep` 报告，不硬拒 |

### 已拍板（2026-10-21）

| # | 决定 | 落地方式 |
|---|---|---|
| 1 | **软提醒** | `study_hypothesis` 的 `citekeys` 可选；不硬拒。`cite-check --deep` 输出「无文献支撑的假设」清单 |
| 2 | **先硬链接去重** | P1 实现 `linkOrCopy()`（同设备硬链接、跨设备降级为复制并告警）；内容寻址 blob store（N5）推迟到 P3 之后按需评估 |
| 3 | **零迁移** | 实测：本机无 `research-manifest.json`、无 `artifacts/artifacts.json`、无任何 `provenance.md`/`artifact.json`/`.lock`。**dsh-science 的两个引擎从未产生过数据**，因此不做 `vault migrate`，P3 省半天 |

> 数据核查记录：`find /home/blake/workspaces /home/blake/.dsh -name research-manifest.json` → 0 条；
> `-name artifacts.json` → 0 条；`-name provenance.md` → 0 条。
> 仅有的 `artifacts/`（burn-learn）与 `experiments/`（WSR）目录属其它项目，格式无关。

省下的半天改投 **P0.5 真装冒烟**：本地打 tarball → 装进 profile → 重启 → 确认 10 个工具确实注册且可调用。
理由：persona `text` 与 delegation `worker-thread` 两次事故都发生在这一层，静态检查无法覆盖。


## 实施进度（2026-10-21）

| 阶段 | 状态 | 交付 |
|---|---|---|
| P0 | ✅ | `vault-core.mjs`：文件锁、原子写、流式哈希、硬链接去重、忽略遍历；24 条断言 + 4 个变异测试 |
| P1 | ✅ | `vault-record.mjs`：`record_save` / `record_verify` / `record_reproduce`；36 条断言 + 4 个变异测试 |
| P2 | ✅ | `vault-study.mjs`：`study_init` / `state` / `hypothesis` / `experiment` / `finding` / `decision` / `review` / `phase`；44 条断言 + 4 个变异测试 |
| P3 | ✅ | `study_claim`（论断↔证据）、`INDEX.md` 自动生成、`scripts/vault.mjs`（index/list/show/diff/prune/export）、`cite-check --deep`；CLI 与 deep 各自成测 + 4 个变异测试 |
| P4 | ⏳ | preset 接线、技能更新、删除 remote-compute |

**工具总数 12**：`record_*` 3 + `study_*` 9。
验收基线：`bash scripts/verify.sh` = 16 项全过。

### 实施与审查中发现并修正的缺陷

**数据损坏级**

1. **文件锁在长任务期间被抢走**：锁只按文件 mtime 判断陈旧，任何超过 `staleMs`（30s）的
   `record_save`（大目录复制）都会被后续调用当成陈旧锁回收 → 两个写者同时改 manifest/index。
   修法：持锁期间**心跳续期**（staleMs/3 刷新 mtime）+ 抢锁前**检查持锁 PID 是否还活着**
   （死进程留下的锁立即回收，不用干等）。
2. **多源同名文件静默覆盖**：`sources: ['data','extra']` 里都有 `a.csv` 时落到同一路径，
   后者覆盖前者，清单还声称两个都在。修法：逐源遍历并打源名前缀消解冲突，落盘后校验路径唯一。

**功能错误**

3. `inputs[].path` 曾只存「相对源目录」路径，复现时按项目根找不到原文件 → 增记 `sourcePath`。
4. 阶段回退标注用 `change.to < change.from`（字符串字典序，`'experiment' < 'analysis'` 为 false）→ 改用阶段索引。
5. `vault diff` 默认对比的 `from` 用升序 `find` 取到**最旧版**而非上一版 → 反向查找。
6. `vault export` 的 `endTime` 写反（有耗时反而给 `undefined`）→ 由 `createdAt + durationMs` 推出。
7. CLI 入口用 `import.meta.url === file://${argv[1]}` 判断，经 npm bin 符号链接调用时不等 →
   **装好后命令静默无输出**。改用 realpath 比对（与 `lit-lib` 同一处坑）。
8. `vault prune` 不清理 `by-hash.json` 的死条目，去重表只增不减 → 清理时校验文件存在。
9. `record_save` 不刷新 `INDEX.md`，工件表停在旧状态 → 保存后联动刷新。

**工程缺陷**

10. 技能与文档仍写 `provenance.md`（实际落盘是 `provenance.jsonl`）→ 已改正。
11. `study_experiment` 的 `status` 参数曾"删除失败"（正则没匹配到双空格），后续恢复时又插入一份
    → 出现重复键，已清理；并加了重复参数键扫描。
12. `vault export` 虚构 `object`（本工具不区分输入/输出）→ 只输出 `result`，并在 crate 里注明。
13. 若干未使用的 import、`seeen` 拼写 → 已清理。

> 每一项都配了回归测试，并用变异测试确认「把修复改回去 → 测试变红」。
