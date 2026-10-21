#!/usr/bin/env node
/**
 * lit-lib —— 文献库管理 CLI（工程化：受控词表 + 结构化记录 + 三方一致性校验）
 *
 * 记录载体：literature/notes/<citekey>.md 的 YAML frontmatter（扁平、可手写）。
 * 设计决定见 docs/lit-vault-plan.md：
 *   · ①标识著录 + ②分类（关键词/标签/时间）为必填
 *   · 不做影响因子（期刊级、有版权）；保留 citations 与 influence_tier
 *   · 不用独立 collections 字段，集合用 tag: collection/<name>
 *   · 入库自动：抓元数据 → 下 PDF → 写 bib
 *
 * 用法：
 *   lit-lib init [--root .]
 *   lit-lib add <doi|arxiv-id> --keywords a,b [--tags x/y] [--no-pdf] [--no-bib] [--draft]
              （不给 --tags 时自动打 status/inbox）
 *   lit-lib list [--tag x/y] [--keyword k] [--year 2020] [--status read_full] [--tier core]
 *                [--role method] [--collection name] [--sort year|citations|citekey] [--limit n]
 *   lit-lib search "<q>"
 *   lit-lib tag <citekey> +ns/v [-ns/v]...
 *   lit-lib set <citekey> field=value
 *   lit-lib stats
 *   lit-lib index
 *   lit-lib check [--fix-hint]
 *
 * 全局：--root <dir>（默认 cwd）
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendBib,
  fetchPdf,
  makeCitekey,
  resolveDoi,
  searchArxiv,
  toBibtex,
} from '../lit-core.mjs'
import { projectLayout } from '../project-layout.mjs'

// ── 字段定义（顺序即渲染顺序）───────────────────────────────────────────────

export const FIELDS = [
  'citekey', 'title', 'authors', 'year', 'venue', 'venue_type',
  'doi', 'arxiv', 'pmid',
  'keywords', 'tags',
  'added', 'published', 'read_at', 'last_verified',
  'citations', 'citations_source', 'citations_snapshot',
  'influence_tier', 'relevance', 'quality', 'confidence', 'role', 'read_status',
  'pdf',
]

export const ARRAY_FIELDS = new Set(['authors', 'keywords', 'tags'])

export const REQUIRED = [
  'citekey', 'title', 'authors', 'year', 'venue', 'venue_type',
  'keywords', 'tags', 'added',
]

export const ENUMS = {
  venue_type: ['journal', 'conference', 'preprint', 'book', 'thesis', 'report'],
  read_status: ['unread', 'abstract', 'skimmed', 'read_full'],
  role: ['method', 'baseline', 'survey', 'dataset', 'theory', 'application'],
  influence_tier: ['landmark', 'core', 'supporting', 'peripheral'],
  confidence: ['high', 'medium', 'low'],
}

const TODAY = () => new Date().toISOString().slice(0, 10)
const DATE_FIELDS = ['added', 'published', 'read_at', 'last_verified', 'citations_snapshot']

/** Crossref/arXiv 的类型 → 我们的 venue_type 枚举 */
function mapVenueType(type, venue) {
  const t = String(type ?? '').toLowerCase()
  if (t.includes('proceedings') || t.includes('conference')) return 'conference'
  if (t.includes('book-chapter') || t.includes('book')) return 'book'
  if (t.includes('thesis') || t.includes('dissertation')) return 'thesis'
  if (t.includes('report')) return 'report'
  if (t.includes('preprint') || t.includes('posted-content')) return 'preprint'
  if (t.includes('journal') || t.includes('article')) return 'journal'
  return venue ? 'journal' : 'preprint'
}

// ── 最小 YAML 子集（扁平 key: value / key: [a, b]）──────────────────────────

export function parseRecord(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2].trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = splitArray(raw.slice(1, -1))
    } else {
      meta[key] = unquoteScalar(raw)
    }
  }
  return { meta, body: text.slice(match[0].length) }
}

