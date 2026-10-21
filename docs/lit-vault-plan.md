> 注：本文中的路径是 v1 布局；项目结构 v2（knowledge/surveys、experiments/derivations 等）以 [project-layout-v2.md](project-layout-v2.md) 为准。

# 文献库（Literature Vault）设计决定

> 状态：已实施（2026-10-20）。技能 `literature-vault`，CLI `scripts/lit-lib.mjs`。

## 1. 锁定项（用户拍板）

| 问题 | 决定 |
|---|---|
| 记录载体 | **markdown frontmatter**（人读友好、单目录可备份、模型不直接碰 YAML） |
| 必填范围 | **①标识著录 + ②分类（关键词/标签/时间）必填**；③影响力、④评估可选 |
| 影响因子 | **不做**。IF 是期刊级、有版权、逐年变，给单篇记 IF 在方法上错误 |
| 关键词 | **强制受控**，未在 `taxonomy.yml` 登记即报错 |
| 入库 | **自动**：抓元数据 → 下 PDF → 写 bib |
| collections | **不设独立字段**，集合用 `tag: collection/<name>` |

## 2. 为什么 collections 并入 tags

1. 一个机制比两个可靠——两套并存必然漂移，`check` 要多写互相校验
2. `collection/thesis-ch2` 语义完全等价
3. 过滤语言统一：`--tag collection/x` 与 `--tag method/y` 同构
4. collections 只在"集合自身有属性"（截止日、目标期刊）时才划算
5. 将来需要时加 `collections.yml`（名字→元数据），成员关系仍用 tag

## 3. 影响力的三档设计

| 字段 | 性质 | 来源 |
|---|---|---|
| `citations` / `citations_source` / `citations_snapshot` | 客观事实，带快照时间 | `lit_doi` 自动 |
| `influence_tier` | 主观分档（landmark/core/supporting/peripheral） | 人工 |
| `role` | 课题内角色（method/baseline/survey/…） | 人工 |

引用数只能同子领域同年横比；跨领域比无意义。

## 4. frontmatter 为什么是扁平的

嵌套 `ids:` 需要真正 YAML 解析器。拉平成 `doi` / `arxiv` / `pmid` 后，
子集解析器（只认 `key: value` 与 `key: [a, b]`）就够，且**手写不会写坏**。

## 5. 校验规则（`lit-lib check`）

- citekey 格式与文件名一致
- 必填字段非空、至少一个标识
- 枚举值合法（`venue_type` / `read_status` / `role` / `influence_tier` / `confidence`）
- 关键词在词表；标签带命名空间且命名空间已定义
- 日期 `YYYY-MM-DD`，`read_at ≥ added`
- `pdf` 指向的文件存在
- 双向：bib 有而库内无记录 / 库内有而 bib 无条目（警告）
- `citations_snapshot` 超 180 天提示刷新

## 6. 与其它构件

```
lit_search → 发现      lit_doi → 元数据
lit_bib    → bib       lit_pdf → PDF
pdf-reading→ 精读后回写 read_status / read_at / 笔记
lit-lib    → 记录 + 索引 + 校验（本方案）
cite-check → 正文引用 ↔ bib
```
