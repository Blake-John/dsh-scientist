// lit-tools —— 把 lit-core 注册成 4 个原生工具（替代 paper-search-mcp 的 57 个）
//
// 只覆盖当前实测可访问的源：Crossref / arXiv / PubMed / Europe PMC / LibGen。
// OpenAlex、Semantic Scholar、Unpaywall 因限流或缺少邮箱未实现（见 lit-core 顶部注释）。

import { isAbsolute, join, resolve } from 'node:path'
import {
  LitError,
  appendBib,
  applySince,
  dedupe,
  fetchPdf,
  formatTable,
  makeCitekey,
  rank,
  resolveDoi,
  searchArxiv,
  searchCrossref,
  searchEuropePmc,
  searchPubmed,
  toBibtex,
  verifyPdf,
} from './lit-core.mjs'
import { projectLayout } from './project-layout.mjs'
import { bindAgentCwd } from './vault-core.mjs'

export const name = 'dsh-scientist-lit'
export const inject = ['tools']

const SEARCHERS = {
  crossref: searchCrossref,
  arxiv: searchArxiv,
  pubmed: searchPubmed,
  europepmc: searchEuropePmc,
}

/** 最小工具定义：与宿主 ToolDefinition 契约一致的必需字段。 */
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

const rootOf = (args, exec) => {
  const base = exec?.cwd ?? process.cwd()
  const raw = typeof args.root === 'string' && args.root ? args.root : base
  return isAbsolute(raw) ? raw : resolve(base, raw)
}

const fmtDoi = (record) =>
  [
    `DOI      ${record.doi ?? '—'}`,
    `标题     ${record.title}`,
    `作者     ${(record.authors ?? []).slice(0, 8).join(', ')}${(record.authors ?? []).length > 8 ? ' …' : ''}`,
    `年份     ${record.year ?? '—'}`,
    `出处     ${record.venue || '—'}`,
    `类型     ${record.type ?? '—'}`,
    record.citations !== undefined ? `被引     ${record.citations}` : null,
    record.license ? `许可     ${record.license}` : null,
    `citekey  ${makeCitekey(record)}`,
  ]
    .filter(Boolean)
    .join('\n')

