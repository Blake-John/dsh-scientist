// lit-core —— 文献检索与全文获取的纯函数层（零第三方依赖）
//
// 只覆盖当前实测可访问的源（2026-10-20）：
//   · Crossref     检索 + DOI 权威元数据
//   · arXiv        预印本检索 + PDF 直取
//   · PubMed       E-utilities 检索（生医）
//   · Europe PMC   检索 + OA 全文
//   · LibGen       libgen.li，按 DOI 精确匹配取全文
//
// 已实测不可用、故未实现（留 TODO，恢复后每个约 40 行适配器）：
//   · OpenAlex       429，retry-after 16h
//   · Semantic Scholar 429（无 key）
//   · Unpaywall      422（example.com 被拒，需真实邮箱）
//   · Anna's Archive / libgen.is / libgen.rs  连接失败
//   · sci-hub        Altcha PoW 可解，但按用户决定不实现
//
// 设计原则：每个源独立预算、失败不拖垮整体；结果统一归一化后按 DOI/标题去重。

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const USER_AGENT = 'dsh-scientist-lit/1.0 (literature CLI)'
export const CACHE_DIR = '.lit-cache'

/** 主机熔断：某主机超时/拒连后 N 毫秒内不再尝试。 */
const HOST_COOLDOWN_MS = 10 * 60 * 1000
const hostState = new Map()

export function resetHostState() {
  hostState.clear()
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function hostBlocked(url) {
  const until = hostState.get(hostOf(url))?.blockedUntil ?? 0
  return until > Date.now() ? until : 0
}

function blockHost(url) {
  hostState.set(hostOf(url), { blockedUntil: Date.now() + HOST_COOLDOWN_MS })
}

/** 统一错误形状：调用方靠 code 分支，不解析 message。 */
export class LitError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LitError'
    this.code = code
    Object.assign(this, extra)
  }
}

