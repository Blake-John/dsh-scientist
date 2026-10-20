#!/usr/bin/env node
/**
 * test-lit-tools —— 工具层测试。
 *
 * 默认只做结构测试（不联网）：4 个工具、契约字段齐全、参数 schema 合法。
 * 加 --live 再实跑 lit_doi / lit_search / lit_bib（不写文件）/ lit_pdf（下载到临时目录）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lit-tools.mjs'

const live = process.argv.includes('--live')
const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const captured = []
const ctx = { tools: { register: (definition) => (captured.push(definition), () => {}) } }
apply(ctx)

const names = captured.map((d) => d.name)
ok(captured.length === 4, `应注册 4 个工具，实际 ${captured.length}`)
for (const expected of ['lit_search', 'lit_doi', 'lit_bib', 'lit_pdf']) {
  ok(names.includes(expected), `缺少工具 ${expected}`)
}
for (const definition of captured) {
  ok(typeof definition.description === 'string' && definition.description.length > 20, `${definition.name}: description 过短`)
  ok(definition.parameters?.type === 'object', `${definition.name}: parameters 非 object`)
  ok(typeof definition.execute === 'function', `${definition.name}: 缺 execute`)
  ok(typeof definition.output?.schema !== 'undefined', `${definition.name}: 缺 output.schema`)
  ok(typeof definition.output?.render === 'function', `${definition.name}: 缺 output.render`)
  ok(typeof definition.presentCall === 'function', `${definition.name}: 缺 presentCall`)
}

const byName = Object.fromEntries(captured.map((d) => [d.name, d]))
const run = (name, args) => byName[name].execute(args, { signal: new AbortController().signal })

if (live) {
  const dir = await mkdtemp(join(tmpdir(), 'lit-tools-'))
  try {
    const meta = await run('lit_doi', { doi: '10.1038/nature14539' })
    ok(/Deep learning/i.test(meta), `lit_doi 标题异常: ${meta.slice(0, 80)}`)
    ok(/2015/.test(meta), 'lit_doi 年份异常')
    console.log('  lit_doi ✓')

    const search = await run('lit_search', { query: 'attention is all you need', limit: 5 })
    ok(/找到 \d+ 条/.test(search), `lit_search 输出异常: ${search.slice(0, 80)}`)
    ok(/vaswani|attention/i.test(search), 'lit_search 未命中目标论文')
    console.log('  lit_search ✓')

    const bib = await run('lit_bib', { doi: '10.1038/nature14539', write: false })
    ok(/@article\{lecun2015deep/.test(bib), `lit_bib 条目异常: ${bib.slice(0, 80)}`)
    console.log('  lit_bib ✓')

    const pdf = await run('lit_pdf', { arxiv_id: '1706.03762', out_dir: join(dir, 'papers') })
    ok(/✓ 已下载/.test(pdf), `lit_pdf(arXiv) 失败: ${pdf.slice(0, 120)}`)
    ok(/15 页/.test(pdf), 'lit_pdf(arXiv) 页数异常')
    console.log('  lit_pdf(arXiv) ✓')

    // arXiv DOI（DataCite 注册）必须能走 arXiv 直取
    const arxivDoi = await run('lit_pdf', { doi: '10.48550/arXiv.1706.03762', out_dir: join(dir, 'papers3') })
    ok(/✓ 已下载/.test(arxivDoi) && /来源 arxiv/.test(arxivDoi), `lit_pdf(arXiv DOI) 失败: ${arxivDoi.slice(0, 160)}`)
    console.log(/✓ 已下载/.test(arxivDoi) ? '  lit_pdf(arXiv DOI) ✓' : '  lit_pdf(arXiv DOI) ✗')

    const libgen = await run('lit_pdf', { doi: '10.1038/nature14539', out_dir: join(dir, 'papers2') })
    const libgenOk = /✓ 已下载/.test(libgen) && /libgen/.test(libgen)
    // 站点繁忙不算我们的缺陷：只要"没有静默失败、原因如实"就算通过
    const siteBusy = /libgen_unavailable|server_error|数据库繁忙|取下载链接失败|暂时不可用|HTTP 5\d\d/.test(libgen)
    ok(libgenOk || siteBusy, `lit_pdf(LibGen) 失败且无明确原因: ${libgen.slice(0, 160)}`)
    console.log(
      libgenOk ? '  lit_pdf(LibGen) ✓' : siteBusy ? '  lit_pdf(LibGen) ⚠ 站点繁忙（已如实报因）' : `  lit_pdf(LibGen) ✗ ${libgen.split('\n')[0]}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log(`✓ lit-tools ${live ? '结构 + 联网' : '结构'}测试通过（${captured.length} 个工具）`)
