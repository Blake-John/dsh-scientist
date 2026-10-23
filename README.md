# 科学家模式（scientist）— 通用科研 agent preset

面向 **数理 / 物理·工程·材料 / AI·计算科学** 的跨学科科研 agent。

## 三根支柱

| 支柱 | 能力 | 技能 |
|---|---|---|
| 领域调研 | 分阶段漏斗：网络调研 → 学术检索 → 流派/时间线/对比/gap → 论文总述 → 综合报告 | `domain-survey` |
| 文献检索 | 4 个原生工具：`lit_search`（多源检索）/ `lit_doi`（DOI 元数据）/ `lit_bib`（生成 BibTeX）/ `lit_pdf`（取全文） | `literature-retrieval` |
| 科研记录 | 12 个原生工具：`study_*`（9）+ `record_*`（3） | `research-loop` / `artifact-provenance` |
| 读 PDF | 页面画像 → 结构化 md / 纯文本 / 表格 / 渲染成图四路并用，公式与图表视觉兜底，产出带页码的笔记 | `pdf-reading` |
| 专业推导 | sympy 符号推导写成可重跑脚本 + pint 量纲 + uncertainties 误差传播 + 数值/极限/展开/文献交叉验证 + LaTeX 成文 | `derivation-lab` |

## 项目结构（v2）

`study_init` 建出的科研项目按功能分层，不再平铺十几个目录：

```
project/
├── codes/          # 可复用代码
├── knowledge/      # 调研 surveys/ · 文献 literature/ · 阶段报告 reports/ · 研究日志 logs/ · 发现 findings/
├── research/       # study.json · INDEX.md · loops/ · records/ · reviews/ · decisions/
├── data/           # raw/ interim/ processed/ external/ + manifest.tsv
├── experiments/    # E01/{design,config,run,logs,results} · derivations/<id>/
├── outputs/        # manuscript/ · figures/ · tables/ · submission/ · exports/
├── envs/           # 环境锁定
└── scratch/        # 临时（gitignore）
```

每个目录有 `README.md` 说明用途；根 `README.md` 是项目首页，`research/INDEX.md` 是自动生成的项目地图。
完整约定、边界规则与 v1→v2 迁移见 [docs/project-layout-v2.md](docs/project-layout-v2.md)。

## 工作区（先确认这一条）

所有命令与工具都以**会话工作区**为根（DSH `workingDirectory`，即新建会话时选定的目录），
**不再使用 `dsh` 进程的启动目录**；只有会话完全没有记录 cwd 时才退回启动目录。

- `/study-init`、`/survey-*` 等命令会把会话工作区切到解析出的项目根；之后 `write` / `bash` / `edit`
  与 `study_*` / `record_*` / `lit_*` 都落在同一处，不会再出现“命令建在 A、工具写到 B”。
- 需要显式指定项目：`/survey-scan "方向" --root /path/to/project`（命令会切到该目录）。
- 已有项目：在项目根（含 `research/study.json`）新建会话，或命令里给 `--root`。
- 检查当前目录：看系统提示里的 `Current working directory`；若当前组合提供 `working_directory` 工具，也可直接调用。终端里的 `pwd` 只反映启动目录，不代表会话工作区。
- 新建会话时没有选工作区，DSH 会沿用启动目录；这时请换工作区或显式给 `--root`。

## 文献链路（4 个原生工具）

取代了已移除的 paper-search-mcp：**57 个工具**（定义体量 35,560 字符 ≈ **9.4k tokens/请求**）→ 现在 **4 个工具**（约 2.4k 字符 ≈ 0.6k）。

| 工具 | 作用 |
|---|---|
| `lit_search` | 多源并发检索 + 去重，返回带 citekey 的表格与各源状态 |
| `lit_doi` | 按 DOI 取权威元数据（Crossref → Europe PMC） |
| `lit_bib` | 生成 BibTeX 并写入 `knowledge/literature/references.bib`（按 DOI 幂等） |
| `lit_pdf` | 取全文：arXiv → LibGen（仅 DOI 精确匹配） |

配套的**读 PDF** 工具（2 个）：

| 工具 | 作用 |
|---|---|
| `pdf_outline` | 页面画像：页数、目录、每页文本量/图片数、公式风险页、无文本层页 |
| `pdf_read` | 按页取内容：`markdown`（结构化）/ `text`（保留版式）/ `render`（PNG 供视觉读公式）/ `table`（表格抽取 + 可用性判定） |