async function request(url, { timeout = 20000, signal, accept, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(url, { timeout, signal, accept })
    } catch (error) {
      const retryable =
        error instanceof LitError &&
        (error.code === 'timeout' || error.code === 'network_error' || error.code === 'server_error')
      if (!retryable || attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
}

async function requestOnce(url, { timeout = 20000, signal, accept } = {}) {
  const blockedUntil = hostBlocked(url)
  if (blockedUntil) {
    throw new LitError('host_cooldown', `${hostOf(url)} 冷却中，${Math.ceil((blockedUntil - Date.now()) / 1000)}s 后重试`)
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout)
  const onAbort = () => ac.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept ?? '*/*' },
      signal: ac.signal,
      redirect: 'follow',
    })
    if (res.status >= 500 && res.status !== 503) {
      // 上游瞬时故障（LibGen 的 ads.php 实测会在 200/500 之间抖动）
      throw new LitError('server_error', `${hostOf(url)} 返回 HTTP ${res.status}`, { status: res.status })
    }
    if (res.status === 429 || res.status === 503) {
      const retry = Number(res.headers.get('retry-after'))
      hostState.set(hostOf(url), { blockedUntil: Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : HOST_COOLDOWN_MS) })
      throw new LitError('rate_limited', `${hostOf(url)} 限流（HTTP ${res.status}）`, { retryAfter: retry || null })
    }
    if (!res.ok) throw new LitError('http_error', `${hostOf(url)} 返回 HTTP ${res.status}`, { status: res.status })
    return res
  } catch (error) {
    if (error instanceof LitError) throw error
    if (error?.name === 'AbortError' || /timeout|terminated|fetch failed/i.test(String(error?.message))) {
      blockHost(url)
      throw new LitError('timeout', `${hostOf(url)} 超时`)
    }
    blockHost(url)
    throw new LitError('network_error', `${hostOf(url)} 连接失败: ${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

const json = async (url, opts) => (await request(url, opts)).json()
const text = async (url, opts) => (await request(url, opts)).text()

// ── 归一化记录 ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} Record
 * @property {string}  source      命中的源
 * @property {string}  title
 * @property {string[]} authors
 * @property {number|null} year
 * @property {string}  venue
 * @property {string}  [doi]
 * @property {string}  [arxivId]
 * @property {string}  [pmid]
 * @property {string}  [pmcid]
 * @property {number}  [citations]
 * @property {string}  [type]
 */

const cleanDoi = (doi) =>
  String(doi ?? '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase()

/**
 * arXiv 从 2022 起为每篇论文注册 DataCite DOI（10.48550/arXiv.xxxx）。
 * 这类 DOI 在 Crossref 查不到、LibGen 也没有，但能直接换算出 arXiv id。
 */
export const arxivIdFromDoi = (doi) => {
  const match = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(cleanDoi(doi))
  return match ? match[1] : null
}

const cleanArxiv = (value) =>
  String(value ?? '')
    .replace(/^arxiv:/i, '')
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/v\d+$/, '')
    .trim()

const normTitle = (title) =>
  String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** [2020, 5, 1] → '2020-05-01'；缺月/日则退化 */
const isoDate = (parts) => {
  if (!Array.isArray(parts) || !parts.length) return undefined
  const [y, m, d] = parts
  if (!y) return undefined
  return [y, String(m ?? 1).padStart(2, '0'), String(d ?? 1).padStart(2, '0')].join('-')
}

const yearOf = (value) => {
  const m = String(value ?? '').match(/(1[6-9]\d{2}|20\d{2})/)
  return m ? Number(m[1]) : null
}

const plainAuthors = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((a) => (typeof a === 'string' ? a : a?.family ? [a.given, a.family].filter(Boolean).join(' ') : a?.name ?? ''))
      .map((s) => String(s).trim())
      .filter(Boolean)
  }
  return String(value ?? '')
    .split(/\s*(?:,|;| and )\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── 源：Crossref ─────────────────────────────────────────────────────────────

export async function searchCrossref(query, { limit = 20, since, sort = 'relevance', signal } = {}) {
  const params = new URLSearchParams({ query, rows: String(Math.min(limit, 50)) })
  if (since) params.set('filter', `from-pub-date:${since}-01-01`)
  if (sort === 'cited') params.set('sort', 'is-referenced-by-count'), params.set('order', 'desc')
  params.set('select', 'DOI,title,author,issued,container-title,is-referenced-by-count,type')
  const data = await json(`https://api.crossref.org/works?${params}`, {
    signal,
    accept: 'application/json',
  })
  const items = data?.message?.items ?? []
  return items.map((item) => ({
    source: 'crossref',
    title: Array.isArray(item.title) ? item.title[0] ?? '' : String(item.title ?? ''),
    authors: plainAuthors(item.author),
    year: yearOf(item.issued?.['date-parts']?.[0]?.[0]),
    venue: Array.isArray(item['container-title']) ? item['container-title'][0] ?? '' : '',
    doi: cleanDoi(item.DOI),
    citations: item['is-referenced-by-count'] ?? undefined,
    type: item.type,
  }))
}

// ── 源：arXiv ───────────────────────────────────────────────────────────────

export async function searchArxiv(query, { limit = 20, since, signal } = {}) {
  const raw = String(query ?? '').trim()
  // 纯 arXiv id（1706.03762 / 1706.03762v7）走 id_list，精确直取
  const bareId = /^\d{4}\.\d{4,5}(v\d+)?$/.test(raw)
  if (bareId) {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanArxiv(raw))}&max_results=1`
    const xml = await text(url, { signal, timeout: 30000, accept: 'application/atom+xml' })
    return parseArxivEntries(xml)
  }
  // 已带字段前缀（ti: / au: / abs: / cat: …）时不要再用 all: 包一层
  const prefixed = /^(ti|au|abs|all|cat|co|jref|rn|id):/i.test(raw)
  const terms = [prefixed ? raw : `all:${raw}`]
  if (since) terms.push(`submittedDate:[${since}01010000 TO 209912312359]`)
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(terms.join(' AND '))}&start=0&max_results=${Math.min(limit, 50)}&sortBy=relevance`
  const xml = await text(url, { signal, timeout: 30000, accept: 'application/atom+xml' })
  return parseArxivEntries(xml)
}

