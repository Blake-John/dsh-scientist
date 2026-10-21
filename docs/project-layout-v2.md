# 项目结构 v2：功能分层与目录约定

> 状态：已实施（2026-10-21）。`project-layout.mjs` 是唯一路径来源；新项目写 `research/study.json.layout = "v2"`。
> 旧项目（v1）可用 `vault layout` 查看、`vault migrate --to v2 --dry-run` 预演迁移。

## 1. 目标

- 根目录只放**功能层**，每层一个职责；层内再分模块。
- 输入 / 学习 / 执行 / 交付 / 状态分开：`data` → `knowledge` → `experiments` → `outputs`，`research` 管状态。
- 代码分两类：可复用 `codes/`，实验一次性脚本 `experiments/<id>/code/`。
- 默认 git 友好：数据、临时文件、运行态默认忽略。
- 每个目录有 `README.md`，写明“放什么 / 不放什么 / 命名规则”。

## 2. 目录树

```
project/
├── README.md                     # 项目首页：目标/问题/阶段/结构图/接手入口（托管块）
├── .gitignore
├── codes/                        # 可复用代码（长期维护）
│   ├── <module>/                 #   按模块组织
│   ├── notebooks/                #   探索性 notebook
│   ├── scripts/                  #   一次性脚本（成熟后提升为 module）
│   └── tests/
├── knowledge/                    # 学到的东西（过程性知识）
│   ├── surveys/                  #   领域调研：<topic>/{report,scope,refs,timeline}.md
│   ├── literature/               #   论文与学习笔记
│   │   ├── notes/<citekey>.md
│   │   ├── pdfs/<citekey>.pdf
│   │   ├── references.bib
│   │   └── queries.md
│   ├── reports/                  #   阶段性总结（周报/月报/组会）
│   ├── logs/                     #   研究日志（按日期，跨实验）
│   └── findings/                 #   原子发现/经验（现象、教训、可复用结论）
├── research/                     # 当前研究状态（插件落地）
│   ├── study.json                #   唯一真相：问题/假设/实验/决策/评审/论断
│   ├── INDEX.md                  #   自动生成的项目地图
│   ├── loops/                    #   运行态 loop（gitignore）
│   ├── records/                  #   工件登记：manifest + provenance + 快照
│   ├── reviews/<id>.md           #   评审长文（study.json 存元数据）
│   └── decisions/<id>.md         #   决策长文（可选）
├── data/                         # 数据（默认不入 git）
│   ├── raw/                      #   原始数据（只读）
│   ├── interim/                  #   中间数据
│   ├── processed/                #   处理后数据
│   ├── external/                 #   外部数据
│   ├── manifest.tsv              #   数据清单（入 git）
│   └── README.md
├── experiments/                  # 实验执行（每次运行一个目录）
│   ├── E01/
│   │   ├── design.md             #   先写设计
│   │   ├── config.yaml           #   参数/环境
│   │   ├── run.sh                #   薄封装，调用 codes/
│   │   ├── code/                 #   仅本实验用的一次性脚本（可提升到 codes/）
│   │   ├── logs/                 #   运行日志（stdout/stderr）
│   │   └── results/              #   指标/图/表
│   └── derivations/DR01/         #   符号推导：derive.py + validation.md
├── outputs/                      # 交付物（成品）
│   ├── manuscript/               #   论文稿
│   ├── figures/                  #   最终图（含 plot.py）
│   ├── tables/                   #   最终表
│   ├── submission/               #   投稿材料
│   └── exports/                  #   RO-Crate 导出
├── envs/                         # 环境锁定
│   └── *.lock.yml
└── scratch/                      # 临时（gitignore）
```

## 3. 每层职责

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `codes/` | 可复用模块、notebook、脚本、测试 | 实验结果、论文、原始数据 |
| `knowledge/` | 调研、文献笔记、阶段总结、研究日志、发现 | 代码、原始数据、最终论文 |
| `research/` | study.json、INDEX、loops、records、reviews、decisions | 大代码、原始数据、论文稿 |
| `data/` | raw/interim/processed/external + manifest | 代码、报告、论文 |
| `experiments/` | 每次实验的 design/config/run/logs/results + 一次性代码；derivations | 可复用库、论文 |
| `outputs/` | manuscript/figures/tables/submission/exports | 过程日志、原始数据 |
| `envs/` | 环境锁定文件 | 代码、数据 |
| `scratch/` | 临时文件 | 任何要保留的东西 |

