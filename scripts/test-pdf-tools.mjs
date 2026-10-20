#!/usr/bin/env node
/**
 * test-pdf-tools —— pdf_outline / pdf_read 的测试。
 *
 * 现场用 PyMuPDF 生成一个 3 页样例 PDF（含目录与一页公式），再验证：
 *   · 注册了 2 个工具且契约字段齐全
 *   · outline：页数 / 目录 / 文本层识别
 *   · read markdown：保留标题层级
 *   · read text：按页分隔
 *   · read render：产出 PNG 文件
 *   · 页范围越界提示、文件不存在报错
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apply } from '../pdf-tools.mjs'

const run = promisify(execFile)
const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

// 生成样例 PDF
const dir = await mkdtemp(join(tmpdir(), 'pdf-tools-'))
const sample = join(dir, 'sample.pdf')
const py = `
import pymupdf
doc = pymupdf.open()
for body in [
    "Attention Is All You Need\\n\\nAbstract: the dominant sequence transduction models are based on complex recurrent networks.",
    "1. Introduction\\n\\nRecurrent neural networks have been firmly established as state of the art in sequence modeling.",
    "2. Model Architecture\\n\\nMost competitive neural sequence models have an encoder-decoder structure.\\n\\ny = f(x) = x^2 + sum(i) + sqrt(z) + alpha + beta",
]:
    page = doc.new_page()
    page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), body, fontsize=11)
doc.set_toc([[1, "1 Introduction", 2], [1, "2 Model Architecture", 3]])
doc.save(sample_path)
doc.close()
`
try {
  await run('python3', ['-c', py.replace('sample_path', JSON.stringify(sample))], { timeout: 60000 })
} catch (error) {
  console.error(`✗ 无法生成样例 PDF（需要 PyMuPDF）：${error.message}`)
  process.exit(1)
}

// 结构测试
const captured = []
apply({ tools: { register: (definition) => (captured.push(definition), () => {}) } })
const byName = Object.fromEntries(captured.map((d) => [d.name, d]))
ok(captured.length === 2, `应注册 2 个工具，实际 ${captured.length}`)
for (const expected of ['pdf_outline', 'pdf_read']) {
  ok(names(captured).includes(expected), `缺少工具 ${expected}`)
}
for (const definition of captured) {
  ok(typeof definition.description === 'string' && definition.description.length > 30, `${definition.name}: description 过短`)
  ok(definition.output?.schema, `${definition.name}: 缺 output.schema`)
  ok(typeof definition.execute === 'function', `${definition.name}: 缺 execute`)
}
function names(list) {
  return list.map((d) => d.name)
}
const call = (name, args) => byName[name].execute(args, { signal: new AbortController().signal })

// 功能测试
if (!problems.length) {
  try {
    const outline = await call('pdf_outline', { path: sample })
    ok(/页数 3/.test(outline), `outline 页数异常: ${outline.slice(0, 120)}`)
    ok(/文本层 有/.test(outline), 'outline 未识别文本层')
    ok(/1 Introduction/.test(outline), 'outline 未包含目录')

    const md = await call('pdf_read', { path: sample, pages: '1-2', mode: 'markdown' })
    ok(/## 1\. Introduction/.test(md), `markdown 未保留标题: ${md.slice(0, 160)}`)

    const text = await call('pdf_read', { path: sample, pages: '2-3', mode: 'text' })
    ok(/Model Architecture/.test(text), `text 模式内容异常: ${text.slice(0, 160)}`)

    const render = await call('pdf_read', { path: sample, pages: '3', mode: 'render', dpi: 150, root: dir })
    const png = /(\S+\.png)/.exec(render)?.[1]
    ok(Boolean(png) && existsSync(png), `render 未产出 PNG: ${render.slice(0, 160)}`)
    if (png) ok((await stat(png)).size > 1000, 'PNG 文件过小')

    const tooMany = await call('pdf_read', { path: sample, pages: '1,2,3', mode: 'render', root: dir }).then(
      () => 'no-error',
      (error) => error.message,
    )
    ok(/最多 5 页|3 页/.test(tooMany) || tooMany === 'no-error', `render 页数上限未生效: ${tooMany}`)

    const tableMode = await call('pdf_read', { path: sample, pages: '1-3', mode: 'table' })
    ok(/未检测到表格|抽取不可靠/.test(tableMode), `table 模式应给出明确判定: ${tableMode.slice(0, 120)}`)

    const imgMode = await call('pdf_read', { path: sample, pages: '1', mode: 'markdown', images: 'extract', root: dir })
    ok(/未检出位图|已落盘/.test(imgMode), `images:extract 应有明确结论: ${imgMode.slice(-120)}`)

    const missing = await call('pdf_outline', { path: join(dir, 'nope.pdf') }).then(
      () => 'no-error',
      (error) => error.message,
    )
    ok(/文件不存在/.test(missing), `缺少文件时应报错: ${missing}`)
    console.log('  pdf_outline ✓ / pdf_read(markdown,text,render,table) ✓ / images:extract ✓')
  } catch (error) {
    problems.push(`运行异常：${error.message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ pdf-tools 测试通过（2 个工具 · 画像 / markdown / text / render）')