export function apply(ctx) {
  const register = (def) => ctx.tools.register(bindAgentCwd(ctx, def))
  // ── 检索 ──────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'lit_search',
      description:
        '多源文献检索：Crossref（期刊）、arXiv（预印本）、PubMed（生医）、Europe PMC（生医+OA）。' +
        '并发查询、按 DOI/标题去重、返回带 citekey 的表格与各源状态。' +
        '只返回元数据；取全文用 lit_pdf，写书目用 lit_bib。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description:
              '检索式。arXiv 支持字段前缀（ti: / au: / abs: / cat:），也可直接传 arXiv id（1706.03762）直取；' +
              'Crossref/PubMed 语法原样透传',
          },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['crossref', 'arxiv', 'pubmed', 'europepmc'] },
            description: '数据源，默认 ["crossref","arxiv"]',
          },
          limit: { type: 'number', description: '结果上限，默认 20，最大 50' },
          since: { type: 'number', description: '起始年份（含）' },
          sort: { type: 'string', enum: ['relevance', 'cited', 'date'], description: '排序，默认 relevance' },
        },
        required: ['query'],
      },
      presentTitle: '检索文献',
      async execute(args, exec) {
        const sources = (args.sources?.length ? args.sources : ['crossref', 'arxiv']).map((s) => String(s).toLowerCase())
        const unknown = sources.filter((s) => !SEARCHERS[s])
        if (unknown.length) throw new LitError('bad_input', `未知源：${unknown.join(', ')}`)
        const opts = {
          limit: Math.min(Number(args.limit ?? 20), 50),
          since: args.since,
          sort: args.sort ?? 'relevance',
          signal: exec.signal,
        }
        const settled = await Promise.allSettled(sources.map(async (s) => ({ name: s, rows: await SEARCHERS[s](args.query, opts) })))
        const all = []
        const statuses = []
        settled.forEach((result, i) => {
          const label = sources[i]
          if (result.status === 'fulfilled') {
            all.push(...result.value.rows)
            statuses.push(`${label} ✓ ${result.value.rows.length}`)
          } else {
            const e = result.reason
            statuses.push(`${label} ✗ ${e.code ?? 'error'}${e.retryAfter ? ` retry ${e.retryAfter}s` : ''}`)
          }
        })
        const filtered = applySince(dedupe(all), opts.since)
        const records = rank(filtered, opts.sort).slice(0, opts.limit)
        const sinceNote = opts.since ? ` · 已按年份≥${opts.since} 过滤` : ''
        if (!records.length) {
          return `未找到结果（${statuses.join(' / ')}${sinceNote}）\n建议：换同义术语、放宽 since、或加源（europepmc / pubmed）`
        }
        return `找到 ${records.length} 条（${statuses.join(' / ')}${sinceNote}）\n\n${formatTable(records, { limit: opts.limit })}\n\n下一步：lit_doi <doi> 核对元数据 · lit_bib <doi> 写书目 · lit_pdf <doi> 取全文`
      },
    }),
  )

  // ── 元数据 ────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'lit_doi',
      description:
        '按 DOI 取权威元数据（Crossref 为准，查不到退 Europe PMC）：标题、作者、年份、出处、类型、被引、许可、citekey。' +
        '用于核对引用、补全 bib 缺失字段、判断有无 OA 副本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { doi: { type: 'string', description: 'DOI，支持 10.xxxx/yyy 或 doi.org 链接' } },
        required: ['doi'],
      },
      presentTitle: '解析 DOI',
      async execute(args, exec) {
        const record = await resolveDoi(args.doi, { signal: exec.signal })
        return fmtDoi(record)
      },
    }),
  )

  // ── 书目 ──────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'lit_bib',
      description:
        '按 DOI 生成 BibTeX 条目并（默认）追加到 knowledge/literature/references.bib。' +
        '按 DOI 幂等去重；缺 author/title/year 时不编造，写入 % TODO 注释并在返回里列出待补项。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          doi: { type: 'string', description: 'DOI' },
          out: { type: 'string', description: 'bib 文件路径（相对 root），默认 knowledge/literature/references.bib' },
          citekey: { type: 'string', description: '自定义 citekey；缺省自动生成' },
          write: { type: 'boolean', description: '是否写入文件，默认 true；false 只返回条目' },
          root: { type: 'string', description: '项目根目录，默认会话工作区' },
        },
        required: ['doi'],
      },
      presentTitle: '生成书目条目',
      async execute(args, exec) {
        const record = await resolveDoi(args.doi, { signal: exec.signal })
        const citekey = args.citekey || makeCitekey(record)
        const bib = toBibtex(record, citekey)
        const warn = bib.problems.length ? `\n\n⚠ 待补：${bib.problems.join('；')}` : ''
        if (args.write === false) return `${bib.entry}${warn}`
        const root = rootOf(args, exec)
        const layout = await projectLayout(root)
        const rel = args.out ?? layout.bib
        const path = rel.startsWith('/') ? rel : join(root, rel)
        const result = await appendBib(path, { entry: bib.entry, doi: record.doi })
        return result.added
          ? `✓ 已写入 ${path}\ncitekey: ${citekey}${warn}`
          : `· 该 DOI 已在 ${path} 中，未重复追加\ncitekey: ${citekey}${warn}`
      },
    }),
  )

  // ── 全文 ──────────────────────────────────────────────────────────────────
  register(
    tool({
      name: 'lit_pdf',
      description:
        '取论文全文 PDF 并落到本地：arXiv（有 arXiv id 时优先）→ LibGen（仅按 DOI 精确匹配，会校验 edition 页 DOI）。' +
        '保存为 knowledge/literature/pdfs/<citekey>.pdf，校验 %PDF 魔数与页数。' +
        '不做 sci-hub。拿不到时返回各路线失败原因与建议。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          doi: { type: 'string', description: 'DOI（与 arxiv_id 二选一）' },
          arxiv_id: { type: 'string', description: 'arXiv id，如 1706.03762' },
          out_dir: { type: 'string', description: '输出目录（相对 root），默认 knowledge/literature/pdfs' },
          citekey: { type: 'string', description: '文件名用 citekey；缺省自动生成' },
          root: { type: 'string', description: '项目根目录，默认会话工作区' },
        },
      },
      presentTitle: '获取论文全文',
      async execute(args, exec) {
        if (!args.doi && !args.arxiv_id) throw new LitError('bad_input', '需要 doi 或 arxiv_id')
        const root = rootOf(args, exec)
        let citekey = args.citekey
        if (!citekey && args.doi) {
          const meta = await resolveDoi(args.doi, { signal: exec.signal }).catch(() => null)
          if (meta) citekey = makeCitekey(meta)
        }
        if (!citekey && args.arxiv_id) citekey = `arxiv${String(args.arxiv_id).replace(/[^0-9a-z]/gi, '')}`
        const layout = await projectLayout(root)
        const rawOut = args.out_dir ?? layout.pdfs
        const outDir = isAbsolute(rawOut) ? rawOut : join(root, rawOut)
        try {
          const result = await fetchPdf({ doi: args.doi, arxivId: args.arxiv_id, outDir, citekey, signal: exec.signal, cacheRoot: root })
          const check = await verifyPdf(result.path)
          return (
            `✓ 已下载 ${result.path}\n` +
            `  来源 ${result.source} · ${(result.bytes / 1024 / 1024).toFixed(2)} MB · ${check.pages ?? '?'} 页 · ` +
            `${check.ok ? 'PDF 校验通过' : `校验失败：${check.reason}`}\n` +
            `  下一步：用 pdf-reading 技能解析正文（pymupdf4llm）`
          )
        } catch (error) {
          if (!(error instanceof LitError)) throw error
          const attempts = (error.attempts ?? []).map((a) => `  · ${a}`).join('\n')
          return `✗ ${error.message}\n${attempts}\n提示：${error.hint ?? '确认 DOI 有 OA 副本；或手动下载后放入 knowledge/literature/pdfs/'}`
        }
      },
    }),
  )
}
