#!/usr/bin/env node
/**
 * test-lit-core —— lit-core 的离线单测（不联网、不依赖 harness）。
 *
 * 覆盖：citekey 生成与冲突、BibTeX 类型判定与字段缺失、去重合并、
 *       LibGen edition 页的 DOI 校验逻辑、appendBib 幂等、PDF 魔数校验。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendBib,
  applySince,
  arxivIdFromDoi,
  dedupe,
  formatTable,
  makeCitekey,
  toBibtex,
  verifyPdf,
} from '../lit-core.mjs'

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

// 1. citekey
{
  const rec = { authors: ['Ashish Vaswani'], year: 2017, title: 'Attention Is All You Need' }
  ok(makeCitekey(rec) === 'vaswani2017attention', `citekey: ${makeCitekey(rec)}`)
  const taken = new Set(['vaswani2017attention'])
  ok(makeCitekey(rec, taken) === 'vaswani2017attentiona', `citekey 冲突后缀: ${makeCitekey(rec, taken)}`)
  const noAuthor = { authors: [], year: 2021, title: 'An Untitled Thing', arxivId: '2101.00001' }
  ok(makeCitekey(noAuthor) === 'arxiv210100001', `无作者用 arxiv id: ${makeCitekey(noAuthor)}`)
}

// 2. BibTeX
{
  const article = toBibtex(
    { authors: ['A One', 'B Two'], year: 2015, title: 'Deep learning', venue: 'Nature', doi: '10.1038/nature14539', type: 'article' },
    'lecun2015deep',
  )
  ok(article.kind === 'article', `type=article → ${article.kind}`)
  ok(article.entry.includes('@article{lecun2015deep'), 'BibTeX 头')
  ok(article.entry.includes('journal = {Nature}'), 'journal 字段')
  ok(article.entry.includes('doi = {10.1038/nature14539}'), 'doi 字段')
  ok(article.problems.length === 0, `不应有 problems: ${article.problems}`)

  const broken = toBibtex({ authors: [], year: null, title: 'Only Title', venue: 'arXiv', arxivId: '1706.03762' }, 'x')
  ok(broken.problems.includes('缺 author'), `缺 author: ${broken.problems}`)
  ok(broken.problems.includes('缺 year'), `缺 year: ${broken.problems}`)
  ok(broken.entry.includes('eprint = {1706.03762}'), 'arxiv eprint')
  ok(broken.entry.startsWith('% TODO:'), '缺字段时写 TODO 注释')

  // 不完整的条目必须降级为 @misc，避免写出 cite-check 必然拒绝的 @article
  const noVenue = toBibtex({ authors: ['A'], year: 2020, title: 'No Venue', type: 'article', doi: '10.1/nv' }, 'novenue')
  ok(noVenue.kind === 'misc', `空 venue 应降级 misc：${noVenue.kind}`)
  ok(!noVenue.entry.includes('@article'), '不得输出缺 journal 的 @article')
  ok(noVenue.problems.some((p) => p.includes('缺 venue')), `应提示缺 venue：${noVenue.problems}`)

  const noYear = toBibtex({ authors: ['A'], title: 'No Year', venue: 'J', type: 'article', doi: '10.1/ny' }, 'noyear')
  ok(noYear.kind === 'misc', `缺 year 应降级 misc：${noYear.kind}`)
  ok(noYear.problems.includes('缺 year'), `缺 year: ${noYear.problems}`)

  // 中文标题 slug 为空时不能全部落到 untitled（否则同年后缀冲突）
  const cjk1 = makeCitekey({ authors: ['张三'], year: 2024, title: '注意力机制研究' })
  const cjk2 = makeCitekey({ authors: ['李四'], year: 2024, title: '扩散模型综述' })
  ok(cjk1 !== cjk2, `中文标题 citekey 应互不相同：${cjk1} / ${cjk2}`)
  ok(!cjk1.includes('untitled'), `不应退化为 untitled：${cjk1}`)

  // 表格里同一作者同年同词的条目应自动加后缀
  const tableDup = formatTable([
    { authors: ['A B'], year: 2020, title: 'Deep Learning', doi: '10.1/a' },
    { authors: ['A B'], year: 2020, title: 'Deep Learning', doi: '10.1/b' },
  ])
    .split('\n')
    .slice(2)
    .map((line) => line.split('|')[2].trim())
  ok(new Set(tableDup).size === 2, `表格 citekey 应去重：${tableDup}`)

  // since 客户端过滤
  const years = [{ year: 2019 }, { year: 2024 }, { year: null }]
  ok(applySince(years, 2020).length === 2, 'since 过滤应保留 >=2020 与未知年份')
  ok(applySince(years, undefined).length === 3, '无 since 时不过滤')

  // arXiv DOI（DataCite 注册）必须能换算出 arXiv id
  ok(arxivIdFromDoi('10.48550/arXiv.1706.03762') === '1706.03762', 'arXiv DOI → id')
  ok(arxivIdFromDoi('10.48550/arxiv.2401.00001') === '2401.00001', 'arXiv DOI 大小写不敏感')
  ok(arxivIdFromDoi('10.1038/nature14539') === null, '普通 DOI 不误判')
  ok(arxivIdFromDoi('10.48550/arXiv.1706.03762v7') === null, '带版本号的 DOI 形式不误判')

  const proc = toBibtex(
    { authors: ['C Three'], year: 2017, title: 'Paper', venue: 'NeurIPS', type: 'proceedings-article', doi: '10.1/x' },
    'p2017',
  )
  ok(proc.kind === 'inproceedings' && proc.entry.includes('booktitle'), `会议论文: ${proc.kind}`)
}

// 3. 去重合并
{
  const merged = dedupe([
    { source: 'crossref', doi: '10.1038/NATURE14539', title: 'Deep learning', year: 2015, citations: 90000 },
    { source: 'europepmc', doi: '10.1038/nature14539', title: 'Deep learning.', year: 2015, pmid: '26017442' },
    { source: 'arxiv', arxivId: '1706.03762', title: 'Attention Is All You Need', year: 2017 },
  ])
  ok(merged.length === 2, `去重后应 2 条，实际 ${merged.length}`)
  const deep = merged.find((r) => /deep/i.test(r.title))
  ok(deep?.pmid === '26017442', '合并后补齐 pmid')
  ok(deep?.sources?.length === 2, `多源命中记录: ${deep?.sources}`)
}

// 4. 表格
{
  const table = formatTable([{ authors: ['X Y'], year: 2020, title: 'T', doi: '10.1/ABC', citations: 3 }])
  ok(table.includes('| 1 |'), '表格行')
  ok(table.includes('10.1/abc'), 'DOI 小写归一')
}

// 5. appendBib 幂等 + PDF 校验
{
  const dir = await mkdtemp(join(tmpdir(), 'lit-'))
  try {
    const bib = join(dir, 'references.bib')
    const first = await appendBib(bib, { entry: '@article{a,\n  doi = {10.1/abc}\n}', doi: '10.1/abc' })
    const second = await appendBib(bib, { entry: '@article{a,\n  doi = {10.1/abc}\n}', doi: '10.1/abc' })
    ok(first.added === true && second.added === false, 'appendBib 幂等（同 DOI 不重复追加）')
    const content = await readFile(bib, 'utf8')
    ok((content.match(/@article\{a/g) ?? []).length === 1, '文件里只有一条')

    // 回归：DOI 子串不得误判（10.1/abc 曾命中 10.1/abcd 并丢掉整条 bib）
    const prefixes = [
      ['10.1/abcd', '10.1/abc', true, '前缀子串'],
      ['10.1/abc', '10.1/abcd', true, '追加更长'],
      ['10.1/abc', '10.1/abc', false, '完全相同'],
      ['10.1/abc', '10.1/ABC', false, '大小写差异'],
    ]
    for (const [seed, add, want, label] of prefixes) {
      const f = join(dir, `p-${seed.replace(/\W/g, '_')}-${add.replace(/\W/g, '_')}.bib`)
      await appendBib(f, { entry: `@article{x,\n  doi = {${seed}}\n}`, doi: seed })
      const result = await appendBib(f, { entry: `@article{y,\n  doi = {${add}}\n}`, doi: add })
      ok(result.added === want, `DOI ${label}：added=${result.added}，期望 ${want}`)
    }

    const fakePdf = join(dir, 'ok.pdf')
    await writeFile(fakePdf, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 32)]))
    const good = await verifyPdf(fakePdf)
    ok(good.ok === true, 'PDF 魔数校验通过')

    const fakeHtml = join(dir, 'bad.pdf')
    await writeFile(fakeHtml, Buffer.concat([Buffer.from('<!DOCTYPE html>'), Buffer.alloc(2000, 32)]))
    const bad = await verifyPdf(fakeHtml)
    ok(bad.ok === false, 'HTML 伪装被拒')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ lit-core 离线单测通过（citekey / BibTeX / 去重 / 表格 / appendBib / PDF 校验）')
