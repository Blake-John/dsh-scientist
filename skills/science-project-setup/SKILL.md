---
name: science-project-setup
description: 初始化或整理一个科研项目：目录约定、研究清单（research/study.json）、数据与权限边界。新建项目、换工作区、或整理混乱的项目时使用。
whenToUse: 开始新科研项目、把已有材料组织成可运行的研究项目、或迁移项目目录时。
---

# 科研项目初始化与组织

项目根 = 工作区根（自动探测：含 `research/`、`knowledge/`、`data/` 或 `.git` 的目录）。
研究状态统一由 `research/study.json` 维护；目录布局由 `project-layout.mjs` 定义（v2）。

## 目录约定（v2）

| 层 | 目录 | 内容 | 是否入 git |
| --- | --- | --- | --- |
| 代码 | `codes/` | 可复用模块、notebooks、scripts、tests | 入 |
| 知识 | `knowledge/surveys/` | 领域调研：`<topic>/{report,scope,refs,timeline}.md` | 入 |
| 知识 | `knowledge/literature/` | 论文笔记、`references.bib`、`pdfs/`、`queries.md` | 入（PDF 可选/LFS） |
| 知识 | `knowledge/reports/` | 周报/月报/组会总结 | 入 |
| 知识 | `knowledge/logs/` | 研究日志（按日期，跨实验） | 入 |
| 知识 | `knowledge/findings/` | 原子发现/经验（现象、教训、可复用结论） | 入 |
| 状态 | `research/` | `study.json`、`INDEX.md`、`records/`、`loops/`、`reviews/`、`decisions/` | 入（`loops/` 除外） |
| 状态 | `research/records/<name>/` | 版本化工件：`v<N>/`、`manifest.json`、`provenance.jsonl` | 入（小文件） |
| 数据 | `data/` | `raw/`、`interim/`、`processed/`、`external/`、`manifest.tsv` | **不入**（manifest 入） |
| 实验 | `experiments/<id>/` | `design.md`、`config.yaml`、`run.sh`、`code/`、`logs/`、`results/` | 代码入，大结果出 |
| 实验 | `experiments/derivations/<id>/` | `derive.py`、`validation.md` | 入 |
| 交付 | `outputs/manuscript/` | 论文稿 | 入 |
| 交付 | `outputs/figures/` | 最终图（含 `plot.py`） | 入 |
| 交付 | `outputs/tables/` | 最终表 | 入 |
| 交付 | `outputs/submission/` | 投稿材料 | 视情况 |
| 交付 | `outputs/exports/` | RO-Crate 导出 | 视情况 |
| 环境 | `envs/` | 环境锁定（conda/uv lock） | 入 |
| 临时 | `scratch/` | 临时文件 | **不入** |

边界规则：

- `codes/` 放可复用代码；只服务一次实验的脚本放 `experiments/<id>/code/`，成熟后提升。
- `knowledge/logs/` 是**按日期的研究日志**；`experiments/<id>/logs/` 是**单次运行日志**。
- `knowledge/reports/` 是阶段总结；`outputs/manuscript/` 是论文稿与投稿材料。
- `data/` 是输入与可复用数据；`experiments/<id>/results/` 是某次运行的输出。
- `research/` 是当前状态（工具读写）；`knowledge/` 是积累的知识（人读为主）。

## 初始化步骤

1. 若 `research/study.json` 不存在：`study_init`（title、question）。它会建好 v2 目录、根 `README.md`、`.gitignore`、`data/manifest.tsv` 与 `knowledge/literature/references.bib`。
2. 读根 `README.md`；项目特有说明写在托管块 `<!-- dsh-scientist:begin -->` 之外。
3. 检查 `data/`：登记数据清单（见 data-inventory 技能）。
4. 建立环境（见 conda-environments 技能），锁定文件放 `envs/`。
5. 旧项目（v1 布局）先跑 `vault migrate --to v2 --dry-run`，确认后再迁移。

## 权限与沙箱（对应 Claude Science 权限卡片）

- 代码在沙箱运行。访问新目录、联网、安装包会触发审批——向用户说明申请什么、为什么。
- 默认只读写项目根；`data/` 中外部授权的数据只读使用，不复制进工件。
- 网络 deny-by-default：只允许包管理器与已批准的文献/数据库主机。

## 清单字段速览

`project`（标题/领域/状态）、`question`（核心问题）、`hypotheses[]`（id/text/status/experiments）、
`loop`（phase/iteration/history）、`experiments[]`（含 `path`）、`decisions[]`、`reviews[]`（含 `path`）、`claims[]`。
清单是机器与模型共用的真相来源：**所有状态变更走 study_* 工具，不要手改 JSON 结构**（追加式 log 文件除外）。