function parseArxivEntries(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  return entries.map((entry) => {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)
      return m ? m[1].replace(/\s+/g, ' ').trim() : ''
    }
    const id = pick('id') // http://arxiv.org/abs/1706.03762v7
    const arxivId = cleanArxiv(id)
    const doi = cleanDoi(/(<arxiv:doi[^>]*>)([\s\S]*?)<\/arxiv:doi>/.exec(entry)?.[2] ?? '')
    const authors = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)]
      .map((m) => /<name>([\s\S]*?)<\/name>/.exec(m[1])?.[1]?.trim() ?? '')
      .filter(Boolean)
    return {
      source: 'arxiv',
      title: pick('title'),
      authors,
      year: yearOf(pick('published')),
      published: pick('published').slice(0, 10) || undefined,
      venue: 'arXiv',
      arxivId,
      doi: doi || undefined,
      type: 'preprint',
    }
  })
}

// ── 源：PubMed（E-utilities）────────────────────────────────────────────────

export async function searchPubmed(query, { limit = 20, signal } = {}) {
  const esearch = await json(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${Math.min(limit, 50)}&term=${encodeURIComponent(query)}`,
    { signal },
  )
  const ids = esearch?.esearchresult?.idlist ?? []
  if (ids.length === 0) return []
  const summary = await json(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`,
    { signal },
  )
  const result = summary?.result ?? {}
  return ids
    .map((id) => result[id])
    .filter(Boolean)
    .map((row) => ({
      source: 'pubmed',
      title: String(row.title ?? '').replace(/\.$/, ''),
      authors: plainAuthors((row.authors ?? []).map((a) => a.name)),
      year: yearOf(row.pubdate ?? row.epubdate),
      venue: row.fulljournalname ?? row.source ?? '',
      pmid: String(row.uid ?? ''),
      doi: cleanDoi((row.articleids ?? []).find((a) => a.idtype === 'doi')?.value),
      type: 'article',
    }))
}

// ── 源：Europe PMC ──────────────────────────────────────────────────────────

