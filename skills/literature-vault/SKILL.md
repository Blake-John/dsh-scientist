---
name: literature-vault
description: 文献库的工程化管理——每篇文献建结构化记录（关键词/标签/时间/引用数/评估），受控词表强制校验，入库自动抓元数据、下 PDF、写 bib，并提供按标签/关键词/年份/影响力的检索与统计。当需要把论文归档、给已读文献打标签、按主题检索自己读过的文献、核查库里哪篇缺 PDF 或缺 bib、统计阅读积压时使用。
whenToUse: 文献入库、整理已有文献、按标签或关键词检索库内文献、核查库一致性、统计阅读进度时。
---

# 文献库管理（Literature Vault）

原则：**每篇文献一条结构化记录、词表受控、记录与 bib/PDF 三方一致、没读过的别标读过。**

## 与其它技能的分工

| 技能 | 负责 |
|---|---|
| `literature-retrieval` | **发现**：检索式、多源并发、筛选标准 |
| **本技能** | **管理**：入库、分类、打标、评估、检索自己的库、维护一致性 |
| `pdf-reading` | **精读**：按页取内容、图表处理 |

发现一篇论文 → 用检索技能；决定要留下它 → 用本技能入库。

## 目录

```
literature/
├── notes/<citekey>.md    # 单篇记录：frontmatter + 阅读笔记
├── taxonomy.yml          # 受控词表（关键词 + 标签命名空间）
├── references.bib        # 由 lit_bib 生成
├── index.json            # lit-lib index 生成
├── queries.md / screening.md
```

## 记录格式

frontmatter 是**扁平**的（无嵌套），可直接手写：

```yaml
---
citekey: vaswani2017attention
title: Attention Is All You Need
authors: [Ashish Vaswani, Noam Shazeer]
year: 2017
venue: NeurIPS
venue_type: conference
doi: 10.48550/arxiv.1706.03762
arxiv: '1706.03762'
pmid: ''
keywords: [transformer, self-attention]
tags: [method/attention, era/2017, collection/thesis-ch2]
added: 2026-10-20
published: ''
read_at: ''
last_verified: 2026-10-20
citations: 120000
citations_source: openalex
citations_snapshot: 2026-10-20
influence_tier: landmark
relevance: 5
quality: 4
confidence: high
role: method
read_status: unread
pdf: data/papers/vaswani2017attention.pdf
---
# 核心主张 / 方法要点 / 证据强度 / 局限 / 与本课题的关系
```

**必填（①标识著录 + ②分类）**：`citekey` `title` `authors` `year` `venue` `venue_type` `keywords`（≥1）`tags` `added`，以及 `doi`/`arxiv`/`pmid` 至少一个。

**可选（③影响力 + ④评估）**：`citations*` `influence_tier` `relevance` `quality` `confidence` `role` `read_status` `published` `read_at` `pdf`。

### 枚举值

| 字段 | 取值 |
|---|---|
| `venue_type` | journal / conference / preprint / book / thesis / report |
| `read_status` | unread / abstract / skimmed / read_full |
| `role` | method / baseline / survey / dataset / theory / application |
| `influence_tier` | landmark / core / supporting / peripheral |
| `confidence` | high / medium / low |

## 关键词与标签

| | keywords | tags |
|---|---|---|
| 性质 | **受控词表**，必须在 `taxonomy.yml` 登记 | 自由，但**必须带命名空间** |
| 粒度 | 主题概念 | 用途/属性/归属 |
| 上限 | ≤ 8 | ≤ 12（软限） |

**命名空间**：`method/` `task/` `era/` `status/` `to-cite/` `collection/` `dataset/`

**归属用 `collection/<name>`，不要幻想有独立的 collections 字段**——一个机制比两个可靠：

```yaml
tags: [collection/thesis-ch2, to-cite/ch1, status/core]
```

**新增关键词必须先改词表**，否则 `check` 报错。这是唯一的"词表真相"。

### 影响力怎么写（没有影响因子）

**不记 IF**：它是期刊级、有版权、逐年变。改用三个正交的字段：

| 字段 | 含义 | 来源 |
|---|---|---|
| `citations` + `citations_source` + `citations_snapshot` | 引用数及其快照 | `lit_doi` 自动带出 |
| `influence_tier` | **你自己的分档**：landmark / core / supporting / peripheral | 人工判断 |
| `role` | 在课题里的角色：method / baseline / survey / … | 人工判断 |

引用数只能**同子领域同年**横比；跨领域比没有意义。

## 命令

```bash
lit-lib init                                  # 建 literature/ 与词表模板
lit-lib add <doi|arxiv-id> --keywords a,b [--tags x/y] [--draft]
                                              # 自动：抓元数据 → 下 PDF → 写 bib → 建记录
lit-lib list [--tag x/y] [--keyword k] [--year 2020] [--status read_full]
             [--tier core] [--role method] [--collection name]
             [--sort year|citations|citekey] [--limit 50]
lit-lib search "<q>"                          # 跨标题/作者/关键词/标签/笔记正文
lit-lib tag <citekey> +ns/v -ns/v             # 增删标签
lit-lib set <citekey> field=value [...]       # 改任意字段（枚举会校验）
lit-lib stats                                 # 分布、孤儿标签、未读积压
lit-lib index                                 # 重建 index.json
lit-lib check                                 # 词表 + 枚举 + bib + PDF 三方校验
```

## 工作流

### 1. 入库

```bash
lit-lib add 10.1038/nature14539 --keywords representation-learning --tags era/2015,method/cnn
```

自动做三件事，任一失败不阻塞记录创建：抓元数据、下 PDF（`--no-pdf` 关）、写 bib（`--no-bib` 关）。

**关键词是第一道关**：它决定这篇论文在你库里的位置。想不清关键词，说明还没想清它为什么值得留——那就别急着入库。

### 2. 打标与归属

```bash
lit-lib tag lecun2015deep +collection/thesis-ch1 +to-cite/intro -status/draft
```

### 3. 精读后回写

读完必须更新，否则库里的 `read_status` 全是谎言：

```bash
lit-lib set lecun2015deep read_status=read_full read_at=2026-10-21 \
  relevance=5 quality=5 confidence=high role=method influence_tier=landmark
```

笔记正文直接编辑 `notes/<citekey>.md` 的 `---` 之后部分，写**核心主张 / 方法要点 / 证据强度 / 局限 / 与本课题的关系**。

### 4. 检索自己的库

```bash
lit-lib list --tag collection/thesis-ch2 --sort citations
lit-lib search "contrastive"
lit-lib list --status unread --tier landmark    # 优先读哪些
```

### 5. 定期维护（每周一次）

```bash
lit-lib check     # 词表/枚举/bib/PDF 一致性
lit-lib stats     # 孤儿标签、未读积压
lit-lib index     # 刷新索引
```

## 纪律

- **`read_status` 不许虚报**：`read_full` 意味着正文读完且笔记写了五段；只看了摘要就是 `abstract`。
- **每次入库必须给 ≥1 个关键词**，且关键词在词表里——词表膨胀是正常的，乱建关键词才是问题。
- **孤儿标签（只用一次）定期收敛**：要么提升为关键词，要么删掉。
- **`citations_snapshot` 超过 180 天会被 `check` 提示**，重要的 landmark 论文手动刷一次。
- **淘汰不删除**：加 `status/excluded` 标签并保留记录，说明为什么排除——比删掉更有价值。
- **库不等于参考文献**：只进 `references.bib` 的是真正要引用的；库可以更宽。
