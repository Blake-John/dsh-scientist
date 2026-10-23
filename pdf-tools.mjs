// pdf-tools —— 让模型直接读 PDF 的两个原生工具
//
//   pdf_outline  页面画像：页数 / 目录 / 每页文本量与图片数 / 公式风险页 / 无文本层页
//   pdf_read     按页取内容，三种模式：markdown（结构化）/ text（纯文本）/ render（渲染成图）
//
// 分工：先 pdf_outline 判断"该怎么读"，再 pdf_read 只取需要的页——
// 整本转 markdown 会瞬间吃掉几万字符上下文。
//
// 后端：scripts/pdf-extract.py（PyMuPDF / pymupdf4llm）+ poppler（pdftotext / pdftoppm）。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bindAgentCwd } from './vault-core.mjs'

export const name = 'dsh-scientist-pdf'
export const inject = ['tools']

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const EXTRACTOR = join(HERE, 'scripts', 'pdf-extract.py')

const MAX_CHARS = 60000
const MAX_RENDER_PAGES = 5

const tool = ({ name, description, parameters, presentTitle, execute }) => ({
  name,
  description,
  parameters,
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args, exec) {
    return await execute(args ?? {}, exec)
  },
  presentCall: (args) => ({ card: 'generic', title: presentTitle, kind: 'other', rawInput: args }),
})

const resolvePdf = (root, path) => (isAbsolute(path) ? path : resolve(root, path))

/** 项目根：显式 root 优先；相对路径按会话工作区解析。 */
const rootOf = (args, exec) => {
  const base = exec?.cwd ?? process.cwd()
  const raw = typeof args.root === 'string' && args.root ? args.root : base
  return isAbsolute(raw) ? raw : resolve(base, raw)
}

const hasBinary = async (bin) => {
  try {
    await run('which', [bin], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * 从可能混入库日志的 stdout 里取出 JSON。
 * 优先整体解析；否则从后往前找第一行能解析的 `{...}`。
 * （Python 侧已把库日志导到 stderr，这里是第二道保险。）
 */
const parseJsonOutput = (raw) => {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('空输出')
  try {
    return JSON.parse(text)
  } catch {
    /* 继续按行找 */
  }
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* 不是这一行 */
    }
  }
  throw new Error(`输出不是 JSON：${text.slice(0, 120)}`)
}

async function runExtractor(command, pdfPath, extraArgs = []) {
  try {
    const { stdout } = await run('python3', [EXTRACTOR, command, pdfPath, ...extraArgs], {
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const parsed = parseJsonOutput(stdout)
    if (parsed.error) throw new Error(`${parsed.error}: ${parsed.message}`)
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('缺少 python3；PDF 工具需要 PyMuPDF：python3 -m pip install --user pymupdf pymupdf4llm')
    }
    if (error.stdout) {
      let parsed = null
      try {
        parsed = parseJsonOutput(error.stdout)
      } catch {
        /* 不是 JSON，走下面的通用错误 */
      }
      if (parsed?.error) throw new Error(`${parsed.error}: ${parsed.message}`)
    }
    throw new Error(`PDF 处理失败：${error.message}`)
  }
}

const parsePages = (raw) => {
  if (Array.isArray(raw) && raw.length) return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n))
  if (typeof raw === 'string' && raw.trim()) {
    const out = []
    for (const chunk of raw.split(',')) {
      const part = chunk.trim()
      if (!part) continue
      if (part.includes('-')) {
        const [a, b] = part.split('-').map((s) => Number(s.trim()))
        if (Number.isFinite(a) && Number.isFinite(b)) for (let p = a; p <= b; p += 1) out.push(p)
      } else if (Number.isFinite(Number(part))) out.push(Number(part))
    }
    return out
  }
  return []
}

