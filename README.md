# 科学家模式（scientist）— 通用科研 agent preset

面向 **数理 / 物理·工程·材料 / AI·计算科学** 的跨学科科研 agent。

## 三根支柱

| 支柱 | 能力 | 技能 |
|---|---|---|
| 领域调研 | 把方向测绘成可决策的地图：流派、时间线、方法对比、gap 判定、最小切入点 | `domain-survey` |
| 文献检索 | 4 个原生工具：`lit_search`（多源检索）/ `lit_doi`（DOI 元数据）/ `lit_bib`（生成 BibTeX）/ `lit_pdf`（取全文） | `literature-retrieval` |
| 读 PDF | 页面画像 → 结构化 md / 纯文本 / 表格 / 渲染成图四路并用，公式与图表视觉兜底，产出带页码的笔记 | `pdf-reading` |
| 专业推导 | sympy 符号推导写成可重跑脚本 + pint 量纲 + uncertainties 误差传播 + 数值/极限/展开/文献交叉验证 + LaTeX 成文 | `derivation-lab` |

## 文献链路（4 个原生工具）

取代了已移除的 paper-search-mcp：**57 个工具**（定义体量 35,560 字符 ≈ **9.4k tokens/请求**）→ 现在 **4 个工具**（约 2.4k 字符 ≈ 0.6k）。

| 工具 | 作用 |
|---|---|
| `lit_search` | 多源并发检索 + 去重，返回带 citekey 的表格与各源状态 |
| `lit_doi` | 按 DOI 取权威元数据（Crossref → Europe PMC） |
| `lit_bib` | 生成 BibTeX 并写入 `literature/references.bib`（按 DOI 幂等） |
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

**文献库（工程化管理）**：`lit-lib` 把每篇文献落成 `literature/notes/<citekey>.md` 的结构化记录
（受控关键词 + 命名空间标签 + 时间戳 + 引用数 + 评估分档），入库自动抓元数据、下 PDF、写 bib，
`lit-lib check` 做词表 ↔ bib ↔ PDF 三方校验。

命令行等价物：`lit search|doi|bib|pdf|doctor`、`lit-lib init|add|list|search|tag|set|stats|index|check`。

---

## 质量闭环（P0）

结论要能被验证，所以四件事都做成可执行检查，而不是"请注意"：

| 环节 | 机制 | 技能/工具 |
|---|---|---|
| 环境可复现 | conda/uv 环境固定 → `envs/*.lock.yml` → `artifact_save(envFile)` 记录环境哈希 | `conda-environments` |
| 数据可追溯 | `data/manifest.tsv`：来源、获取命令、sha256、许可、版本；大文件不进 git/工件 | `data-inventory` |
| 图可重跑 | `plot.py` + 矢量 PDF + 色盲友好 + caption 四要素；图是工件不是截图 | `figure-craft` |
| 图型选对 | 数据图 / 流程图（Mermaid 内联渲染）/ 关系图（Graphviz）/ 论文插图（TikZ）的选型与规范 | `diagram-craft` |
| 统计说得清 | 检验选型、假设检查、多重比较校正、bootstrap CI、效应量、多种子实验纪律 | `stats-and-inference` |
| 引用可校验 | `cite-check`：bib 必填字段、DOI↔Crossref/DataCite 元数据比对、正文引用与 bib 双向对应 | `scripts/cite-check.mjs` |

## 底座（复用 dsh-science，不重复挂载）

profile 层全局挂载的三个引擎：

- `research_*` —— ReAct 研究循环（提问 → 假设 → 实验 → 观察 → 分析 → 结论 → 迭代），状态在 `research-manifest.json`
- `artifact_*` —— 版本化工件 + 溯源（`artifacts/<name>/v<N>/`、SHA-256、`provenance.md`、可复现）
- `remote_*` —— SSH / SLURM 远程计算（长跑仿真、GPU、集群）

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
| `dsh-science` bundle | 提供 `research_*` / `artifact_*` / `remote_*`。从 profile 移除后本 preset 会失去这三组工具。 |
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

```
scientist/
  package.json        包声明：dsh.bundle.patch + exports
  cordis.patch.yml    bundle patch（由 build-patch.mjs 从 agent.cordis.yml 生成）
  skills-provider.mjs 零依赖技能 provider（用 import.meta.url 定位 skills/）
  lit-core.mjs        文献核心：源适配器 / 去重 / 缓存 / 退避 / BibTeX / LibGen / PDF 校验
  lit-tools.mjs       4 个文献工具（lit_search / lit_doi / lit_bib / lit_pdf）
  pdf-tools.mjs       2 个 PDF 工具（pdf_outline / pdf_read）
  preset.yml          目录发现形态的元数据（本部署不用，保留兼容）
  agent.cordis.yml    agent 平面组合：人格 + 工具面 + 技能 provider + 文献 MCP
  skills/             16 个技能
    domain-survey/            自建：领域调研
    literature-retrieval/     自建：文献检索与精读
    pdf-reading/              自建：PDF 阅读（pymupdf4llm / pdftotext / pdfplumber / 渲染+视觉）
    derivation-lab/           自建：专业推导（含 pint/uncertainties）
    figure-craft/             自建：数据图规范
    diagram-craft/            自建：示意图/流程图选型（Mermaid/Graphviz/TikZ）
    stats-and-inference/      自建：统计检验与报告规范
    conda-environments/       改写自 dsh-science：环境固定与 envFile
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
    install-cli.sh    把 cite-check 链到 PATH
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
bash scripts/verify.sh --offline    # 跳过需要网络的 MCP 探测
```

交付时已通过：

| 检查 | 结果 |
|---|---|
| 结构（21 个顶层插件行、16 个技能 frontmatter、preset.yml） | 通过 |
| loader 方言（真实 `entryListSchema` + 7 个 `!!js` 求值） | 通过 |
| bundle patch 与源组合一致 / 注册正确 | 通过 |
| skills-provider 单测（frontmatter + 15 候选 + 正文加载） | 通过 |
| cite-check 自测（悬空 citekey、缺失字段） | 通过 |
| lit 4 个工具结构 + 离线单测 | 通过 |
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
- **本机部署未挂载 `@deepseek-ai/dsh-agent-presets`**（目录发现），所以必须走 bundle 安装；`~/.dsh/.agent-presets/` 里的目录不会生效。
- `link:` 安装绑绝对路径，换机器要重装；发布到 npm 可解决。
- bundle 组合在启动时完成：改 `agent.cordis.yml` 后要 `build-patch.mjs` + 重启，不像 profile patch 能热应用。
