#!/usr/bin/env node
/**
 * test-lit-lib —— 文献库 CLI 的测试（默认离线；--live 额外跑一次真实入库）
 *
 * 离线部分：frontmatter 往返、必填/枚举/词表校验、标签命名空间、过滤器、init→set→check 全流程。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  filterRecords,
  loadTaxonomy,
  parseRecord,
  renderRecord,
  validatePatch,
  validateRecord,
} from './lit-lib.mjs'

const run = promisify(execFile)
const live = process.argv.includes('--live')
const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}
const CLI = new URL('./lit-lib.mjs', import.meta.url).pathname

// ── 1. frontmatter 往返 ────────────────────────────────────────────────────
{
  const record = {
    citekey: 'vaswani2017attention',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: '2017',
    venue: 'NeurIPS',
    venue_type: 'conference',
    doi: '10.48550/arxiv.1706.03762',
    keywords: ['transformer', 'self-attention'],
    tags: ['method/attention', 'era/2017'],
    added: '2026-10-20',
    read_status: 'unread',
    __body: '\n# 笔记\n\n正文内容\n',
  }
  const text = renderRecord(record)
  ok(!text.includes('__body'), 'renderRecord 不应把 __body 写进 frontmatter')
  ok(text.includes('keywords: [transformer, self-attention]'), '数组渲染')
  const back = parseRecord(text)
  ok(back.meta.citekey === record.citekey, 'citekey 往返')
  ok(back.meta.keywords.length === 2, `数组解析: ${JSON.stringify(back.meta.keywords)}`)
  ok(back.body.includes('正文内容'), 'body 往返')
}

// ── 1b. 回归：特殊字符必须原样往返（曾把 O'Brien 写成 OBrien）─────────────
{
  const cases = ["A: O'Brien's work", 'He said "hi"', 'x [y] z', 'a\\\\b', '  padded  ', "'"]
  for (const title of cases) {
    const back = parseRecord(renderRecord({ citekey: 'k2020w', title, keywords: [], tags: [], __body: '\n' }))
    ok(back.meta.title === title, `往返丢字符：${JSON.stringify(title)} → ${JSON.stringify(back.meta.title)}`)
  }
}

// ── 1c. 回归：数组元素含逗号不得被拆散（作者 'Smith, John'）─────────────────
{
  const authors = ['Smith, John', 'Doe, Jane']
  const back = parseRecord(renderRecord({ citekey: 'k2020w', title: 'T', authors, keywords: [], tags: [], __body: '\n' }))
  ok(JSON.stringify(back.meta.authors) === JSON.stringify(authors), `数组逗号往返：${JSON.stringify(back.meta.authors)}`)
  const quoted = ['x"y', 'z']
  ok(
    JSON.stringify(parseRecord(renderRecord({ citekey: 'k', authors: quoted, keywords: [], tags: [], __body: '\n' })).meta.authors) ===
      JSON.stringify(quoted),
    '数组内双引号往返',
  )
}

// ── 2. 校验 ────────────────────────────────────────────────────────────────
{
  const taxonomy = loadTaxonomy(await readFile(new URL('./taxonomy.template.yml', import.meta.url), 'utf8'))
  ok(taxonomy.keywords.has('transformer'), '词表加载：transformer')
  ok(taxonomy.keywords.has('self-attention'), '词表加载：子关键词')
  ok(taxonomy.namespaces.has('collection'), '命名空间 collection')

  const good = {
    citekey: 'vaswani2017attention', title: 'T', authors: ['A B'], year: '2017',
    venue: 'NeurIPS', venue_type: 'conference', doi: '10.1/x',
    keywords: ['transformer'], tags: ['method/attention'], added: '2026-10-20',
  }
  ok(validateRecord(good, taxonomy).errors.length === 0, `合规记录不应报错: ${JSON.stringify(validateRecord(good, taxonomy).errors)}`)

  const missing = { ...good, title: '', keywords: [] }
  const r1 = validateRecord(missing, taxonomy)
  ok(r1.errors.some((e) => e.includes('缺必填字段 title')), '检出缺 title')
  ok(r1.errors.some((e) => e.includes('缺必填字段 keywords')), '检出缺 keywords')

  const noId = { ...good, doi: '', arxiv: '', pmid: '' }
  ok(validateRecord(noId, taxonomy).errors.some((e) => e.includes('缺标识')), '检出无标识')

  const badEnum = { ...good, venue_type: 'blog', read_status: 'done' }
  const r2 = validateRecord(badEnum, taxonomy)
  ok(r2.errors.some((e) => e.includes('venue_type=blog')), '检出枚举越界 venue_type')
  ok(r2.errors.some((e) => e.includes('read_status=done')), '检出枚举越界 read_status')

  const badKeyword = { ...good, keywords: ['quantum-widget'] }
  ok(validateRecord(badKeyword, taxonomy).errors.some((e) => e.includes('关键词未登记')), '检出未登记关键词')

  const badTag = { ...good, tags: ['bare'] }
  ok(validateRecord(badTag, taxonomy).errors.some((e) => e.includes('必须带命名空间')), '检出无命名空间标签')

  const badNs = { ...good, tags: ['nonsense/x'] }
  ok(validateRecord(badNs, taxonomy).errors.some((e) => e.includes('未定义的标签命名空间')), '检出未定义命名空间')

  const badDate = { ...good, added: '2026/10/20', read_at: '2026-10-19' }
  const r3 = validateRecord(badDate, taxonomy)
  ok(r3.errors.some((e) => e.includes('不是 YYYY-MM-DD')), '检出日期格式')
  ok(r3.errors.some((e) => e.includes('read_at 早于 added')), '检出 read_at 早于 added')

  const stale = { ...good, citations: '100', citations_snapshot: '2020-01-01' }
  ok(validateRecord(stale, taxonomy).warnings.some((w) => w.includes('快照已')), '陈旧引用数快照应告警')
}

// ── 2b. 回归：validatePatch 必须拦住非法增量（写入时校验）─────────────────
{
  const taxonomy = loadTaxonomy(await readFile(new URL('./taxonomy.template.yml', import.meta.url), 'utf8'))
  ok(validatePatch({ read_status: 'done' }, taxonomy).some((e) => e.includes('read_status=done')), 'validatePatch 拦非法枚举')
  ok(validatePatch({ venue_type: 'blog' }, taxonomy).some((e) => e.includes('venue_type=blog')), 'validatePatch 拦 venue_type')
  ok(validatePatch({ keywords: ['made-up'] }, taxonomy).some((e) => e.includes('关键词未登记')), 'validatePatch 拦未登记关键词')
  ok(validatePatch({ tags: ['bare'] }, taxonomy).some((e) => e.includes('必须带命名空间')), 'validatePatch 拦无命名空间标签')
  ok(validatePatch({ tags: ['nonsense/x'] }, taxonomy).some((e) => e.includes('未定义的标签命名空间')), 'validatePatch 拦未知命名空间')
  ok(validatePatch({ added: '2026/10/20' }, taxonomy).some((e) => e.includes('YYYY-MM-DD')), 'validatePatch 拦日期格式')
  ok(validatePatch({ read_status: 'read_full', relevance: '5', tags: ['era/2020'] }, taxonomy).length === 0, 'validatePatch 放行合法值')
}

// ── 3. 过滤器 ──────────────────────────────────────────────────────────────
{
  const records = [
    { citekey: 'a', year: '2017', tags: ['collection/ch1', 'method/attention'], keywords: ['transformer'], read_status: 'read_full' },
    { citekey: 'b', year: '2020', tags: ['collection/ch2'], keywords: ['diffusion-model'], read_status: 'unread' },
  ]
  ok(filterRecords(records, { collection: 'ch1' }).length === 1, '按 collection 过滤')
  ok(filterRecords(records, { tag: 'method/attention' })[0].citekey === 'a', '按 tag 过滤')
  ok(filterRecords(records, { status: 'unread' })[0].citekey === 'b', '按 status 过滤')
  ok(filterRecords(records, { year: '2020' }).length === 1, '按 year 过滤')
}

// ── 4. CLI 全流程（init → 手写记录 → set → check）──────────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'lit-lib-'))
  try {
    await run('node', [CLI, 'init', '--root', dir])
    ok(existsSync(join(dir, 'literature', 'taxonomy.yml')), 'init 生成词表')

    await mkdir(join(dir, 'literature', 'notes'), { recursive: true })
    await writeFile(
      join(dir, 'literature', 'notes', 'demo2024paper.md'),
      `---\ncitekey: demo2024paper\ntitle: Demo\nauthors: [A B]\nyear: 2024\nvenue: arXiv\nvenue_type: preprint\narxiv: '2401.00001'\nkeywords: [transformer]\ntags: [era/2024]\nadded: 2026-10-20\nread_status: unread\n---\n\n# 笔记\n`,
    )

    const { stdout: listed } = await run('node', [CLI, 'list', '--root', dir])
    ok(listed.includes('demo2024paper'), 'list 能列出记录')

    await run('node', [CLI, 'set', 'demo2024paper', 'read_status=read_full', 'influence_tier=core', '--root', dir])
    const after = parseRecord(await readFile(join(dir, 'literature', 'notes', 'demo2024paper.md'), 'utf8'))
    ok(after.meta.read_status === 'read_full' && after.meta.influence_tier === 'core', 'set 生效')
    ok(after.body.includes('# 笔记'), 'set 不丢正文')

    // 回归：非法 set 必须非零退出且不改动文件
    const before = await readFile(join(dir, 'literature', 'notes', 'demo2024paper.md'), 'utf8')
    const rejected = await run('node', [CLI, 'set', 'demo2024paper', 'read_status=done', '--root', dir]).then(
      () => false,
      () => true,
    )
    ok(rejected, 'set 非法枚举应非零退出')
    ok((await readFile(join(dir, 'literature', 'notes', 'demo2024paper.md'), 'utf8')) === before, 'set 被拒后文件不应改动')

    // 回归：tag 加非法命名空间必须拒绝
    const badTag = await run('node', [CLI, 'tag', 'demo2024paper', '+badtag', '--root', dir]).then(
      () => false,
      () => true,
    )
    ok(badTag, 'tag 非法命名空间应非零退出')

    // 回归：set 未知字段必须拒绝
    const badField = await run('node', [CLI, 'set', 'demo2024paper', 'keywrods=x', '--root', dir]).then(
      () => false,
      () => true,
    )
    ok(badField, 'set 未知字段应非零退出')

    await run('node', [CLI, 'tag', 'demo2024paper', '+collection/ch1', '-era/2024', '--root', dir])
    const tagged = parseRecord(await readFile(join(dir, 'literature', 'notes', 'demo2024paper.md'), 'utf8'))
    ok(tagged.meta.tags.includes('collection/ch1') && !tagged.meta.tags.includes('era/2024'), 'tag 增删')

    const { stdout: indexOut } = await run('node', [CLI, 'index', '--root', dir])
    ok(indexOut.includes('1 条'), 'index 生成')
    const index = JSON.parse(await readFile(join(dir, 'literature', 'index.json'), 'utf8'))
    ok(index.records[0].citekey === 'demo2024paper', 'index 内容正确')

    const check = await run('node', [CLI, 'check', '--root', dir]).then(
      (r) => r.stdout,
      (error) => error.stdout ?? error.message,
    )
    ok(/无错误|个警告/.test(check), `check 应可运行: ${check.slice(0, 120)}`)

    if (live) {
      const add = await run('node', [CLI, 'add', '10.1038/nature14539', '--keywords', 'representation-learning', '--root', dir], { timeout: 180000 })
      ok(/已建记录/.test(add.stdout), `add 失败: ${add.stdout.slice(-200)}`)
      ok(existsSync(join(dir, 'literature', 'notes', 'lecun2015deep.md')), 'add 生成记录文件')
      ok((await readFile(join(dir, 'literature', 'references.bib'), 'utf8')).includes('@article{lecun2015deep'), 'add 写入 bib')
      console.log('  lit-lib add（真实入库）✓')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log(`✓ lit-lib ${live ? '离线 + 真实入库' : '离线'}测试通过（往返 / 校验 / 过滤 / CLI 流程）`)