export function apply(ctx) {
  const register = (def) => ctx.tools.register(bindAgentCwd(ctx, def))
  // ── 画像 ──────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'pdf_outline',
      description:
        'PDF 页面画像：页数、目录、每页文本量与图片数、公式风险页、无文本层页（扫描件）。' +
        '读任何 PDF 之前先调它，再决定「读哪几页、用什么模式读」，避免整本转换吃掉几万字符。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'PDF 路径（相对项目根或绝对路径）' },
          root: { type: 'string', description: '项目根目录，默认会话工作区' },
        },
        required: ['path'],
      },
      presentTitle: 'PDF 页面画像',
      async execute(args, exec) {
        const pdf = resolvePdf(rootOf(args, exec), args.path)
        if (!existsSync(pdf)) throw new Error(`文件不存在：${pdf}`)
        const data = await runExtractor('outline', pdf)

        const lines = [
          `文件 ${args.path}`,
          `页数 ${data.pages} · 文本层 ${data.hasTextLayer ? '有' : '**无（扫描件，需渲染 + 视觉阅读）**'} · 平均 ${data.avgCharsPerPage} 字/页`,
        ]
        if (data.toc?.length) {
          lines.push('', `目录（${data.toc.length} 项）：`)
          for (const item of data.toc.slice(0, 40)) {
            lines.push(`${'  '.repeat(Math.max(item.level - 1, 0))}· ${item.title} (p.${item.page})`)
          }
          if (data.toc.length > 40) lines.push(`  …还有 ${data.toc.length - 40} 项`)
        }
        if (data.suspectFormulaPages?.length) {
          lines.push('', `公式符号密集页（文本层不可信，建议 render 后视觉核对）：p.${data.suspectFormulaPages.join(', p.')}`)
        }
        if (data.emptyTextPages?.length) {
          lines.push(`无文本层页（必须 render）：p.${data.emptyTextPages.join(', p.')}`)
        }
        const tablePages = Object.entries(data.tablePages ?? {})
        if (tablePages.length) {
          lines.push(
            '',
            `含表格页（${tablePages.length} 页）：` +
              tablePages.map(([p, n]) => `p.${p}(${n})`).join(', ') +
              '\n  注意：自动抽表在这类论文上常失败（列边界/倒序/碎片），可靠性由 pdf_read mode:"table" 判定；' +
              '关键表格请用 mode:"render" 看图。',
          )
        }
        const dense = data.perPage.filter((p) => p.chars > 4000).map((p) => p.page)
        if (dense.length) lines.push(`文字密集页（>4000 字，建议分页读）：p.${dense.slice(0, 20).join(', p.')}`)

        lines.push('', '下一步：pdf_read(path, pages:"1-3", mode:"markdown") 取正文；公式页用 mode:"render" 后交给 read_image。')
        return lines.join('\n')
      },
    }),
  )

  // ── 取内容 ────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'pdf_read',
      description:
        '按页读取 PDF 内容，四种模式：' +
        'markdown（pymupdf4llm 结构化，保留标题层级，默认）/ text（纯文本，保留版式）/ ' +
        'render（整页渲染成 PNG，供 read_image 视觉阅读公式、图表、扫描页）/ table（表格抽取，带可用性判定）。' +
        'markdown 模式下 images:"extract" 会把图片落盘并给出路径。默认只读前 5 页。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'PDF 路径' },
          pages: {
            type: 'string',
            description: '页范围，如 "1-3"、"1,4,7"、"5-"（从 5 到末页）；缺省 1-5',
          },
          mode: {
            type: 'string',
            enum: ['markdown', 'text', 'render', 'table'],
            description: '默认 markdown；table 为表格抽取（带可用性判定）',
          },
          images: {
            type: 'string',
            enum: ['omit', 'extract'],
            description: 'markdown 模式下图片处理：omit 只留占位符（默认）/ extract 落盘并把路径写进结果，供 read_image 查看',
          },
          dpi: { type: 'number', description: 'render 模式的 DPI，默认 200；小字号公式用 300' },
          max_chars: { type: 'number', description: '文本输出上限，默认 60000 字符' },
          root: { type: 'string', description: '项目根目录，默认会话工作区' },
        },
        required: ['path'],
      },
      presentTitle: '读取 PDF 内容',
      async execute(args, exec) {
        const root = rootOf(args, exec)
        const pdf = resolvePdf(root, args.path)
        if (!existsSync(pdf)) throw new Error(`文件不存在：${pdf}`)
        const mode = args.mode ?? 'markdown'

        // 先把页范围归一化为 1 起数组
        let wanted = parsePages(args.pages)
        if (!wanted.length) wanted = [1, 2, 3, 4, 5]
        if (String(args.pages ?? '').endsWith('-')) {
          const outline = await runExtractor('outline', pdf)
          const last = outline.pages
          const start = wanted[0] ?? 1
          wanted = []
          for (let p = start; p <= last; p += 1) wanted.push(p)
        }
        const first = Math.min(...wanted)
        const last = Math.max(...wanted)

        if (mode === 'render') {
          if (wanted.length > MAX_RENDER_PAGES) {
            throw new Error(`render 一次最多 ${MAX_RENDER_PAGES} 页（请求了 ${wanted.length} 页）；请缩小范围`)
          }
          const dpi = Number(args.dpi ?? 200)
          const outDir = join(root, '.pdf-render')  // 固定落在项目根下，避免污染全局临时目录
          await rm(outDir, { recursive: true, force: true })
          await run('mkdir', ['-p', outDir])
          await run(
            'pdftoppm',
            ['-png', '-r', String(dpi), '-f', String(first), '-l', String(last), pdf, join(outDir, 'page')],
            { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
          ).catch((error) => {
            throw new Error(`pdftoppm 渲染失败：${error.message}（需要 poppler-utils）`)
          })
          const files = (await readdir(outDir)).filter((f) => f.endsWith('.png')).sort()
          return [
            `已渲染 ${files.length} 页（${dpi} dpi）到 ${outDir}/：`,
            ...files.map((f) => `  ${join(outDir, f)}`),
            '',
            '把上面的路径交给 read_image 即可视觉阅读（公式、图表、扫描页）。',
          ].join('\n')
        }

        if (mode === 'table') {
          const data = await runExtractor('tables', pdf, ['--pages', wanted.join(',')])
          const tables = data.tables ?? []
          if (!tables.length) {
            return `p.${first}-${last} 未检测到表格。\n若确信有表，用 mode:"render" 渲染该页后视觉核对。`
          }
          const blocks = tables.map((t) => {
            if (!t.reliable) {
              return `### p.${t.page} 表格（${t.rows}×${t.cols}）— **抽取不可靠，未输出**\n原因：${t.verdict}\n→ 用 pdf_read(pages:"${t.page}", mode:"render", dpi:300) 渲染后交给 read_image 读数。`
            }
            const esc = (cell) => String(cell ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
            const rows = t.table
            const width = Math.max(...rows.map((r) => r.length))
            const pad = (r) => [...r, ...Array(width - r.length).fill('')].map(esc)
            const [head, ...body] = rows
            const md = [
              `| ${pad(head).join(' | ')} |`,
              `| ${Array(width).fill('---').join(' | ')} |`,
              ...body.map((r) => `| ${pad(r).join(' | ')} |`),
            ].join('\n')
            return `### p.${t.page} 表格（${t.rows}×${t.cols}，策略 ${t.strategy}，填充率 ${t.fill}）\n${md}\n\n⚠ 自动抽取，务必核对 2–3 个单元格（表头、最大值、单位）；关键数字请用 render 模式复核。`
          })
          return `（${args.path} · p.${first}-${last} · table）\n\n${blocks.join('\n\n')}`
        }

        const limit = Math.min(Number(args.max_chars ?? MAX_CHARS), 200000)
        let text = ''
        let imageNote = ''
        if (mode === 'text') {
          if (await hasBinary('pdftotext')) {
            const { stdout } = await run('pdftotext', ['-layout', '-f', String(first), '-l', String(last), pdf, '-'], {
              timeout: 120000,
              maxBuffer: 64 * 1024 * 1024,
            })
            // pdftotext 用换页符 \f 分页；转成显式页码，与 Python 兜底输出保持一致
            text = stdout
              .split('\f')
              .map((chunk, index) => (chunk.trim() ? `\n--- p.${first + index} ---\n${chunk.trimEnd()}` : ''))
              .join('')
          } else {
            const data = await runExtractor('text', pdf, ['--first', String(first), '--last', String(last)])
            text = data.text
          }
        } else {
          const extractImages = args.images === 'extract'
          const imageDir = join(root, '.pdf-assets')
          const extra = ['--pages', wanted.join(',')]
          if (extractImages) {
            await rm(imageDir, { recursive: true, force: true })
            await run('mkdir', ['-p', imageDir])
            extra.push('--image-dir', imageDir)
          }
          const data = await runExtractor('markdown', pdf, extra)
          text = data.markdown
          if (extractImages) {
            const images = data.images ?? []
            imageNote =
              images.length
                ? `\n\n---\n本页图片已落盘（${images.length} 个），用 read_image 查看：\n${images.map((f) => `  ${f}`).join('\n')}`
                : '\n\n---\n本页未检出位图（矢量图不会导出；用 mode:"render" 整页渲染）'
          }
        }

        const header = `（${args.path} · p.${first}-${last} · ${mode}）`
        if (text.length <= limit) return `${header}\n\n${text}${imageNote}`
        return (
          `${header}\n\n${text.slice(0, limit)}\n\n` +
          `…输出已截断（全文 ${text.length} 字符，上限 ${limit}）。用 pages 缩小范围继续读，或调大 max_chars。` +
          imageNote
        )
      },
    }),
  )
}
