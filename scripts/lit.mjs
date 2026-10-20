#!/usr/bin/env node
/**
 * lit —— 文献检索 / 取全文 / 生成书目的命令行（薄壳，逻辑全在 lit-core.mjs）
 *
 * 用法：
 *   lit search "<query>" [--sources crossref,arxiv] [--limit 20] [--since 2020]
 *                        [--sort relevance|cited|date] [--json] [--no-cache]
 *   lit doi <doi>                                             [--json]
 *   lit bib <doi> [--out literature/references.bib] [--no-write] [--citekey k] [--json]
 *   lit pdf <doi>                                             [--out data/papers] [--citekey k]
 *   lit pdf --arxiv-id 1706.03762                             [--out data/papers]
 *   lit doctor                                                实测各源可用性
 *
 * 全局：--root <dir>（默认 cwd）
 */
import {
  LitError,
  appendBib,
  applySince,
  dedupe,
  fetchPdf,
  formatTable,
  libgenFind,
  makeCitekey,
  rank,
  resolveDoi,
  searchArxiv,
  searchCrossref,
  searchEuropePmc,
  searchPubmed,
  toBibtex,
  verifyPdf,
} from '../lit-core.mjs'

const argv = process.argv.slice(2)
const command = argv.shift()

const flags = {}
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (token.startsWith('--')) {
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[name] = true
    else (flags[name] = next), (i += 1)
  } else {
    ;(flags._ ??= []).push(token)
  }
}

const root = String(flags.root ?? process.cwd())
const positional = flags._ ?? []
const jsonOut = Boolean(flags.json)
const limit = Number(flags.limit ?? 20)

const say = (value) => (jsonOut ? console.log(JSON.stringify(value, null, 2)) : console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)))

const pickSources = (raw) =>
  String(raw ?? 'crossref,arxiv')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

const SEARCHERS = {
  crossref: searchCrossref,
  arxiv: searchArxiv,
  pubmed: searchPubmed,
  europepmc: searchEuropePmc,
}

async function runSearch(query) {
  const sources = pickSources(flags.sources)
  const unknown = sources.filter((s) => !SEARCHERS[s])
  if (unknown.length) throw new LitError('bad_input', `未知源：${unknown.join(', ')}（可用：${Object.keys(SEARCHERS).join(', ')}）`)
  if (!query) throw new LitError('bad_input', '缺少查询字符串')

  const opts = {
    limit,
    since: flags.since ? Number(flags.since) : undefined,
    sort: flags.sort ?? 'relevance',
  }
  const statuses = []
  const settled = await Promise.allSettled(
    sources.map(async (name) => {
      const start = Date.now()
      const rows = await SEARCHERS[name](query, opts)
      return { name, rows, ms: Date.now() - start }
    }),
  )

  const all = []
  settled.forEach((result, i) => {
    const name = sources[i]
    if (result.status === 'fulfilled') {
      all.push(...result.value.rows)
      statuses.push({ name, ok: true, detail: `${result.value.rows.length} 条 ${result.value.ms}ms` })
    } else {
      const error = result.reason
      statuses.push({ name, ok: false, detail: `${error.code ?? 'error'}${error.retryAfter ? ` retry ${error.retryAfter}s` : ''}` })
    }
  })

  const filtered = applySince(dedupe(all), opts.since)
  const records = rank(filtered, opts.sort).slice(0, limit)
  const sinceNote = opts.since ? `；已按年份≥${opts.since} 过滤` : ''
  if (jsonOut) return say({ query, statuses, count: records.length, records })

  console.log(`找到 ${records.length} 条（${statuses.map((s) => `${s.name} ${s.ok ? '✓' : '✗'} ${s.detail}`).join(' / ')}${sinceNote}）\n`)
  if (records.length) console.log(formatTable(records, { limit }))
  if (records.length) console.log('\n下一步：lit doi <doi> 核对元数据；lit bib <doi> 写入书目；lit pdf <doi> 取全文')
}

async function runDoi(doi) {
  if (!doi) throw new LitError('bad_input', '缺少 DOI')
  const record = await resolveDoi(doi)
  if (jsonOut) return say(record)
  console.log(`DOI      ${record.doi}`)
  console.log(`标题     ${record.title}`)
  console.log(`作者     ${(record.authors ?? []).slice(0, 8).join(', ')}${(record.authors ?? []).length > 8 ? ' …' : ''}`)
  console.log(`年份     ${record.year ?? '—'}`)
  console.log(`出处     ${record.venue || '—'}`)
  console.log(`类型     ${record.type ?? '—'}`)
  if (record.citations !== undefined) console.log(`被引     ${record.citations}`)
  if (record.license) console.log(`许可     ${record.license}`)
  console.log(`citekey  ${makeCitekey(record)}`)
}