**表格与图片的边界（实测）**：`markdown` 模式的图片只有占位符，要图用 `images:"extract"`（落盘 `.pdf-assets/`）或 `mode:"render"`；表格自动抽取在这类无框线多行表头的论文上**全部判为不可靠**，工具会拒绝输出并提示渲染看图，不会给错数据。

先 `pdf_outline` 判断怎么读，再 `pdf_read` 指定页范围——整本转换会瞬间吃掉几万字符上下文。

**当前接入的源**（2026-10 实测）：

| 源 | 状态 | 用途 |
|---|---|---|
| Crossref | ✅ | 检索 + DOI 权威元数据 |
| arXiv | ✅ | 预印本检索 + PDF 直取 |
| PubMed | ✅ | 生医检索 |
| Europe PMC | ✅ | 生医检索 + OA 全文 |
| LibGen（`libgen.li`） | ✅ | 有 DOI 论文的全文兜底 |

**未接入**（实测限流/缺凭证）：OpenAlex（429，retry 16 h）、Semantic Scholar（429 无 key）、
Unpaywall（422 需真实邮箱）、Anna's Archive / libgen.is（连接失败）。
**不含 sci-hub**（按用户决定）。

**文献库（工程化管理）**：`lit-lib` 把每篇文献落成 `knowledge/literature/notes/<citekey>.md` 的结构化记录
（受控关键词 + 命名空间标签 + 时间戳 + 引用数 + 评估分档），入库自动抓元数据、下 PDF、写 bib，
`lit-lib check` 做词表 ↔ bib ↔ PDF 三方校验。

命令行等价物：`lit search|doi|bib|pdf|doctor`、`lit-lib init|add|list|search|tag|set|stats|index|check`。

---

## 质量闭环（P0）

结论要能被验证，所以四件事都做成可执行检查，而不是"请注意"：

| 环节 | 机制 | 技能/工具 |
|---|---|---|
| 环境可复现 | conda/uv 环境固定 → `envs/*.lock.yml` → `record_save(env)` 记录环境哈希 | `conda-environments` |
| 数据可追溯 | `data/manifest.tsv`：来源、获取命令、sha256、许可、版本；大文件不进 git/工件 | `data-inventory` |
| 图可重跑 | `plot.py` + 矢量 PDF + 色盲友好 + caption 四要素；图是工件不是截图 | `figure-craft` |
| 图型选对 | 数据图 / 流程图（Mermaid 内联渲染）/ 关系图（Graphviz）/ 论文插图（TikZ）的选型与规范 | `diagram-craft` |
| 统计说得清 | 检验选型、假设检查、多重比较校正、bootstrap CI、效应量、多种子实验纪律 | `stats-and-inference` |
| 引用可校验 | `cite-check`：bib 必填字段、DOI↔Crossref/DataCite 元数据比对、正文引用与 bib 双向对应 | `scripts/cite-check.mjs` |

## 科研记录（12 个原生工具，替代 dsh-science 的 research_*/artifact_*）

研究状态 9 个 + 工件与运行 3 个，全部本地文件、无第三方依赖。设计依据见
[docs/research-record-plan.md](docs/research-record-plan.md)（对照 W3C PROV / RO-Crate、
Sandve 2013 可复现十条、Schnell 2015 计算实验记录本十条）。

| 工具 | 作用 |
|---|---|
| `study_init` / `study_state` | 建项目 / 全景：问题（含历史）、阶段、假设、实验、决策、评审、证据覆盖率、悬空引用、文献库覆盖 |
| `study_hypothesis` / `study_experiment` | 可证伪假设（可带 citekeys）/ 实验计划（步骤、预期、种子、环境） |
| `study_finding` / `study_phase` | 观察与结论（推进假设状态，`nextQuestion` 归档旧问题）/ 阶段推进（可退一级，须给原因） |
| `study_decision` | 决策日志：选了什么、否决了什么、为什么——纯结果记录答不出的部分 |
| `study_review` / `study_claim` | 评审归档 / 论断绑定证据（citekey + 工件） |
| `record_save` | 工件 + 运行：逐文件 SHA-256、命令、退出码、耗时、种子、环境、输入输出、关联 |
| `record_verify` / `record_reproduce` | 校验（含多余文件、环境漂移、种子缺失、图↔raw↔脚本三向追溯）/ 复现指引（输入逐个回查哈希） |

**相对 dsh-science 的实质改进**：记录执行成败与耗时（PROV `actionStatus`）、随机种子（Sandve R6）、
图的原始数据（R7）、假设↔文献、论断↔证据（R9）；换迭代时旧问题归档而非覆盖；历史溢出转 JSONL；
`verify` 检出目录里多出来的文件；`diff` 给行级统计。