## 4. 边界规则

| 容易混 | 规则 |
|---|---|
| `codes/` vs `experiments/<id>/code/` | 可复用、被多个实验 import 的放 `codes/`；只服务一次实验的脚本放 `experiments/<id>/code/`，成熟后提升 |
| `knowledge/logs/` vs `experiments/<id>/logs/` | `knowledge/logs/YYYY-MM-DD.md` 是按日期的研究日志；`experiments/<id>/logs/` 是单次运行日志 |
| `knowledge/reports/` vs `outputs/manuscript/` | `knowledge/reports/` 是周报/月报/组会总结；`outputs/manuscript/` 是论文稿与投稿材料 |
| `data/` vs `experiments/<id>/results/` | `data/` 是输入与可复用数据；`experiments/<id>/results/` 是某次运行的输出 |
| `research/` vs `knowledge/` | `research/` 是当前状态（工具读写）；`knowledge/` 是积累的知识（人读为主） |

## 5. git 约定

| 路径 | 入 git | 说明 |
|---|---|---|
| `codes/`、`knowledge/`、`research/`（`loops/` 除外）、`outputs/`、`envs/` | ✅ | 代码、知识、状态、交付、环境 |
| `data/*`（`README.md`/`manifest.tsv` 除外） | ❌ | 原始/中间/处理后数据 |
| `knowledge/literature/pdfs/` | ❌（可选 LFS） | PDF 可重新下载 |
| `outputs/submission/`、`outputs/exports/` | ❌ | 大包/可重建 |
| `scratch/`、`research/loops/` | ❌ | 临时/运行态 |
| `research/records/*/v*/manifest.json`、`provenance.jsonl` | ✅ | 溯源 |
| `research/records/*/v*/files/` | 小文件 ✅ / 大文件 ❌ | 工件快照 |

## 6. 工具与命令映射

| 命令/工具 | 路径 |
|---|---|
| `/study-init` | `research/study.json`、`research/INDEX.md`、根 `README.md`/`.gitignore` |
| `/survey` | `knowledge/surveys/<slug>/{report,scope,refs,timeline}.md` |
| `/paper` | `knowledge/literature/notes/<citekey>.md`、`knowledge/literature/references.bib` |
| `/derive` | `experiments/derivations/<id>/{derive.py,validation.md}` |
| `/write` | 默认 `knowledge/reports/progress-YYYYMMDD.md`；论文目标可写 `outputs/manuscript/...` |
| `/review` | `research/reviews/R01.md` + `study.json` |
| `study_experiment` | 自动建 `experiments/E01/{design.md,config.yaml,run.sh,code/,logs/,results/}` |
| `record_save` | `research/records/<name>/v<N>/` |
| `lit_pdf` / `lit-lib` | `knowledge/literature/pdfs/` |
| `vault export` | `outputs/exports/` |
| `cite-check` | `knowledge/literature/references.bib` |

## 7. v1 → v2 迁移

| 旧 | 新 |
|---|---|
| `literature/` | `knowledge/literature/` |
| `data/papers/` | `knowledge/literature/pdfs/` |
| `reports/landscape-*.md` | `knowledge/surveys/<slug>/report.md` |
| `reports/*` | `knowledge/reports/` |
| `experiments/` | `experiments/`（不变） |
| `derivations/` | `experiments/derivations/` |
| `figures/` | `outputs/figures/` |
| `manuscript/` | `outputs/manuscript/` |
| `reviews/` | `research/reviews/` |
| `analyses/` | 不再保留（迁移到 `experiments/analyses/` 供手工整理） |
| `envs/` | `envs/`（不变） |
| `research/export/` | `outputs/exports/` |
| `research/` | `research/`（不变） |

```bash
vault layout                      # 查看当前布局
vault migrate --to v2 --dry-run   # 预演
vault migrate --to v2             # 迁移（建议先 git commit）
```

迁移会：移动目录、把 `reports/landscape-*.md` 收进 `knowledge/surveys/<slug>/report.md`、创建 v2 目录与 README/.gitignore、设置 `study.json.layout = "v2"`、重写工件 manifest 的 `sourcePath` 前缀。旧项目在迁移前仍按 v1 路径可读。
