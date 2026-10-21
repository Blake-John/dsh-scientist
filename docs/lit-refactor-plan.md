> 注：本文中的路径是 v1 布局；项目结构 v2（knowledge/surveys、experiments/derivations 等）以 [project-layout-v2.md](project-layout-v2.md) 为准。

# 文献检索改造方案：57 个 MCP 工具 → 4 个原生工具

> 状态：**已实施（2026-10-20）**；sci-hub 一级按用户决定未实现；**paper-search-mcp 已从插件中彻底移除**（非仅禁用）。实施差异见文末。
> 日期：2026-10-20
> 适用包：`dsh-scientist`（科学家模式）

## 1. 决策依据（实测）

| 项目 | 实测值 |
|---|---|
| paper-search-mcp 工具数 | 57 |
| 工具定义总字符 | 35,560（`name` + `description` + `inputSchema`） |
| **≈ tokens / 请求** | **9,358** |
| 单工具均值 | 624 字符（最贵：`download_with_fallback` 1,344、`search_crossref` 1,315） |
| 常驻进程 | 1 个 Python MCP（`uvx`，首次拉 88 个包，约 20 s） |
| 后端可用性实测 | Crossref ✅ 200；arXiv ✅ 200（约 9 s，慢）；**OpenAlex ❌ 429（retry-after ≈ 16 h）**；Semantic Scholar ❌ 429（无 key）；Unpaywall ❌ 422（`example.com` 被拒） |

结论：57 个工具里**真正会用到的能力只有 5 类**（多源检索、DOI 元数据、bib 生成、OA 全文、PDF 抽文本），其余 90% 是常驻成本。而 `dsh-mcp-client` **没有工具白名单**（配置项只有 transport/timeout/reconnect），因此"只暴露 5 个工具"这条路在 MCP 上走不通——必须换成原生工具或 CLI。

## 2. 现状处置表（57 → 4）

### 2.1 检索类（19 个 `search_*`）

| 原工具 | 处置 | 替代 |
|---|---|---|
| `search_papers` | 删除 | `lit_search`（统一入口） |
| `search_arxiv` | 删除 | `lit_search(sources:["arxiv"])` |
| `search_crossref` | 删除 | `lit_search(sources:["crossref"])` |
| `search_openalex` | 删除 | `lit_search(sources:["openalex"])`（受限流影响，自动降级） |
| `search_semantic` | 删除 | `lit_search(sources:["semantic"])`（需 key，默认不启用） |
| `search_pubmed` | 删除 | `lit_search(sources:["pubmed"])`（可选源，无 key 3 req/s） |
| `search_pmc` / `search_europepmc` | 删除 | **内化到 `lit_pdf`**（PMC 是获取全文的路径，不是检索路径） |
| `search_biorxiv` / `search_medrxiv` | 删除 | 由 Crossref/OpenAlex 的预印本记录覆盖 |
| `search_google_scholar` | 删除 | 实测被机器人拦截，不可靠 |
| `search_iacr` | 删除 | 领域过窄 |
| `search_dblp` | 删除 | CS 会议可由 Crossref/OpenAlex 覆盖；需要时加 core 适配器 |
| `search_openaire` / `search_core` / `search_base` / `search_citeseerx` / `search_doaj` / `search_hal` / `search_ssrn` | 删除 | 聚合器/窄库，命中率与元数据质量都不如主源 |
| `search_unpaywall` | 删除 | **内化到 `lit_pdf`**（它是 OA 解析，不是检索） |
| `search_zenodo` | 删除 | 数据集检索，属 `data-inventory` 范畴，不混进文献链 |

### 2.2 下载类（17 个 `download_*`）

| 原工具 | 处置 | 替代 |
|---|---|---|
| `download_with_fallback` | 删除 | **`lit_pdf`**（统一解析链） |
| `download_arxiv` | 删除 | `lit_pdf(arxiv_id)` |
| `download_pubmed` / `download_biorxiv` / `download_medrxiv` / `download_iacr` / `download_semantic` / `download_crossref` / `download_dblp` / `download_openaire` / `download_citeseerx` / `download_doaj` / `download_base` / `download_zenodo` / `download_hal` / `download_ssrn` / `download_openalex` | 删除 | 由 `lit_pdf` 的解析链统一处理（arXiv → PMC → Unpaywall → OpenAlex → Crossref link） |
| `download_scihub` | 删除 | 改为 `lit_pdf` 的 `shadow` 参数：`off`/`fallback`（默认）/`force`。默认仅在 OA 全失败时尝试；结果用 `shadow_used` 显式标记（合规责任由使用者承担） |

