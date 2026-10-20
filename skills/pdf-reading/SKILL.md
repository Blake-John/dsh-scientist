---
name: pdf-reading
description: 读 PDF——先做页面画像决定每页怎么读，再用结构化 markdown / 纯文本 / 表格 / 渲染成图四条路分别取内容，公式与图表用视觉兜底，产出带页码的笔记。凡是要读论文全文、技术报告、补充材料、扫描件时使用。
whenToUse: 精读文献、核对论文里的公式或表格、从 PDF 抽数据、读无文本层的扫描件时。
---

# 读 PDF（PDF Reading）

> 还没拿到文件？用 `lit_pdf`（按 DOI 或 arXiv id 取全文，落到 `data/papers/<citekey>.pdf`）。
> 本技能负责"拿到文件之后怎么读"。

**两个工具顶掉大部分手工命令**：

| 工具 | 用途 |
|---|---|
| `pdf_outline` | 先画像：页数、目录、每页文本量与图片数、**公式风险页**、**无文本层页（扫描件）** |
| `pdf_read` | 按页取内容：`mode:"markdown"`（结构化）/ `"text"`（保留版式）/ `"render"`（出 PNG 给 `read_image`）/ `"table"`（表格抽取，带可用性判定） |

**永远先 `pdf_outline`，再用 `pages` 指定范围调 `pdf_read`。** 整本转 markdown 会瞬间吃掉几万字符。

**不要「把整本 PDF 喂给模型」**。先画像、再按页取、按需精修——这是省 token 且不丢信息的关键。

## 第一步：画像（30 秒）

```bash
pdfinfo paper.pdf | head -8                      # 页数 / 是否加密
pdftotext -layout -f 1 -l 1 paper.pdf - | head   # 有文本层？排版正常？
```

| 观察 | 说明 |
|---|---|
| 输出为空或全是乱码 | **无文本层**（扫描件）→ 只能渲染 + 视觉读 |
| 双栏被压成一栏、行交错 | 用 `pdftotext -layout` 或按页渲染，别用默认流式提取 |
| 有文本但公式变成 `√`/`???` | 文本层对公式不可靠 → 公式页单独渲染 |

## 第二步：选路线（本机实测）

| 用途 | 工具 | 实测表现 |
|---|---|---|
| **结构化正文**（标题/段落/列表） | `pdf_read(mode:"markdown")` | `pymupdf4llm`，0.53 s / 2 页，保留 `#` 标题；**图片 omit、公式退化** |
| 快速纯文本 + 保留栏位 | `pdf_read(mode:"text")` | `pdftotext -layout`，双栏顺序基本正确，无结构标记 |
| **表格** | `pdfplumber.extract_tables()` | 默认策略在双栏论文上会把表抽成 8×1 行 —— **必须显式调 `table_settings`** |
| 公式 / 图 / 扫描件 | `pdf_read(mode:"render", dpi:300)` → `read_image` | 0.3 s/页 @150 dpi；输出在 `.pdf-render/`，一次最多 5 页 |
| 其他格式（docx/pptx/xlsx/html） | `markitdown` | 补充材料常见格式 |

> 可选升级：装 `dsh-pdf-reader` 插件后可用 `pdf_scan`（逐页画像：栏数/图/表/公式风险）、`pdf_read_page`（低清整页 + 文本 + 高清图块落盘）、`pdf_render_region`（定向高 DPI 裁剪）。没装也能用下面的原生路线。

## 第三步：按页/按节取，不要整篇

```
pdf_outline("data/papers/vaswani2017attention.pdf")
  → 页数 15 · 文本层有 · 目录 6 项 · 公式风险页 p.3,p.5

pdf_read(path, pages:"1-2", mode:"markdown")     # 摘要 + 引言
pdf_read(path, pages:"9-10", mode:"text")        # 实验表格页，保留版式
pdf_read(path, pages:"5", mode:"render", dpi:300) # 公式页 → PNG → read_image
```

一页 markdown 通常 2–7 k 字符。**10 页以上不要一次性转**——先读摘要/引言/结论，再按需读方法。
输出超过 60k 字符会被截断，按提示缩小 `pages` 继续。

## 第四步：公式与图表走视觉

文本层里的公式一定不可信。要准确读公式，把那一页渲染成图，交给视觉模型（`read_image`）：

```
pdf_read(path, pages:"4", mode:"render", dpi:300)
  → 已渲染 1 页到 .pdf-render/page-4.png
  → 把该路径交给 read_image
```