export async function searchEuropePmc(query, { limit = 20, signal } = {}) {
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=${Math.min(limit, 50)}` +
    `&query=${encodeURIComponent(query)}&resultType=core`
  const data = await json(url, { signal, timeout: 30000 })
  const items = data?.resultList?.result ?? []
  return items.map((row) => ({
    source: 'europepmc',
    title: String(row.title ?? '').replace(/<[^>]+>/g, ''),
    authors: plainAuthors(row.authorString),
    year: yearOf(row.pubYear ?? row.firstPublicationDate),
    venue: row.journalInfo?.journal?.title ?? row.journalTitle ?? '',
    doi: cleanDoi(row.doi),
    pmid: row.pmid ?? undefined,
    pmcid: row.pmcid ?? undefined,
    citations: row.citedByCount ?? undefined,
    type: row.pubType?.toLowerCase?.() ?? 'article',
  }))
}

// ── 合并 / 去重 / 排序 ──────────────────────────────────────────────────────

export function dedupe(records) {
  const byDoi = new Map()
  const byTitle = new Map()
  const out = []
  for (const record of records) {
    if (!record?.title) continue
    const doi = record.doi ? cleanDoi(record.doi) : ''
    const titleKey = `${normTitle(record.title)}|${record.year ?? ''}`
    const existing = (doi && byDoi.get(doi)) || byTitle.get(titleKey)
    if (existing) {
      // 合并字段：补齐空值、取较大引用数、记录多源命中
      for (const [k, v] of Object.entries(record)) {
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue
        if (existing[k] === undefined || existing[k] === '' || (Array.isArray(existing[k]) && existing[k].length === 0)) {
          existing[k] = v
        }
      }
      existing.citations = Math.max(existing.citations ?? 0, record.citations ?? 0) || undefined
      existing.sources = [...new Set([...(existing.sources ?? [existing.source]), record.source])]
      continue
    }
    const merged = { ...record, doi: doi || undefined, sources: [record.source] }
    out.push(merged)
    if (doi) byDoi.set(doi, merged)
    byTitle.set(titleKey, merged)
  }
  return out
}

/**
 * 客户端 since 过滤。
 * PubMed / Europe PMC 的接口不支持统一的日期过滤参数，靠这一步兜住，
 * 避免"传了 --since 却静默返回更早的文献"。
 */
export function applySince(records, since) {
  if (!since) return records
  const floor = Number(since)
  if (!Number.isFinite(floor)) return records
  return records.filter((record) => record.year == null || Number(record.year) >= floor)
}

export function rank(records, sort = 'relevance') {
  const copy = [...records]
  if (sort === 'cited') copy.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0))
  else if (sort === 'date') copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  return copy
}

// ── citekey 与 BibTeX ───────────────────────────────────────────────────────

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'on', 'in', 'to', 'with', 'is', 'are'])

const slug = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

export function makeCitekey(record, taken = new Set()) {
  const firstAuthor = record.authors?.[0] ?? ''
  const surname = slug(firstAuthor.includes(',') ? firstAuthor.split(',')[0] : firstAuthor.split(/\s+/).pop())
  const year = record.year ?? ''
  const titleWord =
    String(record.title ?? '')
      .split(/\s+/)
      .map(slug)
      .find((w) => w && !STOPWORDS.has(w)) ??
    // 中文等非 ASCII 标题 slug 后为空：用标题哈希兜底，避免全部变成 untitled
    `p${createHash('sha1').update(String(record.title ?? '')).digest('hex').slice(0, 6)}`
  let base = `${surname || 'anon'}${year}${titleWord}`
  if (!surname && record.arxivId) base = `arxiv${slug(record.arxivId)}`
  if (!taken.has(base)) return base
  for (let i = 1; ; i += 1) {
    const candidate = `${base}${String.fromCharCode(96 + i)}`
    if (!taken.has(candidate)) return candidate
  }
}

const bibEscape = (value) => String(value ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()

export function toBibtex(record, citekey = makeCitekey(record)) {
  const problems = []
  const authors = record.authors?.length ? record.authors.join(' and ') : ''
  const year = record.year ?? ''
  const title = bibEscape(record.title)
  if (!authors) problems.push('缺 author')
  if (!title) problems.push('缺 title')
  if (!year) problems.push('缺 year')

  const venue = bibEscape(record.venue)
  // 只有“作者/年份/venue 都齐”才输出 @article / @inproceedings；
  // 否则降级为 @misc（cite-check 对 @misc 只要求 title），避免 lit_bib 写出
  // cite-check 必然拒绝的缺字段条目，把 /survey 之类的闭环卡死。
  const complete = Boolean(authors) && Boolean(year) && Boolean(venue)
  const journalLike = Boolean(venue) && (record.type === 'article' || !/arxiv/i.test(venue))

  const fields = []
  const add = (name, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') fields.push(`  ${name} = {${value}}`)
  }

  let kind = 'misc'
  if (record.type === 'proceedings-article' && complete) kind = 'inproceedings'
  else if (journalLike && complete) kind = 'article'

  if (record.type === 'article' && !venue) problems.push('缺 venue（按 @misc 输出）')
  if (record.type === 'proceedings-article' && !venue) problems.push('缺 booktitle（按 @misc 输出）')

  add('author', authors)
  add('title', title)
  if (kind === 'article') add('journal', venue)
  if (kind === 'inproceedings') add('booktitle', venue)
  add('year', year)
  if (record.doi) add('doi', cleanDoi(record.doi))
  if (record.arxivId) {
    add('eprint', record.arxivId)
    add('archivePrefix', 'arXiv')
  }
  if (record.pmid) add('pmid', record.pmid)
  if (!record.doi && !record.arxivId) {
    problems.push('缺 doi/arxivId 等可溯源标识')
    if (venue) add('note', venue)
  }

  const body = fields.join(',\n')
  const todo = problems.length ? `% TODO: ${problems.join('；')} —— 请人工补全\n` : ''
  return { citekey, kind, entry: `${todo}@${kind}{${citekey},\n${body}\n}`, problems }
}

/** 幂等追加：同 DOI 已存在则返回 added:false。 */
export async function appendBib(bibPath, { entry, doi }) {
  let current = ''
  try {
    current = await readFile(bibPath, 'utf8')
  } catch {
    await mkdir(dirname(bibPath), { recursive: true })
    current = '% 由 lit_bib 生成；DOI 去重，重跑幂等\n\n'
  }
  const clean = cleanDoi(doi)
  // 精确比较 DOI 字段值 —— 不能用 includes：10.1/abc 是 10.1/abcd 的子串，
  // 而科研 DOI 大量共享前缀，子串匹配会静默丢掉整条条目。
  if (clean) {
    const existingDois = [...current.matchAll(/doi\s*=\s*[{"']?\s*([^}"'\n]+?)\s*["']?\s*[,}]/gi)].map((m) =>
      cleanDoi(m[1]),
    )
    if (existingDois.includes(clean)) return { added: false, path: bibPath }
  }
  // resolveDoi 查不到 DOI 的条目，退化为按 citekey 判重
  const entryKey = /@\w+\{\s*([^,\s]+)\s*,/.exec(entry)?.[1]
  if (entryKey) {
    const escaped = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@\\w+\\{\\s*${escaped}\\s*,`).test(current)) return { added: false, path: bibPath }
  }
  const next = `${current.replace(/\s+$/, '')}\n\n${entry}\n`
  await writeFile(bibPath, next)
  return { added: true, path: bibPath }
}