### 2.3 读取类（16 个 `read_*_paper`）

| 原工具 | 处置 | 替代 |
|---|---|---|
| `read_arxiv_paper`、`read_pubmed_paper`、`read_biorxiv_paper`、`read_medrxiv_paper`、`read_iacr_paper`、`read_semantic_paper`、`read_crossref_paper`、`read_dblp_paper`、`read_openaire_paper`、`read_citeseerx_paper`、`read_doaj_paper`、`read_base_paper`、`read_zenodo_paper`、`read_hal_paper`、`read_ssrn_paper`、`read_openalex_paper` | **全部删除** | `lit_pdf` 拿文件 + `pdf-reading` 技能：`pymupdf4llm`（结构化 md）/ `pdfplumber`（表格）/ `pdftoppm` + 视觉（公式、扫描件） |

理由：MCP 用 `pypdf` 抽文本，公式/双栏/表格会烂；本地 `pymupdf4llm` 实测 0.53 s 转 2 页且保留标题结构，质量高一个档次，还能按需渲染公式页。

### 2.4 元数据（1 个）

| 原工具 | 处置 | 替代 |
|---|---|---|
| `get_crossref_paper_by_doi` | 删除 | `lit_doi`（Crossref 权威 → OpenAlex 补 OA/引用数） |

**合计：删除 57 个，新增 4 个。**

## 3. 新增工具详细设计

### 3.1 `lit_search` —— 多源文献检索

```
lit_search(
  query:    string                        # 必填；支持布尔与字段限定透传
  sources?: ("crossref"|"arxiv"|"openalex"|"semantic"|"pubmed")[]
                                          # 默认 ["crossref","arxiv"]
  limit?:   number                        # 默认 20，上限 50
  since?:   number                        # 起始年份（含）
  sort?:    "relevance"|"cited"|"date"    # 默认 relevance
)
```

**返回**（Markdown 表 + 状态行，而非 JSON）：

```
找到 18 条（crossref ✓ 20 / arxiv ✓ 8 / openalex ✗ 429，16h 后重试）

| # | citekey              | 年 | 被引 | 标题                                  | DOI / arXiv |
|---|----------------------|----|------|---------------------------------------|-------------|
| 1 | vaswani2017attention | 2017 | 12k | Attention Is All You Need            | 10.48550/arXiv.1706.03762 |
| … |

下一步：lit_bib <doi> 写入书目；lit_pdf <doi> 取全文；lit_doi <doi> 核对元数据
```

**内部逻辑**：
1. 并发请求各源（`Promise.allSettled`，**单源失败不影响整体**）
2. 归一化为统一记录 `{doi, arxivId, title, authors[], year, venue, citations, abstract?}`
3. 去重：DOI 精确匹配 → 标题归一化（小写、去标点、压空白）+ 年份 ±1
4. 排序、截断；citekey 预生成（与 `lit_bib` 一致，便于提前引用）
5. 缓存：`sha1(query+sources+limit+since+sort)`，TTL 24 h，落 `.lit-cache/search/`
6. 退避：遇 429 读 `Retry-After` 写入 `.lit-cache/backoff.json`，后续请求**跳过该源并明说**

**失败模式**：`no_results`（各源均 0 命中）/ `rate_limited`（全源 429，附 retry 时间）/ `bad_query`。
**为什么不返回 JSON**：省上下文；CLI 里 `--json` 给脚本用，模型走表格。

### 3.2 `lit_doi` —— DOI 元数据核对

```
lit_doi(doi: string, refresh?: boolean)
```

**返回**：`{ title, authors[], year, venue, type, doi, arxivId?, license?, oaUrl?, citations? }`

**内部**：Crossref（DOI 注册机构，权威）→ OpenAlex（补 OA 位置、引用数、主题）→ 合并；`refresh` 跳过缓存。
**用途**：给 `cite-check` 提供权威元数据；补全 bib 缺失字段；判断这篇有没有 OA。

**失败模式**：`not_found`（DOI 不存在）/ `rate_limited`。