async function runBib(doi) {
  if (!doi) throw new LitError('bad_input', '缺少 DOI')
  const record = await resolveDoi(doi)
  const citekey = flags.citekey ? String(flags.citekey) : makeCitekey(record)
  const bib = toBibtex(record, citekey)
  const outPath = String(flags.out ?? 'literature/references.bib')

  if (flags['no-write']) {
    if (jsonOut) return say({ ...bib, record, written: false })
    console.log(bib.entry)
    if (bib.problems.length) console.error(`\n⚠ 待补：${bib.problems.join('；')}`)
    return
  }
  const abs = outPath.startsWith('/') ? outPath : `${root}/${outPath}`
  const result = await appendBib(abs, { entry: bib.entry, doi: record.doi })
  if (jsonOut) return say({ ...bib, record, written: result.added, path: result.path })
  console.log(result.added ? `✓ 已写入 ${result.path}` : `· 已存在，未重复追加（${result.path}）`)
  console.log(`citekey: ${citekey}`)
  if (bib.problems.length) console.error(`⚠ 待补：${bib.problems.join('；')}`)
}

async function runPdf() {
  const doi = positional[0]
  const arxivId = flags['arxiv-id']
  if (!doi && !arxivId) throw new LitError('bad_input', '需要 DOI 或 --arxiv-id')
  let citekey = flags.citekey ? String(flags.citekey) : undefined
  if (!citekey && doi) {
    const meta = await resolveDoi(doi).catch(() => null)
    if (meta) citekey = makeCitekey(meta)
  }
  if (!citekey && arxivId) citekey = `arxiv${String(arxivId).replace(/[^0-9a-z]/gi, '')}`
  const outDir = String(flags.out ?? 'data/papers')
  const absOut = outDir.startsWith('/') ? outDir : `${root}/${outDir}`

  try {
    const result = await fetchPdf({ doi, arxivId, outDir: absOut, citekey, cacheRoot: root })
    const check = await verifyPdf(result.path)
    if (jsonOut) return say({ ...result, verify: check })
    console.log(`✓ 已下载 ${result.path}`)
    console.log(`  来源 ${result.source} · ${(result.bytes / 1024 / 1024).toFixed(2)} MB · ${check.pages ?? '?'} 页 · ${check.ok ? 'PDF 校验通过' : `校验失败: ${check.reason}`}`)
  } catch (error) {
    if (!(error instanceof LitError)) throw error
    if (jsonOut) return say({ error: error.code, message: error.message, attempts: error.attempts, hint: error.hint })
    console.error(`✗ ${error.message}`)
    for (const a of error.attempts ?? []) console.error(`  · ${a}`)
    if (error.hint) console.error(`  提示：${error.hint}`)
    process.exitCode = 1
  }
}

async function runDoctor() {
  const checks = [
    ['Crossref', async () => {
      const rows = await searchCrossref('attention', { limit: 1 })
      return `${rows.length} 条`
    }],
    ['arXiv', async () => {
      const rows = await searchArxiv('attention', { limit: 1 })
      return `${rows.length} 条`
    }],
    ['PubMed', async () => {
      const rows = await searchPubmed('attention', { limit: 1 })
      return `${rows.length} 条`
    }],
    ['Europe PMC', async () => {
      const rows = await searchEuropePmc('attention', { limit: 1 })
      return `${rows.length} 条`
    }],
    ['LibGen（DOI 探针）', async () => {
      const hit = await libgenFind('10.1038/nature14539')
      return hit ? `命中 ${hit.md5.slice(0, 8)}…` : '无条目'
    }],
  ]
  const rows = []
  for (const [name, fn] of checks) {
    const start = Date.now()
    try {
      const detail = await fn()
      rows.push({ name, ok: true, ms: Date.now() - start, detail })
    } catch (error) {
      rows.push({ name, ok: false, ms: Date.now() - start, detail: `${error.code ?? 'error'}: ${error.message}` })
    }
  }
  if (jsonOut) return say(rows)
  console.log('源可用性实测（2026-10 环境）\n')
  for (const row of rows) {
    console.log(`  ${row.ok ? '✓' : '✗'} ${row.name.padEnd(20)} ${String(row.ms).padStart(6)}ms  ${row.detail}`)
  }
  const failed = rows.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} 个源不可用` : '\n全部可用')
}

const main = async () => {
  try {
    if (command === 'search') return await runSearch(positional.join(' '))
    if (command === 'doi') return await runDoi(positional[0])
    if (command === 'bib') return await runBib(positional[0])
    if (command === 'pdf') return await runPdf()
    if (command === 'doctor') return await runDoctor()
    if (command === '--help' || command === '-h' || command === undefined) {
      console.log(`
lit search "<query>" [--sources crossref,arxiv] [--limit 20] [--since 2020] [--sort relevance|cited|date] [--json]
lit doi <doi> [--json]
lit bib <doi> [--out literature/references.bib] [--no-write] [--citekey k] [--json]
lit pdf <doi> [--out data/papers] [--citekey k]
lit pdf --arxiv-id 1706.03762 [--out data/papers]
lit doctor [--json]
全局：--root <dir>`)
      return
    }
    console.error('用法：lit search|doi|bib|pdf|doctor …（--help 查看详情）')
    process.exitCode = 2
  } catch (error) {
    if (error instanceof LitError) {
      console.error(`✗ [${error.code}] ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }
}

await main()
