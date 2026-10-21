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
 *   node scripts/cite-check.mjs [--root <项目根>] [--no-network] [--json] [--max-lookups 50] [--deep]
 *
 * --deep：额外检查研究记录链路——研究假设/决策/论断/工件所引用的 citekey 是否在文献库中，
 *         以及实验↔工件↔评审的内部引用是否悬空，并报告证据覆盖率。
 *
 * 退出码：0 无错误（可有警告）；1 有错误；2 用法/IO 错误。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { projectLayout } from '../project-layout.mjs'

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
const DEEP = Boolean(flag('deep', false))

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
      if (['node_modules', '.git', 'data', 'artifacts', 'envs', 'scratch', 'codes'].includes(entry.name)) continue
      if (entry.name === 'exports' && dir.endsWith('outputs')) continue
      yield* walk(path)
    } else if (/\.(md|tex)$/i.test(entry.name)) {
      yield path
    }
  }
}

const main = async () => {
  const layout = await projectLayout(ROOT)
  const bibPath = join(ROOT, layout.bib)
  const bibExists = await stat(bibPath).then(() => true, () => false)
  if (!bibExists) {
    console.error(`✗ 找不到 ${bibPath}（先在 ${layout.bib} 建书目）`)
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

  // ── --deep：研究记录全链校验 ─────────────────────────────────────────────
  if (DEEP) {
    const readJsonSafe = async (file) => {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return null
      }
    }
    // 文献库里登记过的 key 也算已知（不强制维护 bib）
    const notesKeys = new Set()
    const notesDir = join(ROOT, layout.notes)
    try {
      for (const entry of await readdir(notesDir)) {
        if (entry.endsWith('.md')) notesKeys.add(entry.slice(0, -3))
      }
    } catch {
      /* 没有文献库就跳过 */
    }
    const known = new Set([...seen, ...notesKeys])
    const isKnown = (key) => known.has(key)

    const study = await readJsonSafe(join(ROOT, 'research', 'study.json'))
    const recordsIndex = (await readJsonSafe(join(ROOT, 'research', 'records', 'index.json'))) ?? { records: [] }
    const recordSlugs = new Set((recordsIndex.records ?? []).map((r) => r.slug))

    if (!study) {
      warnings.push('未发现 research/study.json：--deep 的研究链路检查未执行')
    } else {
      const hyps = study.hypotheses ?? []
      const exps = study.experiments ?? []
      const decs = study.decisions ?? []
      const claims = study.claims ?? []
      const reviews = study.reviews ?? []
      const hypIds = new Set(hyps.map((h) => h.id))
      const expIds = new Set(exps.map((e) => e.id))
      const reviewIds = new Set(reviews.map((r) => r.id))

      const unknownKeys = new Map()
      const noteKey = (key, where) => {
        if (!isKnown(key)) {
          if (!unknownKeys.has(key)) unknownKeys.set(key, [])
          unknownKeys.get(key).push(where)
        }
      }
      for (const h of hyps) for (const key of h.citekeys ?? []) noteKey(key, `假设 ${h.id}`)
      for (const d of decs) for (const key of d.citekeys ?? []) noteKey(key, `决策 ${d.id}`)
      for (const c of claims) for (const key of c.evidence?.citekeys ?? []) noteKey(key, `论断 ${c.id}`)

      // 工件侧：链接的 citekey 与实验
      let manifests = 0
      let recordDangling = 0
      try {
        for (const slug of recordSlugs) {
          const dir = join(ROOT, 'research', 'records', slug)
          for (const entry of await readdir(dir)) {
            if (!/^v\d+$/.test(entry)) continue
            const manifest = await readJsonSafe(join(dir, entry, 'manifest.json'))
            if (!manifest) continue
            manifests += 1
            for (const key of manifest.links?.citekeys ?? []) noteKey(key, `工件 ${slug}@${entry}`)
            if (manifest.links?.experiment && !expIds.has(manifest.links.experiment)) {
              errors.push(`工件 ${slug}@${entry} 关联的实验 ${manifest.links.experiment} 不存在`)
              recordDangling += 1
            }
            if (manifest.links?.hypothesis && !hypIds.has(manifest.links.hypothesis)) {
              errors.push(`工件 ${slug}@${entry} 关联的假设 ${manifest.links.hypothesis} 不存在`)
              recordDangling += 1
            }
          }
        }
      } catch (error) {
        warnings.push(`扫描工件清单失败：${error.message}`)
      }

      // 内部引用悬空（这些是硬错误：指向不存在的东西）
      for (const exp of exps) {
        if (exp.hypothesis && !hypIds.has(exp.hypothesis)) errors.push(`实验 ${exp.id} 关联的假设 ${exp.hypothesis} 不存在`)
        for (const rec of exp.records ?? []) {
          if (!recordSlugs.has(String(rec).split('@')[0])) errors.push(`实验 ${exp.id} 指向不存在的工件 ${rec}`)
        }
      }
      for (const h of hyps) {
        for (const eid of h.experiments ?? []) if (!expIds.has(eid)) errors.push(`假设 ${h.id} 指向不存在的实验 ${eid}`)
        for (const rid of h.reviews ?? []) if (!reviewIds.has(rid)) errors.push(`假设 ${h.id} 指向不存在的评审 ${rid}`)
      }

      for (const [key, where] of unknownKeys) {
        warnings.push(`citekey 不在文献库中: ${key}（被 ${where.slice(0, 3).join('、')}${where.length > 3 ? ' 等' : ''} 引用）`)
      }

      // 证据覆盖率（软提醒：不阻断，只报告）
      const noCiteHyps = hyps.filter((h) => !(h.citekeys ?? []).length)
      const noEvidenceClaims = claims.filter((c) => !(c.evidence?.citekeys ?? []).length && !(c.evidence?.records ?? []).length)
      const unverifiedClaims = claims.filter((c) => c.status === 'unverified')
      const noRecordExps = exps.filter((e) => !(e.records ?? []).length)

      infos.push(
        `研究链路: 假设 ${hyps.length} · 实验 ${exps.length} · 决策 ${decs.length} · 论断 ${claims.length} · 评审 ${reviews.length} · 工件清单 ${manifests}`,
      )
      infos.push(
        `证据覆盖: 假设有文献 ${hyps.length - noCiteHyps.length}/${hyps.length} · 论断有证据 ${claims.length - noEvidenceClaims.length}/${claims.length} · 实验有工件 ${exps.length - noRecordExps.length}/${exps.length}`,
      )
      if (noCiteHyps.length) warnings.push(`无文献支撑的假设 ${noCiteHyps.length} 条: ${noCiteHyps.map((h) => h.id).join(', ')}`)
      if (noEvidenceClaims.length) warnings.push(`无证据的论断 ${noEvidenceClaims.length} 条: ${noEvidenceClaims.map((c) => c.id).join(', ')}`)
      if (unverifiedClaims.length) warnings.push(`未验证的论断 ${unverifiedClaims.length} 条: ${unverifiedClaims.map((c) => c.id).join(', ')}`)
      if (noRecordExps.length) warnings.push(`尚无工件的实验 ${noRecordExps.length} 个: ${noRecordExps.map((e) => e.id).join(', ')}`)
    }
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