// ── 元数据解析（DOI → 记录）────────────────────────────────────────────────

export async function resolveDoi(doi, { signal } = {}) {
  const clean = cleanDoi(doi)
  if (!clean) throw new LitError('bad_input', 'DOI 为空')

  // arXiv DOI 走 DataCite，Crossref 查不到 —— 直接换算出 arXiv id 取元数据
  const arxivDoiId = arxivIdFromDoi(clean)
  if (arxivDoiId) {
    const [hit] = await searchArxiv(arxivDoiId, { limit: 1, signal }).catch(() => [])
    if (hit) {
      return {
        ...hit,
        doi: clean,
        venue: 'arXiv',
        venue_type: 'preprint',
        type: 'preprint',
        source: 'arxiv',
      }
    }
    throw new LitError('not_found', `arXiv ${arxivDoiId} 查不到（DOI ${clean}）`)
  }
  const data = await json(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, {
    signal,
    accept: 'application/json',
  }).catch(async (error) => {
    if (error.code !== 'http_error') throw error
    // Crossref 查不到时退到 Europe PMC
    const alt = await searchEuropePmc(`DOI:"${clean}"`, { limit: 1, signal }).catch(() => [])
    if (alt.length) return { __alt: alt[0] }
    throw new LitError('not_found', `DOI ${clean} 在 Crossref 与 Europe PMC 均未找到`)
  })
  if (data.__alt) return { ...data.__alt, source: 'europepmc' }
  const item = data.message ?? {}
  return {
    source: 'crossref',
    doi: clean,
    title: Array.isArray(item.title) ? item.title[0] : String(item.title ?? ''),
    authors: plainAuthors(item.author),
    year: yearOf(item.issued?.['date-parts']?.[0]?.[0]),
    published: isoDate(item.issued?.['date-parts']?.[0]),
    venue: Array.isArray(item['container-title']) ? item['container-title'][0] : item.publisher ?? '',
    type: item.type,
    citations: item['is-referenced-by-count'],
    license: item.license?.[0]?.URL ?? undefined,
  }
}

// ── LibGen（按 DOI 精确匹配）────────────────────────────────────────────────

const LIBGEN_HOSTS = ['https://libgen.li']
// libgen.li 对突发请求很敏感（实测连续几发就 429）：强制最小间隔。
const LIBGEN_MIN_INTERVAL_MS = 2000
let lastLibgenAt = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function libgenGate() {
  const wait = LIBGEN_MIN_INTERVAL_MS - (Date.now() - lastLibgenAt)
  if (wait > 0) await sleep(wait)
  lastLibgenAt = Date.now()
}

/**
 * LibGen 取全文。只走 DOI 精确匹配——实测标题搜索会返回同名不同论文。
 * @returns {Promise<{pdfUrl: string, editionUrl: string, md5: string} | null>}
 */
