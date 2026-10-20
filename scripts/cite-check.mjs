#!/usr/bin/env node
/**
 * cite-check — 参考文献闭环校验（零依赖）
 *
 * 做四件事：
 *   1. 解析 literature/references.bib，按条目类型检查必填字段。
 *   2. 有 DOI 的条目去 Crossref 核对元数据（标题相似度、年份、第一作者姓）。
 *   3. 扫描 markdown 里的 key 式引用（[@key] / \cite{key}），报告"引用了但 bib 里没有"。
 *   4. 报告"bib 里有但正文没引用"（仅警告，可能是待引）。
 *
 * 用法：
 *   node scripts/cite-check.mjs [--root <项目根>] [--no-network] [--json] [--max-lookups 50]
 *
 * 退出码：0 无错误（可有警告）；1 有错误；2 用法/IO 错误。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`cite-check —— 校验参考文献与正文引用的一致性

用法：cite-check [--root <项目根>]

检查：
  · references.bib 每条必填字段是否齐全（author/title/year/venue）
  · DOI 是否能在 Crossref / DataCite 解析到（需联网）
  · 正文里的 [@citekey] 是否都能在 bib 中找到
  · bib 里的条目是否都被正文引用（未引用会被提示）
`)
  process.exit(0)
}
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : fallback
}
const ROOT = resolve(String(flag('root', process.cwd())))
const NO_NETWORK = Boolean(flag('no-network', false))
const JSON_OUT = Boolean(flag('json', false))
const MAX_LOOKUPS = Number(flag('max-lookups', 50))

const errors = []
const warnings = []
const infos = []

const REQUIRED = {
  article: ['author', 'title', 'journal', 'year'],
  book: ['author', 'title', 'publisher', 'year'],
  inproceedings: ['author', 'title', 'booktitle', 'year'],
  conference: ['author', 'title', 'booktitle', 'year'],
  phdthesis: ['author', 'title', 'school', 'year'],
  mastersthesis: ['author', 'title', 'school', 'year'],
  techreport: ['author', 'title', 'institution', 'year'],
  misc: ['title'],
  online: ['title', 'url'],
  preprint: ['author', 'title', 'year'],
  unpublished: ['author', 'title'],
}

// ── BibTeX 解析（平衡花括号/引号，够用且不引第三方依赖）────────────────────
function parseBib(text) {
  const entries = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at < 0) break
    const m = /^@([A-Za-z]+)\s*([{(])/.exec(text.slice(at, at + 40))
    if (!m) { i = at + 1; continue }
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') { i = at + m[0].length; continue }
    const close = m[2] === '{' ? '}' : ')'
    let j = at + m[0].length
    // key 到第一个逗号
    const comma = text.indexOf(',', j)
    const end = findClose(text, at + m[0].length - 1)
    if (comma < 0 || end < 0) { i = at + 1; continue }
    const key = text.slice(j, comma).trim()
    const fields = {}
    let k = comma + 1
    while (k < end) {
      while (k < end && /[\s,]/.test(text[k])) k += 1
      const eq = text.indexOf('=', k)
      if (eq < 0 || eq > end) break
      const name = text.slice(k, eq).trim().toLowerCase()
      let v = eq + 1
      while (v < end && /\s/.test(text[v])) v += 1
      let value = ''
      if (text[v] === '{') {
        const stop = findClose(text, v)
        value = text.slice(v + 1, stop)
        k = stop + 1
      } else if (text[v] === '"') {
        const stop = text.indexOf('"', v + 1)
        value = text.slice(v + 1, stop)
        k = stop + 1
      } else {
        const stop = text.indexOf(',', v)
        value = text.slice(v, stop < 0 ? end : stop)
        k = stop < 0 ? end : stop
      }
      if (name) fields[name] = clean(value)
    }
    entries.push({ type, key, fields })
    i = end + 1
  }
  return entries
}

function findClose(text, openIndex) {
  const open = text[openIndex]
  const close = open === '{' ? '}' : open === '(' ? ')' : null
  if (!close) return -1
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1
    else if (text[i] === close) { depth -= 1; if (depth === 0) return i }
  }
  return -1
}

const clean = (v) => v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()

// ── 元数据比较 ─────────────────────────────────────────────────────────────
const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const similarity = (a, b) => {
  const A = new Set(normalize(a).split(' ').filter(Boolean))
  const B = new Set(normalize(b).split(' ').filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit += 1
  return hit / Math.max(A.size, B.size)
}

const firstAuthorSurname = (authorField) => {
  const first = String(authorField ?? '').split(' and ')[0] ?? ''
  if (first.includes(',')) return first.split(',')[0].trim()
  const parts = first.trim().split(/\s+/)
  return parts[parts.length - 1] ?? ''
}

// DOI 注册机构分流：arXiv/Zenodo 等走 DataCite，其余走 Crossref。
const crossref = async (doi) => {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'dsh-scientist-cite-check/1.0 (mailto:noreply@example.com)' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`)
  const data = await response.json()
  const m = data.message ?? {}
  return {
    title: Array.isArray(m.title) ? m.title[0] : m.title,
    year: m.issued?.['date-parts']?.[0]?.[0],
    firstAuthor: m.author?.[0]?.family ?? m.author?.[0]?.name,
    type: m.type,
    registry: 'Crossref',
  }
}

const datacite = async (doi) => {
  const url = `https://api.datacite.org/dois/${encodeURIComponent(doi)}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'dsh-scientist-cite-check/1.0 (mailto:noreply@example.com)' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`DataCite HTTP ${response.status}`)
  const data = await response.json()
  const a = data.data?.attributes ?? {}
  return {
    title: a.titles?.[0]?.title,
    year: a.publicationYear,
    firstAuthor: a.creators?.[0]?.familyName ?? a.creators?.[0]?.name,
    type: a.types?.resourceTypeGeneral,
    registry: 'DataCite',
  }
}

const lookupDoi = (doi) =>
  /^10\.48550\//i.test(doi) || /^10\.5281\//i.test(doi) ? datacite(doi) : crossref(doi)

// ── markdown 扫描 ──────────────────────────────────────────────────────────
const CITE_PATTERNS = [
  /\[@([A-Za-z0-9_:.#$%&+?<>~/-]+)\]/g, // pandoc: [@key] / [@key; @other]
  /\\cite[tp]?\{([^}]+)\}/g,             // LaTeX: \cite{key, other}
]

async function* walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'data', 'artifacts', 'envs'].includes(entry.name)) continue
      yield* walk(path)
    } else if (/\.(md|tex)$/i.test(entry.name)) {
      yield path
    }
  }
}

const main = async () => {
  const bibPath = join(ROOT, 'literature', 'references.bib')
  const bibExists = await stat(bibPath).then(() => true, () => false)
  if (!bibExists) {
    console.error(`✗ 找不到 ${bibPath}（先在 literature/references.bib 建书目）`)
    process.exit(2)
  }
  const entries = parseBib(await readFile(bibPath, 'utf8'))
  if (entries.length === 0) {
    console.error(`✗ ${bibPath} 里没有解析到任何条目`)
    process.exit(2)
  }
  infos.push(`bib 条目: ${entries.length}`)

  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.key)) errors.push(`重复 citekey: ${entry.key}`)
    seen.add(entry.key)
    const required = REQUIRED[entry.type] ?? ['title']
    for (const field of required) {
      if (!entry.fields[field]) errors.push(`${entry.key}: ${entry.type} 缺必填字段 ${field}`)
    }
    if (!entry.fields.year && entry.type !== 'misc') warnings.push(`${entry.key}: 无 year`)
    if (!entry.fields.doi && !entry.fields.url && !entry.fields.eprint) {
      warnings.push(`${entry.key}: 无 doi/url/eprint，无法溯源`)
    }
  }

  // Crossref 核对
  if (!NO_NETWORK) {
    const withDoi = entries.filter((e) => e.fields.doi).slice(0, MAX_LOOKUPS)
    if (entries.filter((e) => e.fields.doi).length > MAX_LOOKUPS) {
      warnings.push(`DOI 核对上限 ${MAX_LOOKUPS} 条（--max-lookups 可调）`)
    }
    for (const entry of withDoi) {
      const doi = entry.fields.doi.replace(/^https?:\/\/doi\.org\//i, '')
      try {
        const meta = await lookupDoi(doi)
        const titleScore = similarity(entry.fields.title, meta.title)
        if (titleScore < 0.6) {
          errors.push(`${entry.key}: DOI ${doi} 的 ${meta.registry} 标题与 bib 不符（相似度 ${titleScore.toFixed(2)}）: "${meta.title}"`)
        }
        const year = Number(String(entry.fields.year ?? '').match(/\d{4}/)?.[0])
        if (year && meta.year && Math.abs(year - Number(meta.year)) > 1) {
          errors.push(`${entry.key}: 年份不符（bib ${year} vs ${meta.registry} ${meta.year}）`)
        }
        const surname = firstAuthorSurname(entry.fields.author)
        if (surname && meta.firstAuthor && similarity(surname, meta.firstAuthor) < 0.5) {
          warnings.push(`${entry.key}: 第一作者姓可能不符（bib "${surname}" vs ${meta.registry} "${meta.firstAuthor}"）`)
        }
      } catch (error) {
        warnings.push(`${entry.key}: DOI ${doi} 查询失败（${error.message}）`)
      }
      await new Promise((r) => setTimeout(r, 120)) // 对 Crossref 友好
    }
  } else {
    infos.push('已跳过 Crossref 核对（--no-network）')
  }

  // 正文引用
  const cited = new Set()
  let scanned = 0
  for await (const file of walk(ROOT)) {
    const text = await readFile(file, 'utf8')
    scanned += 1
    for (const pattern of CITE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        for (const raw of match[1].split(/[;,]/)) {
          const key = raw.trim().replace(/^@/, '')
          if (key) cited.add(key)
        }
      }
    }
  }
  infos.push(`扫描文件: ${scanned}，发现 key 式引用: ${cited.size}`)

  for (const key of cited) if (!seen.has(key)) errors.push(`正文引用了不存在的 citekey: ${key}`)
  if (cited.size === 0) {
    warnings.push('未发现 key 式引用（[@key] / \\cite{key}）：若报告用编号制引用，本检查只能覆盖 bib 完整性')
  } else {
    for (const key of seen) if (!cited.has(key)) warnings.push(`${key}: bib 里有但正文未引用`)
  }

  // ── 输出 ────────────────────────────────────────────────────────────────
  if (JSON_OUT) {
    console.log(JSON.stringify({ root: ROOT, errors, warnings, infos }, null, 2))
  } else {
    console.log(`cite-check: ${ROOT}`)
    for (const line of infos) console.log(`  · ${line}`)
    for (const line of warnings) console.log(`  ⚠ ${line}`)
    for (const line of errors) console.log(`  ✗ ${line}`)
    console.log(
      `\n${errors.length === 0 ? '✓ 无错误' : `✗ ${errors.length} 个错误`}` +
        (warnings.length ? `，${warnings.length} 个警告` : ''),
    )
  }
  process.exit(errors.length === 0 ? 0 : 1)
}

await main()
