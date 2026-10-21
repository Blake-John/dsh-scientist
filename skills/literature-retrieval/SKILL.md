---
name: literature-retrieval
description: 文献检索与精读——把研究问题转成可复用检索式，多源并发检索、按显式标准筛选去重、取 OA 全文精读、落成笔记与 references.bib，并保证每条引用可追溯。当需要查文献、找某主题最新工作、核对某个论断是否有文献支撑、为报告/推导补引用时使用。
whenToUse: 调研检索、写报告需要引用、核对他人结论、找具体论文/数据集、追踪引用网络时。
---

# 文献检索与精读（Literature Retrieval）

原则：**检索式可复用、筛选标准显式、引用可追溯、没读过的不算读过。**

> **筛出来的论文用 `literature-vault` 技能入库**（结构化记录 + 受控词表 + 自动下 PDF 写 bib）。
> 本技能管"找到并判断要不要"，vault 管"留下来怎么管"。

## 工具（4 个原生工具）

| 工具 | 用途 |
|---|---|
| `lit_search` | 多源并发检索 + 去重，**首选**。`sources` 可选 `crossref`/`arxiv`/`pubmed`/`europepmc` |
| `lit_doi` | 按 DOI 取权威元数据（Crossref → Europe PMC），核对引用、补全字段、判断有无 OA |
| `lit_bib` | 按 DOI 生成 BibTeX 并写入 `knowledge/literature/references.bib`（按 DOI 幂等） |
| `lit_pdf` | 取全文 PDF：arXiv → LibGen（DOI 精确匹配），存 `knowledge/literature/pdfs/<citekey>.pdf` |

**当前可用源（2026-10 实测）**：Crossref ✅、arXiv ✅、PubMed ✅、Europe PMC ✅、LibGen ✅。
OpenAlex / Semantic Scholar 限流、Unpaywall 缺真实邮箱 —— **均未接入**，不要试图调用。

**取全文的边界**：
- arXiv 预印本、有 DOI 且有 LibGen 条目的期刊论文 → 能拿到
- 只有 arXiv id 的会议论文（NeurIPS/ICML 等） → 走 arXiv ✅
- 付费墙且无 OA 副本 → `lit_pdf` 失败，标注「仅摘要」，不要反复重试
- **不要用标题去 LibGen 找** —— 实测会返回同名不同论文（`lit_pdf` 只接受 DOI）

## 工作流

### 1. 把问题写成检索式
一个检索式包含：核心概念 + 同义词/缩写/旧称 + 方法词 + 领域限定。
- 布尔与字段：`(diffusion OR "score-based") AND (sampling OR "reverse process")`
- **精确标题用 `ti:` 前缀**（实测：直接搜 "Attention Is All You Need" 排不到原文，`ti:"Attention Is All You Need"` 才能命中）
- 已知 arXiv id 时直接传 id（`lit_search "1706.03762"` → 精确直取，走 `id_list`）
- 逐条记录到 `knowledge/literature/queries.md`：日期 / 源 / 检索式 / 命中数 / 备注。
- 同一问题准备 2–3 个不同角度的检索式（方法角度、任务角度、应用角度），互相补漏。

### 2. 检索
- 首选 `lit_search`，`sources` 传 2–4 个互补源（默认 `["crossref","arxiv"]`；生医加
  `pubmed`/`europepmc`）。一次多源比十次单源省时且漏检少。
- 返回里带各源状态行（如 `crossref ✓ 20 / openalex ✗ rate_limited`）——**把状态记进
  `knowledge/literature/queries.md`**，将来判断"漏检"时有据可查。
- 结果先按标题粗筛，再按摘要精筛；不要一开始就下全文。
- 记下命中总数——后面判断"是否漏检"要用。

### 3. 筛选（显式标准，留痕）
在 `knowledge/literature/screening.md` 写下本次的纳入/排除标准，例如：
- 纳入：同行评审或高引预印本；提出方法或给出可用结论；2020 年后（奠基工作例外）。
- 排除：纯应用无方法贡献；无法获取正文且摘要不足以判断；重复发表。

按 **DOI 去重**（无 DOI 用 arXiv id / 标题+年份）。每条排除都要写原因，
**不要静默丢弃**——否则无法复核是否漏了好工作。

### 4. 精读（只信正文）
1. `lit_pdf` 取全文（arXiv 优先，其次 LibGen）；拿到路径后按 `pdf-reading` 技能解析正文。
2. 读顺序：摘要 → 图与表 → 方法 → 实验设置 → 局限/讨论 → 相关工作。
3. 记四件事：**核心主张 / 关键假设 / 证据强度（数据、基线、消融）/ 我没被说服的地方**。
4. 引用原文时记下页码或章节，便于回查。
5. 拿不到全文：只按摘要记录，并标注「仅摘要，未读正文」。

### 5. 笔记与书目
```
knowledge/literature/
  queries.md            检索式与命中记录
  screening.md          纳入/排除标准与结果
  notes/<citekey>.md    单篇笔记（见模板）
  references.bib        BibTeX（citekey 与笔记文件名一致）
  matrix.md             横向对比表（可选，多篇对比时建）
```
`notes/<citekey>.md` 模板：
```markdown
# <标题>
- citekey: <第一作者><年份><关键词>
- 出处: <期刊/会议> <年> | DOI: <doi> | arXiv: <id>
- 状态: 已读全文 / 仅摘要
- 一句话贡献:
## 核心主张
## 方法要点
## 证据强度（数据/基线/消融）
## 局限与我不同意的地方
## 与本课题的关系（可复用/需推翻/仅背景）
## 可引用的原句（带页码）
```

> `/paper` 的出口契约要求 **核心主张 / 方法要点 / 局限** 三节都有实质内容；
> 只建了标题、正文空着不算完成（`lit-lib add` 生成的空模板要先回写再 `loop_close()`）。

### 6. 引用纪律
- 没读全文的，不得写成「XX 证明了」；只能写「XX 的摘要声称」。
- 二手引用（从别人综述里看到的）必须写「转引自 <综述>」，并尽量回溯原文。
- **书目用 `lit_bib` 生成，不要手写**：它按 DOI 幂等去重、字段缺失时写 `% TODO` 而不是编造。
- 生成后跑 `cite-check --root .` 校验（必填字段、DOI 与 Crossref 一致、正文引用与 bib 双向对应）。
- 报告里每个引用编号都能在 `references.bib` 里找到对应条目，且笔记存在。

## 常见失败

- **检索式不记录**：两周后无法复现"当时怎么找的"。
- **只搜英文主词**：漏掉同义术语与旧称（这是漏检第一原因）。
- **把预印本当已发表**：标注状态，别把 arXiv v1 当定论。
- **摘要级引用**：摘要常夸大，正文实验设置可能根本不支持。
- **引用数量当质量**：10 篇精读胜过 100 篇标题扫描。