配套 CLI（不占模型上下文）：`vault index | list | show | diff | deprecate | prune | export`；
`cite-check --deep` 做全链校验（无文献支撑的假设、无证据的论断、悬空引用）。

装到 PATH（一次装四个命令，之后可在任意项目目录直接调用）：

```bash
bash scripts/install-cli.sh          # → ~/.local/bin/{lit,lit-lib,cite-check,vault}
```

> 总纲文档：[docs/plugin-development-plan.md](docs/plugin-development-plan.md)（目标 / 功能 / 边界 / 命名 / 角色分工 / 工具与技能 / 交互 / 科研流程 / 路线图）

## 斜杠命令（约定 loop）

输入框里敲 `/` 可见。命令把**入口契约**与**出口契约**用代码钉死，中段交给模型；
不敲命令时完全不介入，按对话自由推进。

调研采用**分阶段漏斗**，一次只做一个阶段：

| 命令 | 阶段 | 产物 / 出口 |
|---|---|---|
| `/survey [主题]` | 调研状态页 | 只读；`--next` 执行下一阶段 |
| `/survey-scan <主题>` | 1/5 定框 + 网络调研 | `scope.md` + `sources.md`（≥8 个 URL） |
| `/survey-scholar <主题>` | 2/5 学术检索 | `queries.md` + `candidates.md`（≥12 个 citekey） |
| `/survey-map <主题>` | 3/5 流派/时间线/gap | `landscape.md`（≥5 引用 + 对比表 + gap） |
| `/survey-papers <主题>` | 4/5 论文总述 | `papers.md`（≥10 篇 + 纳入/排除 + 深读队列） |
| `/survey-report <主题>` | 5/5 综合报告 | `report.md`（≥5 引用 + gap + 不确定性） |
| `/paper <DOI\|id\|标题>` | 单篇精读 | 笔记 + bib + 核心主张/方法要点/局限 |
| `/derive <命题>` | 推导/论证 | derive.py 可执行 + validation.md |
| `/write [目标\|§N]` | 成文 / 按章节 | 目标文件 + `cite-check --deep` |
| `/review [对象]` | 评审 | study.json 新增 review |
| `/status [id]` | 进度 / 接手 | 只读；`--brief` `--abort` `--json` |
| `/study-init [标题] --question "…"` | 建/更新项目 | study.json |

调研阶段严格按 `scan → scholar → map → papers → report` 推进，状态落在
`knowledge/surveys/<slug>/survey.json`；`--force` 可跳过前序（标 `skipped`，状态页会提示证据链不完整）。
`papers` 只产出深读队列，单篇用 `/paper <citekey>` 精读。

强制层只在 loop 激活期生效：每步提醒缺项、未完成阻止收尾（默认 2–3 次，`/derive` 5 次）、
禁止直接改 `research/loops/**`。终态：`closed` / `failed`（须给原因）/ `stalled` / `aborted`。
设计见 [docs/command-loops-plan.md](docs/command-loops-plan.md)。

## 安装（bundle 包，一条命令）

```bash
# 本地源码（符号链接：改源码即时可见，但重新组合需要重启）
dsh plugin --profile web add link:~/workspaces/deepseek-harness/scientist-preset

# 或从 npm / git 安装
dsh plugin --profile web add dsh-scientist
```

装完**重启 dsh web 进程**（bundle 在启动时组合），新建会话的模式选择器里出现「科学家模式」。

```bash
# 卸载
dsh plugin --profile web remove dsh-scientist
```

### 为什么是 bundle 而不是 preset 目录

本部署的 web profile 只挂载了 `@deepseek-ai/dsh-agent-preset-registry`（读**组合里声明**的
preset 行），**没有**挂载 `@deepseek-ai/dsh-agent-presets`（扫 `~/.dsh/.agent-presets/` 的
目录发现服务）。所以放在目录里的 preset 永远不会出现在选择器中。

本包的做法与 web-app 的 `standard` 完全同机制：`cordis.patch.yml` 里插一行
`@deepseek-ai/dsh-agent-preset`，`config.plugins` 就是 `agent.cordis.yml` 的行。

### 改了之后怎么生效

```bash
node scripts/build-patch.mjs    # agent.cordis.yml → cordis.patch.yml
# 然后重启 dsh web 进程
```

技能是热加载的（provider 每次 `list()` 重新读盘），但 `plugins` 行变了需要重新组合。

## 依赖