### 3.3 `lit_bib` —— 生成书目条目（新增能力）

```
lit_bib(
  doi?:       string
  arxiv_id?:  string                      # 二者之一
  citekey?:   string                      # 可选自定义
  append?:    boolean = true              # 默认写入 literature/references.bib
)
```

**返回**：`{ citekey, entry, added: boolean, problems?: string[] }`

**内部**：
1. 取元数据（复用 `lit_doi`）
2. **citekey 生成**：`<首作者姓><年><标题首实词>`（小写无标点），冲突加 `a/b` 后缀；仅 arXiv 时用 `arxiv<id>`
3. **条目类型判定**：有 `journal` → `@article`；有 `booktitle` → `@inproceedings`；否则 `@misc`（含 `eprint`/`url`）
4. **字段完整度检查**：缺 `author`/`title`/`year` → 返回 `problems`，并在条目里写 `% TODO: 缺 author`（不静默补假数据）
5. **幂等写入**：按 DOI 匹配已有条目 → 更新字段而非重复追加；文件不存在则创建并加头注释

**为什么这是关键**：目前 `references.bib` 靠手写，`cite-check` 只能查错不能生成。补上这一环，文献链路才闭环。

**失败模式**：`not_found`；元数据不全 → 成功但带 `problems`。

### 3.4 `lit_pdf` —— 取全文（OA 优先，sci-hub 兜底）

```
lit_pdf(
  doi?:           string
  arxiv_id?:      string                  # 二者之一
  out_dir?:       string = "data/papers"
  shadow?:        "off"|"fallback"|"force"  # 默认 fallback（OA 全失败才试影子库）
  adopt?:         string                  # 手动登记一个已下载的 PDF 路径
)
```

**返回**：`{ path, pages, source, sha256, license?, citekey, shadow_used?: true }`

#### 解析链（依次尝试，记录命中源）

| 顺序 | 来源 | 触发条件 | 实测状态 |
|---|---|---|---|
| 1 | arXiv PDF | 有 `arxiv_id` 或元数据给出 | ✅ 可用（约 9 s/篇） |
| 2 | Europe PMC OA | 有 PMID/PMCID | ✅ 可用 |
| 3 | Unpaywall | 有 DOI + 配置 `LIT_MAILTO` | ⚠️ 需真实邮箱（示例邮箱被 422） |
| 4 | OpenAlex `best_oa_location` | 有 DOI | ⚠️ 当前 429（retry-after 16 h） |
| 5 | Crossref `link`（license/resource） | 有 DOI | ✅ 可用 |
| 6 | **sci-hub（影子库）** | `shadow != "off"` | ❌ **当前不可用**，见下 |

#### sci-hub 源的三级降级（实测依据）

| 镜像 | 纯 HTTP | 无头 Chrome（`--dump-dom`, 20 s） |
|---|---|---|
| `sci-hub.ru` | 200，但返回 `проверка на робота` 机器人校验页 | 仍是校验页，无 `embed`/`.pdf` |
| `sci-hub.wf` | 200 | Chrome 内是网络错误页（`IDR_ERROR_NETWORK_GENERIC`） |
| `sci-hub.st` / `.ee` | 403 | — |
| `sci-hub.se` | 不可达（000） | — |

结论：**所有镜像都上了 JS/机器人校验或不可达**，纯 fetch 与无头浏览器都拿不到 PDF 直链。因此适配器实现为：

```
Tier A  纯 fetch 落地页 → 正则提取 <embed>/<iframe>/location.href 里的 PDF 直链
        （镜像未校验时有效；当前全部失败）
Tier B  无头 Chrome（~/.cache/ms-playwright/.../chrome --dump-dom --virtual-time-budget）
        → 过 JS 校验后再提取（校验会拦，当前失败）
Tier C  都失败 → 返回 shadow_blocked，附 DOI 链接 + 手动操作指引
```

**Tier C 不是死路**：配合 `adopt` 参数完成闭环——

```
lit_pdf(doi: "10.1038/nature14539")            → shadow_blocked + 链接
（用户在浏览器里打开该链接，下载到 ~/Downloads/xxx.pdf）
lit_pdf(adopt: "~/Downloads/xxx.pdf", doi: "10.1038/nature14539")
  → 校验 PDF、按 citekey 重命名、登记 manifest，返回正常结果
```