export async function libgenFind(doi, { signal, hosts = LIBGEN_HOSTS, cacheRoot } = {}) {
  const clean = cleanDoi(doi)
  if (!clean) return null
  if (cacheRoot) {
    // 只缓存"确实找到"的结果；null 与异常都不缓存
    const hit = await cached(cacheRoot, `libgen:${clean}`, 24 * 3600 * 1000, () => libgenFindUncached(clean, { signal, hosts }), {
      cacheWhen: (value) => value !== null && value !== undefined,
    })
    return hit
  }
  return libgenFindUncached(clean, { signal, hosts })
}

async function libgenFindUncached(clean, { signal, hosts }) {
  let lastError = null
  for (const base of hosts) {
    try {
      await libgenGate()
      const searchHtml = await text(`${base}/index.php?req=${encodeURIComponent(clean)}&topics%5B%5D=a`, { signal })
      const editionIds = [...new Set([...searchHtml.matchAll(/edition\.php\?id=(\d+)/g)].map((m) => m[1]))]
      for (const id of editionIds.slice(0, 5)) {
        await libgenGate()
        const editionHtml = await text(`${base}/edition.php?id=${id}`, { signal })
        // 校验：edition 页必须含目标 DOI，否则是标题模糊匹配的错论文
        if (!editionHtml.toLowerCase().includes(clean)) continue
        const md5 = /ads\.php\?md5=([0-9a-f]{32})/i.exec(editionHtml)?.[1]
        if (!md5) continue
        await libgenGate()
        return { editionUrl: `${base}/edition.php?id=${id}`, md5 }
      }
    } catch (error) {
      // 记住最后一次失败：若最终没命中且确有瞬时故障，要如实告诉调用方，
      // 而不是把"站点 500"说成"没有条目"。
      lastError = error
      continue
    }
  }
  if (lastError) {
    throw new LitError('libgen_unavailable', `LibGen 暂时不可用：${lastError.message}`, {
      attempts: lastError.code,
    })
  }
  return null
}

/**
 * 取 LibGen 的下载直链。
 * key 是一次性的（实测缓存下来的 url 复用会返回 HTTP 500），所以必须每次现取，
 * 缓存里只保留 md5。
 */
export async function libgenDownloadUrl(md5, { signal, hosts = LIBGEN_HOSTS, attempts = 3 } = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(md5 ?? ''))) return null
  let lastError = null
  for (const base of hosts) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await libgenGate()
        const adsHtml = await text(`${base}/ads.php?md5=${md5}`, { signal })
        const key = /get\.php\?md5=[0-9a-f]{32}&key=([A-Za-z0-9]+)/.exec(adsHtml)?.[1]
        if (key) return `${base}/get.php?md5=${md5}&key=${key}`
        break // 200 但没有 key：不是瞬时故障，换下一个域名
      } catch (error) {
        lastError = error
        // libgen 的数据库连接池会周期性打满（ads.php / get.php 报 500），值得退避重试
        const transient = ['server_error', 'timeout', 'network_error', 'rate_limited'].includes(error.code)
        if (!transient) break
        await sleep(1500 * (attempt + 1))
      }
    }
  }
  if (lastError) {
    throw new LitError('libgen_unavailable', `LibGen 取下载链接失败（站点数据库繁忙，稍后重试）：${lastError.message}`, {
      attempts: lastError.code,
    })
  }
  return null
}

// ── PDF 获取与校验 ──────────────────────────────────────────────────────────