- 150 dpi 够读正文；**公式/下标/表格小字用 300 dpi**。
- 整页图用于看版面（双栏顺序、图表位置）；只看某个公式时可裁剪区域（pymupdf `page.get_pixmap(clip=...)`）省 token。
- 读到的图/表要记**页码与图号**，后面引用才有据。

## 表格与图片：先认清它们的可靠边界

实测结论（Attention Is All You Need，15 页）：

| 内容 | `markdown` 模式 | 结论 |
|---|---|---|
| **图片** | 只留占位符 `**==> picture [220x323] intentionally omitted <==**` | 模型**看不到图** |
| **表格** | pymupdf4llm 会输出 markdown 表，但表头被压成 `<br>` 拼接、行数据错位 | **结构错误，比没有更危险** |

### 图片：用 `images:"extract"`

```
pdf_read(path, pages:"3", mode:"markdown", images:"extract")
  → 正文 + 「本页图片已落盘（1 个）：/…/.pdf-assets/xxx-0003-00.png」
  → 把路径交给 read_image 查看
```

- 只导出**位图**；矢量图（大部分论文插图）导不出来 → 用 `mode:"render"` 整页渲染
- 落盘目录 `<root>/.pdf-assets/`，每次 extract 前会清空

### 表格：`mode:"table"` 带质量门（宁可拒绝，不给错数据）

```
pdf_read(path, pages:"9", mode:"table")
  → ### p.9 表格（54×1）— **抽取不可靠，未输出**
     原因：表格被压成一列（列边界未识别），数字很可能错行
     → 用 pdf_read(pages:"9", mode:"render", dpi:300) 渲染后交给 read_image 读数。
```

判定为不可靠的五种典型情况（都实测遇到过）：

| 失败模式 | 自动给出的原因 |
|---|---|
| 列边界没识别出来 | 「被压成一列」 |
| 每行文字被当成表格行 | 「抽出 47 行，疑似把逐行文字当成了表格行」 |
| 过度切分 | 「抽出 33 列，明显过度切分」 |
| 文字层方向异常 | 「检出 4 个倒序词（如 ehT→The）」 |
| 标题被卷进单元格 | 「表格标题被卷进单元格，区域识别错了」 |

**能通过质量门的表格**会输出 markdown 表，但仍附「务必核对 2–3 个单元格」的警告。

**重要**：这篇论文的 5 个表格页全部判定为不可靠——**这类无框线、多行表头的表格，自动抽取目前没有可靠方案**。凡是要引用具体数字，一律 `mode:"render"` 看图人工核对。

## 第五步：表格（pdfplumber 要调参）

```python
import pdfplumber

with pdfplumber.open("paper.pdf") as pdf:
    page = pdf.pages[8]
    # 双栏论文里表格常被栏线切碎：先看默认结果，再换策略
    for settings in (
        {},
        {"vertical_strategy": "text", "horizontal_strategy": "text"},
        {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
    ):
        table = page.extract_table(settings)
        print(settings or "default", "→", len(table or []), "行")
```

抽出的表格**必须人工核对 2–3 个单元格**（表头、最大值、单位）。数字错行是这类工具最常见的失败，而它看起来"很干净"。核不上就改用 300 dpi 渲染看图。

## 第六步：记录（接 literature-retrieval）

笔记里每条要点都带**页码**，便于回查：

```markdown
## 方法要点
- 编码器堆叠 6 层，每层含自注意力与前馈子层（p.3）
- 残差 + LayerNorm 的连接方式见式 (1)（p.3，公式经渲染核对）
- 训练配置：8×P100、batch 25k tokens（p.7，表 3 经 pdfplumber 抽取 + 人工核对）
```

没读正文只看了摘要的，标注「仅摘要」。引用页码来自渲染或 markdown 的锚点，不要凭印象写。

## 常见坑

- **整本 `to_markdown`**：15 页论文 ≈ 60 k+ 字符，几篇就把上下文挤爆。按页取。
- **相信文本层里的公式**：`α`、下标、分式经常错位或丢符号，必须渲染核对。
- **相信 pdfplumber 的表**：默认策略在多栏页面会把一行拆成多行（实测 8 行表 → 8×1），且不报错。
- **扫描件当文本件处理**：`get_text()` 返回空就是没有文本层，直接渲染 + 视觉，别反复换提取库。
- **图片被 omit**：`markdown` 模式默认只给 `**==> picture … omitted <==**` 占位符；要看图用 `images:"extract"`，矢量图用 `mode:"render"`。
- **直接相信 markdown 里的表格**：实测表头会被压成 `<br>`、行数据错位；一律先跑 `mode:"table"` 看判定，不可靠就渲染看图。
- **不记页码**：三周后回查"这个数字哪来的"会重读整篇。
