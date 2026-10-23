#!/usr/bin/env python3
"""pdf-extract —— pdf_read / pdf_outline 工具的后端（被 pdf-tools.mjs 调用）

子命令：
  outline <pdf>                     → JSON：页数、是否有文本层、目录、逐页画像
  markdown <pdf> [--pages 0,2,3]    → pymupdf4llm 转换的结构化 markdown
  text <pdf> --first N --last M     → pymupdf 按版式取文本（pdftotext 不可用时兜底）

只依赖 PyMuPDF / pymupdf4llm（本机已装）。缺依赖时以 JSON 报错，调用方转成可读提示。
"""
import json
import sys

# 真正的 stdout 只留给 JSON。PyMuPDF / pymupdf4llm / pdfplumber 会往 stdout
# 打日志（例如没有 tessdata 时的 "OCR disabled because ..."），一旦混进来，
# Node 侧 JSON.parse 就会失败。库的输出统一改到 stderr。
_STDOUT = sys.stdout


def emit(payload: dict) -> None:
    _STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _STDOUT.flush()


def fail(code: str, message: str) -> None:
    emit({"error": code, "message": message})
    sys.exit(0)


def load_fitz():
    try:
        import pymupdf  # PyMuPDF ≥1.24 的新名字
        return pymupdf
    except ImportError:
        try:
            import fitz as pymupdf  # 旧名字
            return pymupdf
        except ImportError:
            fail(
                "missing_dependency",
                "缺少 PyMuPDF。安装：python3 -m pip install --user pymupdf pymupdf4llm",
            )


def parse_pages(raw: str | None) -> list[int] | None:
    """支持 '1-5,9' / '0,2,3'（两种都按 1 起解析，最终转 0 起）。"""
    if not raw:
        return None
    out: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            a, b = chunk.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(chunk))
    return [p - 1 for p in out if p >= 1]


def cmd_outline(path: str) -> None:
    pymupdf = load_fitz()
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001
        fail("cannot_open", f"打不开 PDF：{exc}")

    pages = []
    text_chars = 0
    for index in range(doc.page_count):
        page = doc.load_page(index)
        text = page.get_text("text")
        chars = len(text.strip())
        text_chars += chars
        try:
            images = len(page.get_images(full=True))
        except Exception:  # noqa: BLE001
            images = 0
        pages.append(
            {
                "page": index + 1,
                "chars": chars,
                "images": images,
                # 公式风险启发式：含较多 =、^、∑/∫/∂ 等符号且文本量不大
                "formulaRisk": bool(
                    chars > 0
                    and sum(text.count(sym) for sym in ("=", "^", "∑", "∫", "∂", "√", "±")) >= 6
                ),
                "hasText": chars > 0,
            }
        )

    toc = []
    try:
        for level, title, page in doc.get_toc(simple=True):
            toc.append({"level": level, "title": title, "page": page})
    except Exception:  # noqa: BLE001
        toc = []

    table_pages = {}
    if doc.page_count <= 40:
        try:
            import pdfplumber

            with pdfplumber.open(path) as plumber:
                for index in range(doc.page_count):
                    try:
                        found = len(plumber.pages[index].find_tables())
                    except Exception:  # noqa: BLE001
                        found = 0
                    if found:
                        table_pages[index + 1] = found
        except Exception:  # noqa: BLE001
            table_pages = {}

    result = {
        "path": path,
        "tablePages": table_pages,
        "pages": doc.page_count,
        "hasTextLayer": text_chars > 0,
        "avgCharsPerPage": round(text_chars / max(doc.page_count, 1)),
        "toc": toc,
        "perPage": pages,
        "suspectFormulaPages": [p["page"] for p in pages if p["formulaRisk"]][:20],
        "emptyTextPages": [p["page"] for p in pages if not p["hasText"]][:20],
    }
    doc.close()
    emit(result)


def cmd_markdown(path: str, pages_raw: str | None, image_dir: str | None) -> None:
    load_fitz()
    try:
        import pymupdf4llm
    except ImportError:
        fail(
            "missing_dependency",
            "缺少 pymupdf4llm。安装：python3 -m pip install --user pymupdf4llm",
        )
    pages = parse_pages(pages_raw)
    kwargs = {}
    if image_dir:
        import os

        os.makedirs(image_dir, exist_ok=True)
        kwargs = {"write_images": True, "image_path": image_dir, "image_format": "png"}
    try:
        markdown = pymupdf4llm.to_markdown(path, pages=pages, **kwargs)
    except Exception as exc:  # noqa: BLE001
        fail("convert_failed", f"pymupdf4llm 转换失败：{exc}")

    images = []
    if image_dir:
        import os

        images = sorted(os.path.join(image_dir, f) for f in os.listdir(image_dir) if f.lower().endswith(".png"))
    emit({"pages": pages, "markdown": markdown, "images": images})


