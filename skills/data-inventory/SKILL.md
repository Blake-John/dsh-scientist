---
name: data-inventory
description: 登记数据清单：来源、获取命令、校验值、许可与使用边界、版本。涉及原始数据、公共数据集下载、大文件、或需要说明数据来源时使用。
whenToUse: 拿到新数据、下载公共数据集/基准、复现需要恢复数据、论文要写数据可用性声明时。
---

# 数据清单（Data Inventory）

`data/` 下每份数据都登记，保证**可追溯、可恢复、边界清晰**。数据本体不进工件，
工件只记"怎么从数据得到结果"。

## 登记条目（每份数据一条）

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| id | 短标识 | `zenodo-123456` / `mnist` / `cohort-a` |
| 类型 | 原始 / 公共 / 中间 / 自产 | public / derived |
| 来源 | 仓库 + 持久标识（DOI/accession/URL） | Zenodo DOI 10.5281/zenodo.123456 |
| 获取命令 | 可重跑的一行 | `curl -L https://… -o data/raw/x.zip` |
| 校验值 | sha256（大文件可加大小+行数） | `sha256:9f2c…` |
| 大小 | 体积 | 4.2 GB |
| 许可 | 允许什么、禁止什么 | CC-BY-4.0；署名 |
| 版本/日期 | 数据集版本或抓取日期 | v2 / 2026-10-20 |
| 状态 | active / archived / deleted | active |

统一用 `data/manifest.tsv`（推荐）或 `data/README.md` 表格，**二选一，别混用**。

## 生成校验值

```bash
sha256sum data/raw/*.zip > data/checksums.txt     # 归档前必做
# 大目录：只对清单文件做校验，避免每次全量重算
```

## 放置与版本库边界

- `data/` **不入 git**（大文件 + 许可限制）；`.gitignore` 排除。
- 大文件不进 `artifacts/`：工件存命令+输入哈希，数据本体留在 `data/`。
- 样本/实验单元清单（`data/samples.csv`、`data/cases.csv`）是分析的唯一事实来源，
  行 id 全局唯一，与原始数据一一对应。

## 常见数据源与注意点

| 源 | 取用方式 | 注意 |
| --- | --- | --- |
| Zenodo / Figshare | DOI → 直链下载（`curl -L`） | 记 DOI 与版本；无检索工具时按 DOI 直取 |
| HuggingFace datasets | `datasets.load_dataset` 或直链 | 记 dataset revision（commit hash），别只记名字 |
| OpenAlex / Crossref | API | 用于元数据，不作为"数据"登记 |
| 机构/自采数据 | 内部路径 | 记授权与访问审批，写清谁能用 |
| 仿真/自产 | 生成脚本 | 记脚本路径 + 随机种子 + 参数，可完全重跑 |

## 许可与敏感数据

- 公共数据：写清许可（CC-BY / CC0 / 仅研究用途），论文"数据可用性"节照抄。
- 受限/敏感数据（临床、个人信息、受监管数据）：**不外传、不进公开仓库、不上传第三方服务**；
  只在本地处理，产物做去标识化。
- 许可不明 → 按最严格处理，并询问用户。

## 恢复与复现

- 数据丢失按"来源 + 获取命令"恢复，恢复后核对 `data/checksums.txt`。
- 论文/报告写：`数据见 data/manifest.tsv（含获取命令与校验值）`。
- 工件 `artifact_save` 的 `inputs` 填数据路径（引擎会自动记录输入哈希）。

## 维护

- 每轮研究循环检查一次：manifest 是否覆盖所有在用数据；失效链接/DOI 及时更新。
- 删除数据前确认对应工件与结论不再需要，并留一条记录（日期 + 原因）。