| 依赖 | 说明 |
|---|---|
| 无外部 bundle 依赖 | 文献、PDF、科研记录全部是本包原生工具；不再需要 `dsh-science`。 |
| Node ≥22.19 | 文献工具用内置 `fetch`，**无额外运行时依赖**（原 paper-search-mcp 的 uv/uvx/Python 已不再需要）。 |
| Python ≥3.10 + sympy/numpy/scipy/matplotlib/pandas | 推导与数值验证（本机已有）。 |
| `pint` 0.24.4 + `uncertainties` 3.2.3 | 量纲与误差传播（本机已装）。 |
| `conda`（可选） | 项目环境固定；本机已有 base / atom_calculations / costudio / pytorch。 |
| `pdflatex`（可选） | 推导成文编译 PDF。 |

可选环境变量（供 MCP）：

```bash
export PAPER_SEARCH_MCP_UNPAYWALL_EMAIL="you@example.com"      # OA 全文 DOI 查询需要
export PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY="..."          # 无 key 会 429 限流
export PAPER_SEARCH_MCP_CORE_API_KEY="..."
export PAPER_SEARCH_MCP_GOOGLE_SCHOLAR_PROXY_URL="http://..."   # 绕 Google Scholar 拦截
```

## 目录结构

> 下面是**插件包自身**的文件；`study_init` 建出的**科研项目**结构见
> [docs/project-layout-v2.md](docs/project-layout-v2.md)（codes / knowledge / research / data / experiments / outputs / envs / scratch）。

```
scientist/
  package.json        包声明：dsh.bundle.patch + exports
  cordis.patch.yml    bundle patch（由 build-patch.mjs 从 agent.cordis.yml 生成）
  skills-provider.mjs 零依赖技能 provider（用 import.meta.url 定位 skills/）
  lit-core.mjs        文献核心：源适配器 / 去重 / 缓存 / 退避 / BibTeX / LibGen / PDF 校验
  lit-tools.mjs       4 个文献工具（lit_search / lit_doi / lit_bib / lit_pdf）
  pdf-tools.mjs       2 个 PDF 工具（pdf_outline / pdf_read）
  project-layout.mjs  项目目录布局 v2（路径唯一来源 + v1 兼容 + 迁移辅助）
  vault-core.mjs      共享底座：文件锁 / 原子写 / 流式哈希 / 硬链接去重 / 忽略遍历
  vault-record.mjs    3 个工件与运行工具（record_save / record_verify / record_reproduce）
  vault-study.mjs     9 个研究状态工具（study_init … study_claim）
  preset.yml          目录发现形态的元数据（本部署不用，保留兼容）
  agent.cordis.yml    agent 平面组合：人格 + 工具面 + 技能 provider + 文献 MCP
  skills/             15 个技能
    domain-survey/            自建：领域调研
    literature-retrieval/     自建：文献检索与精读
    pdf-reading/              自建：PDF 阅读（pymupdf4llm / pdftotext / pdfplumber / 渲染+视觉）
    derivation-lab/           自建：专业推导（含 pint/uncertainties）
    figure-craft/             自建：数据图规范
    diagram-craft/            自建：示意图/流程图选型（Mermaid/Graphviz/TikZ）
    stats-and-inference/      自建：统计检验与报告规范
    conda-environments/       改写自 dsh-science：环境固定与 record_save(env)
    data-inventory/           改写自 dsh-science：数据清单
    research-loop/            复制自 dsh-science：ReAct 循环
    science-project-setup/    复制自 dsh-science：项目初始化
    artifact-provenance/      复制自 dsh-science：工件与溯源
    scientific-reviewer/      复制自 dsh-science：评审
    parallel-delegation/      复制自 dsh-science：并行分轨
    remote-compute/           复制自 dsh-science：远程计算
  scripts/
    build-patch.mjs   从 agent.cordis.yml 生成 cordis.patch.yml
    lit.mjs           文献 CLI（search/doi/bib/pdf/doctor）
    lit-lib.mjs       文献库 CLI（add/list/search/tag/set/stats/index/check）
    taxonomy.template.yml  受控词表模板（关键词 + 标签命名空间）
    pdf-extract.py    pdf_read/pdf_outline 的 Python 后端（PyMuPDF / pymupdf4llm）
    test-pdf-tools.mjs  PDF 工具测试（现场生成样例 PDF，离线）
    test-lit-core.mjs   lit-core 离线单测
    test-lit-tools.mjs  工具结构测试（--live 走联网）
    install-cli.sh    把 lit / lit-lib / cite-check / vault 链到 PATH
    verify.sh         一键验收（结构 + loader + roster + cite-check + MCP）
    validate.py       结构校验
    check-loader.mjs  用真实 entryListSchema 解析组合
    check-roster.mjs  校验 ~/.dsh/.agent-presets 下所有 preset 可解析
    lit.mjs           文献 CLI（search / doi / bib / pdf / doctor）
    cite-check.mjs    参考文献闭环校验（零依赖，Crossref/DataCite）
    test-cite-check.sh cite-check 自测
  README.md
```