def cmd_tables(path: str, pages_raw: str | None) -> None:
    """用 pdfplumber 抽表：多策略取最优，并按单元格填充率打分。"""
    try:
        import pdfplumber
    except ImportError:
        fail("missing_dependency", "缺少 pdfplumber。安装：python3 -m pip install --user pdfplumber")

    pages = parse_pages(pages_raw)
    strategies = [
        {},
        {"vertical_strategy": "text", "horizontal_strategy": "text"},
        {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
    ]
    out = []
    try:
        with pdfplumber.open(path) as pdf:
            targets = pages if pages is not None else list(range(min(len(pdf.pages), 40)))
            for index in targets:
                if index < 0 or index >= len(pdf.pages):
                    continue
                page = pdf.pages[index]
                candidates = []
                for label, settings in (("lines", None), ("text", {"vertical_strategy": "text", "horizontal_strategy": "text"})):
                    try:
                        tables = page.find_tables() if settings is None else page.extract_tables(settings)
                    except Exception:  # noqa: BLE001
                        continue
                    if settings is None:
                        tables = [t.extract() for t in tables]
                    for table in tables or []:
                        rows = [r for r in table if r and any((c or "").strip() for c in r)]
                        if len(rows) < 2:
                            continue
                        cols = max(len(r) for r in rows)
                        cells = sum(1 for r in rows for c in r if (c or "").strip())
                        fill = cells / max(len(rows) * cols, 1)
                        # 更严的可用性判据（实测这类论文的常见失败模式）：
                        #   · 表格标题被卷进来（首两行出现 "Table N"）→ 抓到的是 caption
                        #   · 行数过多（>30）→ 每行文字被切成一行，过度切分
                        #   · 单元格平均过长（>40）→ 段落被塞进单元格
                        head = " ".join(str(c or "") for r in rows[:2] for c in r)
                        tokens = [
                            w
                            for r in rows
                            for c in r
                            for w in str(c or "").split()
                        ]
                        short_ratio = (
                            sum(1 for w in tokens if len(w) <= 2) / len(tokens) if tokens else 1.0
                        )
                        # 倒序乱码检测：Common word 的逆序（如 ehT→The、waL→Law）
                        common = {
                            "the", "and", "for", "with", "that", "this", "from", "are",
                            "was", "were", "will", "been", "which", "using", "model",
                            "table", "attention", "layer", "output", "input",
                        }
                        reversed_hits = sum(
                            1
                            for w in tokens
                            if len(w) >= 3 and w[::-1].casefold() in common
                        )
                        garbled = (
                            short_ratio > 0.5
                            or reversed_hits >= 3
                            or avg_cell > 40
                        )
                        avg_cell = sum(len(str(c or "")) for r in rows for c in r) / max(
                            sum(len(r) for r in rows), 1
                        )
                        plausible = (
                            2 <= cols <= 12
                            and fill >= 0.6
                            and len(rows) <= 30
                            and not garbled
                            and not __import__("re").search(r"\bTable\s*\d", head, __import__("re").I)
                        )
                        score = len(rows) * min(cols, 15) * fill * (1.0 if plausible else 0.05)
                        candidates.append(
                            {
                                "rows": rows,
                                "cols": cols,
                                "fill": round(fill, 2),
                                "strategy": label,
                                "plausible": plausible,
                                "score": score,
                                "short_ratio": round(short_ratio, 2),
                                "reversed_hits": reversed_hits,
                            }
                        )
                if not candidates:
                    continue
                best = max(candidates, key=lambda c: c["score"])
                if best["cols"] == 1:
                    verdict = "表格被压成一列（列边界未识别），数字很可能错行"
                elif best["cols"] > 12:
                    verdict = f"抽出 {best['cols']} 列，明显过度切分"
                elif len(best["rows"]) > 30:
                    verdict = f"抽出 {len(best['rows'])} 行，疑似把逐行文字当成了表格行"
                elif best["fill"] < 0.6:
                    verdict = f"单元格填充率仅 {best['fill']}，结构不可信"
                elif "Table" in " ".join(str(c or "") for r in best["rows"][:2] for c in r):
                    verdict = "表格标题被卷进单元格，说明区域识别错了"
                elif best["reversed_hits"] >= 3:
                    verdict = f"检出 {best['reversed_hits']} 个倒序词（如 ehT→The），文字层方向异常"
                elif best["short_ratio"] > 0.5:
                    verdict = f"碎片化严重（{int(best['short_ratio']*100)}% 的 token ≤2 字符）"
                else:
                    verdict = ""
                out.append(
                    {
                        "page": index + 1,
                        "cols": best["cols"],
                        "rows": len(best["rows"]),
                        "fill": best["fill"],
                        "strategy": best["strategy"],
                        "reliable": best["plausible"],
                        "verdict": verdict,
                        "table": best["rows"] if best["plausible"] else [],
                    }
                )
    except Exception as exc:  # noqa: BLE001
        fail("extract_failed", f"pdfplumber 抽表失败：{exc}")
    emit({"tables": out})


def cmd_text(path: str, first: int | None, last: int | None) -> None:
    pymupdf = load_fitz()
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001
        fail("cannot_open", f"打不开 PDF：{exc}")
    start = max((first or 1) - 1, 0)
    end = min(last or doc.page_count, doc.page_count)
    chunks = []
    for index in range(start, end):
        page = doc.load_page(index)
        chunks.append(f"\n\n--- p.{index + 1} ---\n" + page.get_text("text").strip())
    doc.close()
    emit({"text": "".join(chunks), "first": start + 1, "last": end})


def main() -> None:
    # 库日志一律去 stderr；emit() 仍写真正的 stdout。
    sys.stdout = sys.stderr
    if len(sys.argv) < 3:
        fail("bad_usage", "用法：pdf-extract.py outline|markdown|text <pdf> [--pages 1-5]")
    command, path = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]

    def flag(name: str) -> str | None:
        return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None

    if command == "outline":
        cmd_outline(path)
    elif command == "markdown":
        cmd_markdown(path, flag("--pages"), flag("--image-dir"))
    elif command == "tables":
        cmd_tables(path, flag("--pages"))
    elif command == "text":
        first = flag("--first")
        last = flag("--last")
        cmd_text(path, int(first) if first else None, int(last) if last else None)
    else:
        fail("bad_usage", f"未知子命令：{command}")


if __name__ == "__main__":
    main()