**为什么不做「模拟点击过验证」**：那是绕过访问控制的自动化，且镜像随时变更，维护成本高、成功率不可预期。Tier C 把最后一步交给人，工具负责校验与登记，链路仍然闭环。

#### 下载后处理

- 校验 magic bytes `%PDF` + `pdfinfo` 页数（防 HTML 错误页伪装）
- 命名 `<citekey>.pdf`（与 bib 的 key 对齐）
- 原子重命名（tmp → rename）
- 登记 `data/manifest.tsv`：`id / type=paper / source / command / sha256 / size / license / shadow_used / date`

#### 边界

只负责拿到文件，**不解析正文**——解析是无副作用的纯本地操作，交给 `pdf-reading`，两者可独立重跑。

#### 失败模式

`no_oa_fulltext`（无 OA 且 shadow 关闭）/ `shadow_blocked`（校验拦截，附链接）/ `not_found` / `rate_limited` / `not_a_pdf`（下载内容不是 PDF）。

## 4. 模块结构

```
scientist-preset/
├── lit-core.mjs        ~400 行  纯函数层：源适配器、归一化、去重、缓存、退避、
│                                citekey/BibTeX、下载解析链、manifest 登记
├── lit-tools.mjs       ~120 行  插件层：ctx.tools.register × 4（参数校验 + 输出格式化）
└── scripts/lit.mjs     ~80 行   CLI 薄壳：lit search|doi|bib|pdf（单测与手工用）
```

三层分离的理由：core 可**不依赖 harness 单测**（注入 fake fetch），CLI 可脱离 DSH 使用，工具层只做胶水。

**preset 改动**：
```yaml
- id: lit-tools
  name: 'dsh-scientist/lit-tools.mjs'

- id: mcp-paper-search          # 保留但默认禁用，一行改回
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config: { ... }
```

**配置**（环境变量）：`LIT_MAILTO`（Unpaywall/OpenAlex 礼貌池，**必须真实邮箱**）、`LIT_S2_KEY`、`LIT_CACHE_TTL`、`LIT_SHADOW_MODE`（`off`/`fallback`/`force`，默认 `fallback`）。

## 5. 成本对比

| 维度 | 现状 | 改造后 |
|---|---|---|
| 工具数 | 57 | **4** |
| 定义字符 | 35,560 | ≈ 2,400（估） |
| tokens / 请求 | **≈ 9,358** | **≈ 630** |
| 常驻进程 | 1 个 Python MCP | 0（纯 JS，随 harness） |
| 首次启动 | 拉 88 个包 ≈ 20 s | 0 |
| BibTeX 生成 | ❌ 无 | ✅ `lit_bib` |
| PDF 抽文本 | pypdf（公式/表格会烂） | pymupdf4llm / pdfplumber / 视觉 |
| 限流处理 | 各工具各自为战 | core 统一退避 + 源状态回显 |

## 6. 技能文档改动

| 技能 | 改动 |
|---|---|
| `literature-retrieval` | `search_papers` → `lit_search`；`download_with_fallback` → `lit_pdf`；新增 `lit_bib` 生成书目的步骤；检索式记录里加"各源状态" |
| `pdf-reading` | 去掉对 MCP `read_*_paper` 的依赖，改为 `lit_pdf` 取文件 → `pymupdf4llm`；保留渲染与表格核对 |
| `domain-survey` | 检索工具名替换；源选择建议更新（默认 crossref+arxiv，OpenAlex 可用时再开） |
| `cite-check`（脚本） | 增加 `--from-bib` 往返校验：`lit_bib` 生成的条目必须能通过 `cite-check` |

## 7. 实施步骤