/** 数组元素：含逗号/冒号/引号/方括号时必须加双引号，否则会被拆错 */
function yamlArrayItem(value) {
  const text = String(value)
  const needsQuote = /[,\[\]":#\\]/.test(text) || /^\s|\s$/.test(text) || text === ''
  if (!needsQuote) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 还原一个被引号包裹的标量 */
function unquoteScalar(raw) {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

/** 按逗号切数组，但尊重引号内的逗号 */
function splitArray(raw) {
  const parts = []
  let current = ''
  let inQuote = false
  let escaped = false
  for (const ch of raw) {
    if (escaped) {
      current += ch
      escaped = false
    } else if (ch === '\\' && inQuote) {
      current += ch
      escaped = true
    } else if (ch === '"') {
      current += ch
      inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts.map(unquoteScalar).filter((v) => v !== '')
}

/**
 * 把标量写成 YAML 安全形式。
 * 只在这些情况下加双引号：含 YAML 特殊字符、首尾空白、或以特殊符号开头。
 * 关键：**不删除任何字符**——内部 `"` 与 `\` 用反斜杠转义。
 */
function yamlScalar(text) {
  const needsQuote = /[:#\[\]"'\\]/.test(text) || /^\s|\s$/.test(text) || text === ''
  if (!needsQuote) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderRecord(record) {
  const lines = ['---']
  for (const field of FIELDS) {
    const value = record[field]
    if (value === undefined || value === null || value === '') continue
    if (ARRAY_FIELDS.has(value) || Array.isArray(value)) {
      const list = Array.isArray(value) ? value : String(value).split(',')
      lines.push(`${field}: [${list.map((v) => yamlArrayItem(String(v).trim())).filter(Boolean).join(', ')}]`)
    } else {
      lines.push(`${field}: ${yamlScalar(String(value))}`)
    }
  }
  // 保留未定义的额外字段
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('__') || FIELDS.includes(key) || value === undefined || value === null || value === '') continue
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.map(yamlArrayItem).join(', ')}]` : yamlScalar(String(value))}`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${record.__body ?? '\n# 笔记\n\n'}\n`
}

// ── 词表与校验 ──────────────────────────────────────────────────────────────

export function loadTaxonomy(text) {
  // 只解析 keywords（带 children）与 tag_namespaces 的键，够用即可
  const keywords = new Set()
  const namespaces = new Set()
  let section = ''
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = /^keywords:/.test(line) ? 'keywords' : /^tag_namespaces:/.test(line) ? 'namespaces' : ''
      current = null
      continue
    }
    if (section === 'keywords') {
      const top = /^ {2}([a-z0-9-]+):/.exec(line)
      if (top) {
        current = top[1]
        keywords.add(current)
        continue
      }
      const children = /children:\s*\[(.*)\]/.exec(line)
      if (children && current) {
        for (const child of children[1].split(',')) {
          const value = child.trim()
          if (value) keywords.add(value)
        }
      }
    } else if (section === 'namespaces') {
      const ns = /^ {2}([a-z0-9-]+):/.exec(line)
      if (ns) namespaces.add(ns[1])
    }
  }
  return { keywords, namespaces }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateRecord(record, taxonomy, { citekeyFromPath, draft = false } = {}) {
  const errors = []
  const warnings = []
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean))

  if (!draft) {
    for (const field of REQUIRED) {
      const value = record[field]
      const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
      if (empty) errors.push(`缺必填字段 ${field}`)
    }
    if (!record.doi && !record.arxiv && !record.pmid) errors.push('缺标识：doi / arxiv / pmid 至少一个')
  }
  if (citekeyFromPath && record.citekey && record.citekey !== citekeyFromPath) {
    errors.push(`citekey(${record.citekey}) 与文件名(${citekeyFromPath}) 不一致`)
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const value = record[field]
    if (value && !allowed.includes(value)) errors.push(`${field}=${value} 不在枚举 ${allowed.join('|')} 内`)
  }
  if (!/^[a-z][a-z0-9]*$/.test(String(record.citekey ?? ''))) {
    errors.push(`citekey 只能小写字母数字：${record.citekey}`)
  }
  for (const field of DATE_FIELDS) {
    const value = record[field]
    if (value && !DATE_RE.test(value)) errors.push(`${field}=${value} 不是 YYYY-MM-DD`)
  }
  if (record.added && record.read_at && record.read_at < record.added) {
    errors.push('read_at 早于 added')
  }
  const keywords = list(record.keywords)
  if (keywords.length > 8) warnings.push(`keywords ${keywords.length} 个，建议 ≤8`)
  for (const keyword of keywords) {
    if (!taxonomy.keywords.has(keyword)) errors.push(`关键词未登记：${keyword}（加到 literature/taxonomy.yml）`)
  }
  const tags = list(record.tags)
  if (tags.length > 12) warnings.push(`tags ${tags.length} 个，建议 ≤12`)
  for (const tag of tags) {
    const namespace = tag.split('/')[0]
    if (!tag.includes('/')) errors.push(`标签必须带命名空间：${tag}（如 method/${tag}）`)
    else if (!taxonomy.namespaces.has(namespace)) errors.push(`未定义的标签命名空间：${namespace}`)
  }
  if (record.citations_snapshot) {
    const days = (Date.now() - Date.parse(record.citations_snapshot)) / 86400000
    if (days > 180) warnings.push(`引用数快照已 ${Math.round(days)} 天，建议 lit-lib set ${record.citekey} citations=<n>`)
  }
  return { errors, warnings }
}

/**
 * 校验 set 的增量补丁：只检查被改动的字段。
 * 这样既能即时拦住非法值，又不会因为记录别处不完整而阻止用户修正它。
 */
export function validatePatch(patch, taxonomy) {
  const errors = []
  for (const [field, value] of Object.entries(patch)) {
    const values = Array.isArray(value) ? value : [value]
    if (ENUMS[field]) {
      for (const v of values) {
        if (v !== '' && !ENUMS[field].includes(v)) {
          errors.push(`${field}=${v} 不在枚举 ${ENUMS[field].join('|')} 内`)
        }
      }
    }
    if (field === 'keywords') {
      for (const keyword of values) {
        if (keyword && !taxonomy.keywords.has(keyword)) errors.push(`关键词未登记：${keyword}`)
      }
    }
    if (field === 'tags') {
      for (const tag of values) {
        if (!tag) continue
        if (!tag.includes('/')) errors.push(`标签必须带命名空间：${tag}`)
        else if (!taxonomy.namespaces.has(tag.split('/')[0])) errors.push(`未定义的标签命名空间：${tag.split('/')[0]}`)
      }
    }
    if (DATE_FIELDS.includes(field) && value && !DATE_RE.test(String(value))) {
      errors.push(`${field}=${value} 不是 YYYY-MM-DD`)
    }
  }
  return errors
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const paths = async (root) => {
  const layout = await projectLayout(root)
  return {
    dir: join(root, layout.literature),
    notes: join(root, layout.notes),
    taxonomy: join(root, layout.literature, 'taxonomy.yml'),
    bib: join(root, layout.bib),
    index: join(root, layout.literature, 'index.json'),
  }
}

async function loadAll(root) {
  const p = await paths(root)
  const records = []
  if (!existsSync(p.notes)) return records
  for (const file of (await readdir(p.notes)).filter((f) => f.endsWith('.md')).sort()) {
    const text = await readFile(join(p.notes, file), 'utf8')
    const { meta, body } = parseRecord(text)
    records.push({ ...meta, __body: body, __file: join(p.notes, file), __stem: file.replace(/\.md$/, '') })
  }
  return records
}

async function writeRecord(record) {
  await writeFile(record.__file, renderRecord(record))
}

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean))

// ── 命令 ────────────────────────────────────────────────────────────────────

async function cmdInit(root) {
  const p = await paths(root)
  await mkdir(p.notes, { recursive: true })
  if (!existsSync(p.taxonomy)) {
    const template = await readFile(join(dirname(new URL(import.meta.url).pathname), 'taxonomy.template.yml'), 'utf8')
    await writeFile(p.taxonomy, template)
    console.log(`✓ 已创建 ${p.taxonomy}`)
  }
  if (!existsSync(p.bib)) await writeFile(p.bib, '% 由 lit_bib 生成；DOI 去重\n\n')
  console.log(`✓ 文献库就绪：${p.dir}`)
}

async function cmdAdd(root, id, flags) {
  const p = await paths(root)
  await mkdir(p.notes, { recursive: true })
  if (!existsSync(p.taxonomy)) {
    const template = await readFile(join(dirname(new URL(import.meta.url).pathname), 'taxonomy.template.yml'), 'utf8')
    await writeFile(p.taxonomy, template)
    console.log(`  · 已自动初始化词表 ${p.taxonomy}`)
  }

  let meta
  if (String(id).includes('/') && !/^\d{4}\.\d{4,5}/.test(id)) {
    meta = await resolveDoi(id)
  } else {
    const [hit] = await searchArxiv(id, { limit: 1 })
    if (!hit) throw new Error(`arXiv 未找到：${id}`)
    meta = { ...hit, venue: hit.venue || 'arXiv', venue_type: 'preprint', year: hit.year }
  }

  const citekey = flags.citekey ? String(flags.citekey) : makeCitekey(meta)
  const file = join(p.notes, `${citekey}.md`)
  if (existsSync(file)) throw new Error(`记录已存在：${file}`)

  const keywords = list(flags.keywords)
  const tags = list(flags.tags)
  const draft = flags.draft === true
  if (!keywords.length && !draft) {
    throw new Error('需要 --keywords（受控词表；或加 --draft 建草稿）')
  }
  // tags 是必填项；入库时没给就落到收件箱，保证记录即时合规（之后用 tag 归类）
  if (draft) {
    if (!tags.includes('status/draft')) tags.push('status/draft')
  } else if (!tags.length) {
    tags.push('status/inbox')
  }

  // 入库前先校验词表：非法关键词/标签直接拒绝，不落盘、不写 bib
  if (existsSync(p.taxonomy)) {
    const taxonomy = loadTaxonomy(await readFile(p.taxonomy, 'utf8'))
    const early = validatePatch({ keywords, tags }, taxonomy)
    if (early.length) {
      for (const message of early) console.error(`  ✗ ${message}`)
      throw new Error('拒绝入库：关键词或标签不合规（未见记录文件）')
    }
  }

  const record = {
    citekey,
    title: meta.title,
    authors: meta.authors ?? [],
    year: meta.year,
    venue: meta.venue || '',
    venue_type: mapVenueType(meta.type, meta.venue),
    doi: meta.doi ?? '',
    arxiv: meta.arxivId ?? '',
    pmid: meta.pmid ?? '',
    keywords,
    tags,
    added: TODAY(),
    published: meta.published ?? (meta.year ? `${meta.year}-01-01` : ''),
    read_at: '',
    last_verified: TODAY(),
    citations: meta.citations ?? '',
    citations_source: meta.citations !== undefined ? (meta.source ?? '') : '',
    citations_snapshot: meta.citations !== undefined ? TODAY() : '',
    read_status: 'unread',
    __file: file,
    __body: `\n# ${meta.title}\n\n## 核心主张\n\n## 方法要点\n\n## 证据强度\n\n## 局限\n\n## 与本课题的关系\n`,
  }

  // 自动：下 PDF
  if (flags['no-pdf'] !== true) {
    try {
      const outDir = join(root, (await projectLayout(root)).pdfs)
      const pdf = await fetchPdf({
        doi: record.doi || undefined,
        arxivId: record.arxiv || undefined,
        outDir,
        citekey,
        cacheRoot: root,
      })
      record.pdf = pdf.path.replace(`${root}/`, '')
      console.log(`  PDF  ✓ ${record.pdf}（${(pdf.bytes / 1024 / 1024).toFixed(2)} MB，来源 ${pdf.source}）`)
    } catch (error) {
      console.log(`  PDF  ✗ ${error.message}（记录已建，之后可 lit-lib set ${citekey} pdf=<路径>）`)
    }
  }

  // 自动：写 bib
  if (flags['no-bib'] !== true) {
    const bib = toBibtex({ ...meta, doi: record.doi, arxivId: record.arxiv }, citekey)
    const result = await appendBib(p.bib, { entry: bib.entry, doi: record.doi })
    console.log(`  BIB  ${result.added ? '✓ 已追加' : '· 已存在'}（${citekey}）`)
    if (bib.problems.length) console.log(`       ⚠ 待补：${bib.problems.join('；')}`)
  }

  // 写盘前整条校验：元数据缺失（如年份/出处解析失败）也要拦住
  const taxonomy = loadTaxonomy(await readFile(p.taxonomy, 'utf8'))
  const { errors: recordErrors } = validateRecord(record, taxonomy, { draft })
  if (recordErrors.length) {
    for (const message of recordErrors) console.error(`  ✗ ${message}`)
    throw new Error('拒绝入库：记录不完整（未见记录文件）')
  }

  await writeRecord(record)
  console.log(`✓ 已建记录 ${p.notes}/${citekey}.md`)
  if (!keywords.length) console.log('  ⚠ 草稿状态：补 --keywords 后 set，或直接编辑 frontmatter')
}

async function cmdList(root, flags) {
  const records = await loadAll(root)
  const filtered = filterRecords(records, flags)
  const sortBy = flags.sort ?? 'year'
  filtered.sort((a, b) => {
    if (sortBy === 'citations') return Number(b.citations ?? 0) - Number(a.citations ?? 0)
    if (sortBy === 'citekey') return String(a.citekey).localeCompare(String(b.citekey))
    return Number(b.year ?? 0) - Number(a.year ?? 0)
  })
  const limit = Number(flags.limit ?? 50)
  console.log(`共 ${filtered.length} 条（显示 ${Math.min(limit, filtered.length)}）\n`)
  console.log('| citekey | 年 | 状态 | tier | 关键词 | 标题 |')
  console.log('|---|---|---|---|---|---|')
  for (const record of filtered.slice(0, limit)) {
    const title = String(record.title ?? '').replace(/\|/g, '/').slice(0, 48)
    console.log(
      `| ${record.citekey} | ${record.year ?? ''} | ${record.read_status ?? 'unread'} | ${record.influence_tier ?? '-'} | ${list(record.keywords).join(', ').slice(0, 34)} | ${title} |`,
    )
  }
}

export function filterRecords(records, flags) {
  return records.filter((record) => {
    if (flags.tag && !list(record.tags).includes(String(flags.tag))) return false
    if (flags.keyword && !list(record.keywords).includes(String(flags.keyword))) return false
    if (flags.collection && !list(record.tags).includes(`collection/${flags.collection}`)) return false
    if (flags.year && String(record.year) !== String(flags.year)) return false
    if (flags.status && record.read_status !== flags.status) return false
    if (flags.tier && record.influence_tier !== flags.tier) return false
    if (flags.role && record.role !== flags.role) return false
    return true
  })
}

async function cmdSearch(root, query) {
  const records = await loadAll(root)
  const needle = String(query ?? '').toLowerCase()
  const hits = records.filter((record) =>
    [record.title, record.authors, record.keywords, record.tags, record.__body]
      .map((v) => list(v).join(' '))
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
  console.log(`命中 ${hits.length} 条\n`)
  for (const record of hits) console.log(`  ${record.citekey}  ${record.year ?? ''}  ${record.title}`)
}

async function cmdTag(root, citekey, changes) {
  const records = await loadAll(root)
  const record = records.find((r) => r.citekey === citekey)
  if (!record) throw new Error(`无此记录：${citekey}`)
  let tags = list(record.tags)
  for (const change of changes) {
    const add = change.startsWith('+')
    const value = change.slice(1)
    if (add) {
      if (!tags.includes(value)) tags.push(value)
    } else {
      tags = tags.filter((t) => t !== value)
    }
  }
  const taxonomy = loadTaxonomy(await readFile((await paths(root)).taxonomy, 'utf8').catch(() => ''))
  // 只校验新增项：否则记录里一旦有历史脏标签，连"加一个合法标签"或"删掉它"都会被拒
  const addedTags = changes.filter((change) => change.startsWith('+')).map((change) => change.slice(1))
  const tagErrors = validatePatch({ tags: addedTags }, taxonomy)
  if (tagErrors.length) {
    for (const message of tagErrors) console.error(`  ✗ ${message}`)
    throw new Error(`拒绝写入：${tagErrors.length} 个非法标签（文件未改动）`)
  }
  record.tags = tags
  await writeRecord(record)
  console.log(`✓ ${citekey} tags: ${tags.join(', ')}`)
}

async function cmdSet(root, citekey, assignments, flags = {}) {
  const records = await loadAll(root)
  const record = records.find((r) => r.citekey === citekey)
  if (!record) throw new Error(`无此记录：${citekey}`)
  const patch = {}
  for (const assignment of assignments) {
    const index = assignment.indexOf('=')
    if (index < 0) throw new Error(`格式应为 key=value：${assignment}`)
    const key = assignment.slice(0, index)
    const value = assignment.slice(index + 1)
    patch[key] = ARRAY_FIELDS.has(key) ? value.split(',').map((v) => v.trim()).filter(Boolean) : value
  }
  // 拒绝未知字段：`set x keywrods=a` 这种手滑不该静默造出新字段
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key) && flags['allow-unknown'] !== true) {
      throw new Error(`未知字段：${key}（可用字段见 --help；确需自定义加 --allow-unknown）`)
    }
  }
  // 写入前即时校验：非法枚举 / 未登记关键词 / 无命名空间标签一律拒绝，不改文件
  const taxonomy = loadTaxonomy(await readFile((await paths(root)).taxonomy, 'utf8').catch(() => ''))
  const patchErrors = validatePatch(patch, taxonomy)
  if (patchErrors.length) {
    for (const message of patchErrors) console.error(`  ✗ ${message}`)
    throw new Error(`拒绝写入：${patchErrors.length} 个非法值（文件未改动）`)
  }
  Object.assign(record, patch)
  await writeRecord(record)
  console.log(`✓ 已更新 ${citekey}`)
}

async function cmdStats(root) {
  const records = await loadAll(root)
  const count = (fn) => {
    const map = new Map()
    for (const record of records) {
      const value = fn(record)
      if (value === undefined || value === '' || value === null) continue
      map.set(value, (map.get(value) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }
  console.log(`总计 ${records.length} 条\n`)
  console.log('按年：', count((r) => r.year).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(' '))
  console.log('状态：', count((r) => r.read_status).map(([k, v]) => `${k}(${v})`).join(' '))
  console.log('tier：', count((r) => r.influence_tier).map(([k, v]) => `${k}(${v})`).join(' '))
  console.log('角色：', count((r) => r.role).map(([k, v]) => `${k}(${v})`).join(' '))
  const tagCounts = new Map()
  for (const record of records) for (const tag of list(record.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  const orphans = [...tagCounts.entries()].filter(([, n]) => n === 1).map(([t]) => t)
  console.log(`\n标签 ${tagCounts.size} 个；孤儿标签（只用 1 次）：${orphans.slice(0, 10).join(', ') || '无'}`)
  const backlog = records.filter((r) => (r.read_status ?? 'unread') === 'unread').length
  console.log(`未读积压：${backlog} 条`)
}

async function cmdIndex(root) {
  const records = await loadAll(root)
  const index = records.map((record) => ({
    citekey: record.citekey,
    title: record.title,
    year: Number(record.year) || null,
    venue: record.venue,
    keywords: list(record.keywords),
    tags: list(record.tags),
    citations: Number(record.citations) || null,
    read_status: record.read_status ?? 'unread',
    influence_tier: record.influence_tier ?? null,
    role: record.role ?? null,
    pdf: record.pdf ?? null,
  }))
  const target = (await paths(root)).index
  await writeFile(target, JSON.stringify({ generatedAt: new Date().toISOString(), count: index.length, records: index }, null, 2))
  console.log(`✓ 已生成 ${target}（${index.length} 条）`)
}

async function cmdCheck(root) {
  const p = await paths(root)
  const taxonomyText = existsSync(p.taxonomy) ? await readFile(p.taxonomy, 'utf8') : ''
  const taxonomy = loadTaxonomy(taxonomyText)
  const records = await loadAll(root)
  const bibText = existsSync(p.bib) ? await readFile(p.bib, 'utf8') : ''
  const bibKeys = new Set([...bibText.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1].trim()))

  let errors = 0
  let warnings = 0
  for (const record of records) {
    const { errors: e, warnings: w } = validateRecord(record, taxonomy, { citekeyFromPath: record.__stem })
    for (const message of e) {
      errors += 1
      console.log(`  ✗ ${record.citekey}: ${message}`)
    }
    for (const message of w) {
      warnings += 1
      console.log(`  ⚠ ${record.citekey}: ${message}`)
    }
    if (!bibKeys.has(record.citekey)) {
      warnings += 1
      console.log(`  ⚠ ${record.citekey}: references.bib 里没有对应条目`)
    }
    if (record.pdf) {
      const pdfPath = isAbsolute(record.pdf) ? record.pdf : join(root, record.pdf)
      if (!existsSync(pdfPath)) {
        errors += 1
        console.log(`  ✗ ${record.citekey}: pdf 不存在（${record.pdf}）`)
      }
    }
  }
  for (const key of bibKeys) {
    if (!records.some((r) => r.citekey === key)) {
      warnings += 1
      console.log(`  ⚠ bib 有 ${key} 但库内无记录`)
    }
  }
  console.log(`\n${errors === 0 ? '✓ 无错误' : `✗ ${errors} 个错误`}${warnings ? `，${warnings} 个警告` : ''}（${records.length} 条记录）`)
  return errors === 0
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const main = async () => {
  const argv = process.argv.slice(2)
  const command = argv.shift()
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[name] = true
      else ((flags[name] = next), (i += 1))
    } else positional.push(token)
  }
  const root = String(flags.root ?? process.cwd())

  try {
    if (command === 'init') await cmdInit(root)
    else if (command === 'add') await cmdAdd(root, positional[0], flags)
    else if (command === 'list') await cmdList(root, flags)
    else if (command === 'search') await cmdSearch(root, positional.join(' '))
    else if (command === 'tag') await cmdTag(root, positional[0], positional.slice(1))
    else if (command === 'set') {
      const pairs = positional.slice(1)
      const consumes = pairs.length ? pairs : []
      await cmdSet(root, positional[0], consumes, flags)
    } else if (command === 'stats') await cmdStats(root)
    else if (command === 'index') await cmdIndex(root)
    else if (command === 'check') process.exitCode = (await cmdCheck(root)) ? 0 : 1
    else {
      console.log(`用法：
  lit-lib init
  lit-lib add <doi|arxiv-id> --keywords a,b [--tags x/y] [--no-pdf] [--no-bib] [--draft]
              （不给 --tags 时自动打 status/inbox）
  lit-lib list [--tag x/y] [--keyword k] [--year 2020] [--status read_full] [--tier core] [--collection name] [--sort year|citations|citekey] [--limit 50]
  lit-lib search "<q>"
  lit-lib tag <citekey> +ns/v -ns/v
  lit-lib set <citekey> field=value [...]
  lit-lib stats
  lit-lib index
  lit-lib check`)
      process.exitCode = command && command !== '--help' && command !== '-h' ? 2 : 0
    }
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 1
  }
}

// 只在作为入口脚本直接运行时执行。
// 注意：经符号链接（~/.local/bin/lit-lib）调用时 argv[1] 是链接路径，
// 而 import.meta.url 是真实路径 —— 必须比对 realpath。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()
if (invokedDirectly) await main()