export async function verifyPdf(file) {
  const info = await stat(file)
  if (info.size < 1024) return { ok: false, reason: `文件过小（${info.size}B）` }
  const handle = await readFile(file)
  const magic = handle.subarray(0, 5).toString('latin1')
  if (magic !== '%PDF-') {
    return { ok: false, reason: `不是 PDF（头部 ${JSON.stringify(magic)}）` }
  }
  const pages = (handle.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length || null
  return { ok: true, pages, bytes: info.size }
}

async function downloadTo(url, file, { signal } = {}) {
  const res = await request(url, { signal, timeout: 60000 })
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new LitError('not_a_pdf', `${hostOf(url)} 返回的不是 PDF（头部 ${JSON.stringify(buffer.subarray(0, 5).toString('latin1'))}）`)
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.part`
  await writeFile(tmp, buffer)
  await rename(tmp, file)
  return buffer.length
}

/**
 * 取全文：arXiv → Europe PMC（OA）→ LibGen（DOI 精确）。
 * 不实现 sci-hub（按用户决定）。
 */
export async function fetchPdf({ doi, arxivId, outDir = 'data/papers', citekey, signal, cacheRoot } = {}) {
  const attempts = []
  const stem = citekey || (arxivId ? `arxiv${slug(arxivId)}` : slug(doi) || 'paper')
  const file = join(outDir, `${stem}.pdf`)

  const effectiveArxivId = arxivId || (doi ? arxivIdFromDoi(doi) : null)
  if (effectiveArxivId) {
    const clean = cleanArxiv(effectiveArxivId)
    try {
      const bytes = await downloadTo(`https://arxiv.org/pdf/${clean}`, file, { signal })
      return { path: file, source: 'arxiv', bytes, attempts }
    } catch (error) {
      attempts.push(`arxiv: ${error.code ?? error.message}`)
    }
  }

  // 注意：即使给了 arxivId 且 arXiv 失败，也必须继续尝试 LibGen ——
  // 否则"信息更全"反而更不健壮。
  if (doi) {
    let libgen = null
    try {
      libgen = await libgenFind(doi, { signal, cacheRoot })
    } catch (error) {
      attempts.push(`libgen: ${error.message}${error.attempts ? ` (${error.attempts})` : ''}`)
    }
    if (libgen) {
      const url = await libgenDownloadUrl(libgen.md5, { signal }).catch((error) => {
        attempts.push(`libgen: ${error.message}`)
        return null
      })
      if (!url) {
        if (!attempts.some((a) => a.startsWith('libgen'))) attempts.push('libgen: 已找到条目但取下载链接失败')
      } else {
        try {
          const bytes = await downloadTo(url, file, { signal })
          return { path: file, source: 'libgen', bytes, attempts, editionUrl: libgen.editionUrl }
        } catch (error) {
          attempts.push(`libgen: ${error.code ?? error.message}`)
        }
      }
    } else if (!attempts.some((a) => a.startsWith('libgen'))) {
      attempts.push('libgen: 无条目或 DOI 不匹配')
    }
  }

  throw new LitError('no_fulltext', '未取到全文', {
    attempts,
    hint: '若原因是站点繁忙，稍后重试即可；否则确认该 DOI 是否有 OA 副本（arXiv / PMC / 机构库），或手动下载后放到 data/papers/ 并在记录里填 pdf 字段',
  })
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

export async function cached(root, key, ttlMs, producer, { cacheWhen } = {}) {
  const dir = join(root, CACHE_DIR, 'search')
  const file = join(dir, `${createHash('sha1').update(key).digest('hex')}.json`)
  if (ttlMs > 0 && existsSync(file)) {
    try {
      const entry = JSON.parse(await readFile(file, 'utf8'))
      if (entry.expires > Date.now()) return entry.value
    } catch {
      /* 缓存损坏则重算 */
    }
  }
  const value = await producer()
  // cacheWhen 用来拒绝缓存"暂时失败"的结果：把一次 500 当成 24h 的"没有条目"
  // 会让后续所有查询都错误地回答"未找到"。
  if (!cacheWhen || cacheWhen(value)) {
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify({ expires: Date.now() + ttlMs, value }))
  }
  return value
}

// ── 输出格式 ────────────────────────────────────────────────────────────────

export function formatTable(records, { limit = 20 } = {}) {
  const rows = records.slice(0, limit)
  const header = '| # | citekey | 年 | 被引 | 标题 | DOI / arXiv |'
  const sep = '|---|---------|----|------|------|-------------|'
  const taken = new Set()
  const lines = rows.map((r, i) => {
    const id = r.doi ? cleanDoi(r.doi) : r.arxivId ? `arXiv:${r.arxivId}` : r.pmid ? `PMID:${r.pmid}` : '—'
    const title = String(r.title ?? '').replace(/\|/g, '/').slice(0, 70)
    const cited = r.citations ?? ''
    const key = makeCitekey(r, taken)
    taken.add(key)
    return `| ${i + 1} | ${key} | ${r.year ?? ''} | ${cited} | ${title} | ${id} |`
  })
  return [header, sep, ...lines].join('\n')
}