| # | 步骤 | 产出 | 验证 |
|---|---|---|---|
| 1 | 写 `lit-core.mjs` + 离线单测 | 源适配器、去重、bibtex、缓存 | 注入 fake fetch 的单测全绿 |
| 2 | 写 `lit-tools.mjs` | 4 个工具注册 | `node -e` 用假 ctx 捕获注册 |
| 3 | 写 `scripts/lit.mjs` | CLI 薄壳 | `lit --help` / 离线缓存命中 |
| 4 | 改 preset：加 `lit-tools` 行，MCP 改 `disabled: true` | `agent.cordis.yml` | `build-patch` + `check-patch` |
| 5 | 更新 3 个技能文档 | skills/* | `validate.py` frontmatter 校验 |
| 6 | 扩展 `verify.sh` | `lit` 自测 | 全绿 |
| 7 | 重启后实机验证 | — | 问"你有哪些文献工具" → 应见 4 个 `lit_*`，且**无** `mcp__paper-search__*` |

**回滚**：删掉 `lit-tools` 行、去掉 MCP 的 `disabled: true` → `build-patch` → 重启。一分钟。

## 8. 风险与未决项

| 风险 | 说明 | 缓解 |
|---|---|---|
| **覆盖面变窄** | 20+ 源 → 默认 2 个源（crossref、arxiv） | 核心期刊与预印本覆盖住了；bioRxiv/medRxiv 由 Crossref 预印本类型覆盖；需要时在 core 加适配器（约 40 行/源） |
| **OpenAlex 限流** | 实测 429，`retry-after` 16 h | 默认不依赖它；可用时自动启用，失败静默降级 |
| **Unpaywall 需真实邮箱** | `example.com` 被 422 拒 | 未配置 `LIT_MAILTO` 时跳过该源，不报错 |
| **Semantic Scholar 无 key** | 429 | 默认不启用，配 `LIT_S2_KEY` 后再开 |
| **合规** | Shadow library 分发未授权副本，多数辖区属侵权 | `shadow` 默认 `fallback`（仅在 OA 全失败时尝试）；`off` 可完全禁用；结果里 `shadow_used` 显式标记 |
| **sci-hub 成功率低** | 实测全部镜像有机器人校验或不可达 | 三级降级 + `adopt` 手动登记闭环；不追求"绕过验证" |
| **PubMed 速率** | 无 key 3 req/s | 作为可选源，core 内串行 + 节流 |

## 9. 未纳入本次改造（后续可做）

- `search_zenodo` → 数据集检索，应并入 `data-inventory` 的取数流程，而不是文献工具
- `search_dblp` / `search_iacr` → 若做 CS / 密码学方向，core 加两个适配器即可
- `read_*_paper` 的"按 DOI 直接给全文"体验 → 已由 `lit_pdf` + `pdf-reading` 覆盖且质量更高

---

## 10. 实施结果（与本文的差异）

| 项 | 计划 | 实际 |
|---|---|---|
| `lit_search` | 5 源含 openalex/semantic | **4 源**：crossref / arxiv / pubmed / europepmc（另两个限流未接） |
| `lit_pdf` 链 | arXiv → PMC → EuropePMC → Unpaywall → OpenAlex → Crossref → sci-hub → adopt | **arXiv → LibGen（DOI 精确）**；Europe PMC 仅作元数据源 |
| sci-hub | `shadow: off/fallback/force` | **未实现**（用户决定不做） |
| `lit_doi` | Crossref → OpenAlex | Crossref → Europe PMC |
| 额外 | — | `lit doctor` 源可用性实测；`%PDF` + 页数校验；LibGen edition 页 DOI 复核 |

实测数据（2026-10-20）：Crossref 3.6 s、arXiv 4.9 s、PubMed 3.3 s、Europe PMC 2.7 s、
LibGen 4.7–7.6 s；`lit_pdf` 对 arXiv 1706.03762 取到 15 页 PDF，对 10.1038/nature14539 经 LibGen 取到 PDF。

## 11. 后续变更（2026-10-20）

按用户要求，**paper-search-mcp 已从 preset 组合中删除**（不只是 `disabled: true`）：

- `agent.cordis.yml`：移除 `mcp-paper-search` 整段（约 40 行含注释），插件行 22 → **21**
- 人格文本里的工具名同步改为 `lit_search` / `lit_bib` / `lit_doi` / `lit_pdf`
- `preset.yml`、`package.json`、bundle patch 描述去掉 "paper-search MCP"
- 删除 `scripts/probe-mcp.mjs`（它只用于 MCP 握手探测）
- 依赖项：不再需要 `uv` / `uvx` / Python 侧的 paper-search-mcp（`~/.cache/uv` 中的残留可 `uv cache prune` 清理）

`!!js` 表达式从 6 个降到 **2 个**（只剩 tool-bash / tool-pwsh 的平台判断）。