## 工具面

保留：`bash`/`pwsh`、文件读写与搜索、后台作业、技能、`todo`、`goal`、计划模式、
压缩与结果裁剪、子代理（`subagent`/`subagent_fork`）与 `workflow`、`ask_user_question`、
`web`（含 `web_fetch`）、`present`、时间上下文、`lit_*` 文献工具 ×4、`pdf_*` ×2。

刻意不含：`schedule`、`plugin-manager`、`plugin-market`。

## 验收

```bash
bash scripts/verify.sh              # 全部检查
bash scripts/verify.sh               # 离线检查；加 --live 跑联网实测
```

交付时已通过：

| 检查 | 结果 |
|---|---|
| 结构（27 个顶层插件行、15 个技能 frontmatter、preset.yml） | 通过 |
| loader 方言（真实 `entryListSchema` + 2 个 `!!js` 求值） | 通过 |
| bundle patch 与源组合一致 / 注册正确 | 通过 |
| skills-provider 单测（frontmatter + 15 候选 + 正文加载） | 通过 |
| cite-check 自测（悬空 citekey、缺失字段） | 通过 |
| lit 4 个工具结构 + 离线单测 | 通过 |
| 约定 loop / 12 命令 / 分阶段调研 / 强制层（状态机、出口校验、拦停、guard） | 通过 |
| lit 联网实测（`--live`） | 通过：lit_doi / lit_search / lit_bib / lit_pdf(arXiv) / lit_pdf(LibGen) |

真正挂载进会话需要重启 dsh web 进程。重启后新建会话 → 选「科学家模式」→
问「你有哪些文献检索工具」确认出现 4 个 `lit_*` 工具。

## 定制

- **改人格**：`agent.cordis.yml` 的 `persona.config.text`（对新会话生效）。
- **加技能**：往 `skills/` 放目录，frontmatter 需 `name` + `description`。
- **加 MCP**：`agent.cordis.yml` 末尾追加 `@deepseek-ai/dsh-mcp-client` 行。
- **同步 dsh-science 技能**：`cp -a ~/.dsh/profiles/web/node_modules/dsh-science/skills/{...} skills/`

## 已知限制

- 六个复制来的技能是**快照**，dsh-science 升级后需手动重新复制。
- 文献源只接了 5 个（Crossref / arXiv / PubMed / Europe PMC / LibGen）；其余见 `lit-core.mjs` 顶部 TODO。
- `mcp<2` 是**临时 pin**，上游修好 FastMCP 迁移后应去掉。
- Google Scholar 源易被拦截、Semantic Scholar 无 key 会 429——上游行为。
- `cite-check` 的 DOI 核对只覆盖 Crossref/DataCite 可查的 DOI；arXiv 走 DataCite（`10.48550/*`），无 DOI 的条目只做字段与引用一致性检查。
- 文献源只接了 5 个：OpenAlex / Semantic Scholar / Unpaywall 因限流或缺少邮箱未实现（`lit-core.mjs` 顶部留有 TODO，恢复后每个约 40 行适配器）。
- **不含 sci-hub**；LibGen 仅支持 DOI 精确匹配（实测标题搜索会返回同名不同论文）。
- **分阶段调研需要 v2 项目**：v1 旧项目只识别 `report.md`（legacy），补阶段前先 `vault migrate --to v2`。
- 旧版只有 `report.md`、没有 `survey.json` 的项目会显示 `legacy`：前四阶段 `skipped`、`report` `done`；补阶段用 `--force`。
- 阶段门槛是固定默认值（scan 8 个 URL / scholar 12 个候选 / papers 10 篇 / map、report 各 5 个引用）；
  冷门领域可 `--force` 跳过前序，但当前不提供 `--min-*` 调节。
- `papers` 只产出深读队列；单篇精读需逐个 `/paper <citekey>`，不自动批量读全文。
- **本机部署未挂载 `@deepseek-ai/dsh-agent-presets`**（目录发现），所以必须走 bundle 安装；`~/.dsh/.agent-presets/` 里的目录不会生效。
- `link:` 安装绑绝对路径，换机器要重装；发布到 npm 可解决。
- bundle 组合在启动时完成：改 `agent.cordis.yml` 后要 `build-patch.mjs` + 重启，不像 profile patch 能热应用。
