#!/usr/bin/env node
/**
 * test-cite-check-deep —— cite-check --deep 的全链校验测试（全离线）
 *
 * 覆盖：悬空内部引用（实验→工件、假设→实验/评审、工件→实验）判为错误；
 *       citekey 不在文献库中与证据覆盖率缺口判为警告。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cite-check.mjs')
const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const citeCheck = async (root, extra = []) => {
  try {
    const { stdout } = await run(process.execPath, [CLI, '--root', root, '--no-network', ...extra], { timeout: 30000 })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const root = await mkdtemp(join(tmpdir(), 'ccdeep-'))
try {
  await mkdir(join(root, 'literature', 'notes'), { recursive: true })
  await mkdir(join(root, 'research', 'records', 'good/v1'), { recursive: true })
  await writeFile(join(root, 'literature', 'notes', 'raissi2019pinn.md'), '---\ncitekey: raissi2019pinn\n---\n')
  await writeFile(
    join(root, 'literature', 'references.bib'),
    `@article{raissi2019pinn,
  author = {Raissi, Maziar and Perdikaris, Paris and Karniadakis, George E.},
  title = {Physics-informed neural networks},
  journal = {Journal of Computational Physics},
  year = {2019},
  volume = {378},
  pages = {686--707},
  doi = {10.1016/j.jcp.2018.10.045}
}
`,
  )
  // 一个真实工件（用于验证不误报）
  await writeFile(
    join(root, 'research', 'records', 'good/v1/manifest.json'),
    JSON.stringify({
      name: 'good', slug: 'good', version: 1, kind: 'data', createdAt: '2026-01-01T00:00:00Z',
      activity: { command: 'python x.py', exitCode: 0, actionStatus: 'CompletedActionStatus', seed: 1 },
      inputs: [{ path: 'a.txt', sourcePath: 'a.txt', sha256: 'a'.repeat(64), bytes: 1 }],
      raw: [], links: { experiment: 'E01', hypothesis: 'H1', citekeys: ['raissi2019pinn'] }, tags: [], deprecated: null,
    }),
  )
  await writeFile(join(root, 'research', 'records', 'index.json'), JSON.stringify({ records: [{ name: 'good', slug: 'good', kind: 'data', latest: 1, versions: 1 }] }))

  await writeFile(
    join(root, 'research', 'study.json'),
    JSON.stringify({
      schema: 1, title: '测试', question: { text: 'q', history: [] },
      loop: { phase: 'experiment', iteration: 1, history: [] },
      hypotheses: [
        { id: 'H1', text: 'a', status: 'testing', citekeys: ['raissi2019pinn'], experiments: ['E01'], reviews: [] },
        { id: 'H2', text: 'b', status: 'proposed', citekeys: ['ghost2020'], experiments: ['E99'], reviews: ['R99'] },
        { id: 'H3', text: 'c', status: 'proposed', citekeys: [], experiments: [], reviews: [] },
      ],
      experiments: [
        { id: 'E01', title: 't', hypothesis: 'H1', records: ['good@v1'], status: 'done' },
        { id: 'E02', title: 'u', hypothesis: 'H7', records: ['missing-artifact@v1'], status: 'planned' },
      ],
      decisions: [{ id: 'D1', question: 'q', chosen: 'c', rationale: 'r', citekeys: ['ghost2020'] }],
      reviews: [{ id: 'R01', target: 'x', verdict: 'supported' }],
      claims: [
        { id: 'C1', text: 'no evidence', evidence: { citekeys: [], records: [] }, status: 'unverified' },
        { id: 'C2', text: 'ok', evidence: { citekeys: ['raissi2019pinn'], records: ['good@v1'] }, status: 'supported' },
      ],
    }),
  )

  const deep = await citeCheck(root, ['--deep'])
  ok(deep.code !== 0, `有悬空引用时应非零退出（实际 ${deep.code}）`)

  // 硬错误：内部悬空引用
  ok(/实验 E02 关联的假设 H7 不存在/.test(deep.out), '应报出实验→假设悬空')
  ok(/实验 E02 指向不存在的工件 missing-artifact@v1/.test(deep.out), '应报出实验→工件悬空')
  ok(/假设 H2 指向不存在的实验 E99/.test(deep.out), '应报出假设→实验悬空')
  ok(/假设 H2 指向不存在的评审 R99/.test(deep.out), '应报出假设→评审悬空')

  // 软提醒：citekey 不在库中
  ok(/citekey 不在文献库中: ghost2020/.test(deep.out), '应提示未登记的 citekey')
  ok(/假设 H2|决策 D1/.test(deep.out), '未登记 citekey 应指明引用方')

  // 覆盖率报告
  ok(/研究链路: 假设 3 · 实验 2 · 决策 1 · 论断 2 · 评审 1/.test(deep.out), `链路统计：${deep.out.match(/研究链路:.*/)?.[0]}`)
  ok(/证据覆盖: 假设有文献 2\/3 · 论断有证据 1\/2/.test(deep.out), `覆盖统计：${deep.out.match(/证据覆盖:.*/)?.[0]}`)
  ok(/无文献支撑的假设 1 条: H3/.test(deep.out), '应列出无文献支撑的假设')
  ok(/无证据的论断 1 条: C1/.test(deep.out), '应列出无证据的论断')
  ok(/未验证的论断 1 条: C1/.test(deep.out), '应列出未验证论断')

  // 无悬空时：只应有警告，退出码 0
  const clean = await mkdtemp(join(tmpdir(), 'ccdeep-clean-'))
  try {
    await mkdir(join(clean, 'literature', 'notes'), { recursive: true })
    await mkdir(join(clean, 'research'), { recursive: true })
    await writeFile(join(clean, 'literature', 'notes', 'raissi2019pinn.md'), '---\ncitekey: raissi2019pinn\n---\n')
    await writeFile(join(clean, 'literature', 'references.bib'), await readFileBib(root))
    await writeFile(
      join(clean, 'research', 'study.json'),
      JSON.stringify({
        schema: 1, title: '干净', question: { text: 'q', history: [] },
        loop: { phase: 'analysis', iteration: 1, history: [] },
        hypotheses: [{ id: 'H1', text: 'a', status: 'supported', citekeys: ['raissi2019pinn'], experiments: [], reviews: [] }],
        experiments: [], decisions: [], reviews: [],
        claims: [{ id: 'C1', text: 'ok', evidence: { citekeys: ['raissi2019pinn'], records: [] }, status: 'supported' }],
      }),
    )
    const cleanResult = await citeCheck(clean, ['--deep'])
    ok(cleanResult.code === 0, `干净项目应退出 0（实际 ${cleanResult.code}）\n${cleanResult.out}`)
    ok(/无错误/.test(cleanResult.out), '干净项目应报无错误')
  } finally {
    await rm(clean, { recursive: true, force: true })
  }

  // 不带 --deep 时不检查研究链路
  const shallow = await citeCheck(root)
  ok(!/研究链路/.test(shallow.out), '不带 --deep 时不做链路检查')

  // --json 输出
  const json = await citeCheck(root, ['--deep', '--json'])
  const parsed = JSON.parse(json.out)
  ok(Array.isArray(parsed.errors) && parsed.errors.length > 0, '--json 输出含 errors')
  ok(parsed.infos.some((i) => i.includes('研究链路')), '--json infos 含链路统计')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function readFileBib(from) {
  const { readFile } = await import('node:fs/promises')
  return await readFile(join(from, 'literature', 'references.bib'), 'utf8')
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ cite-check --deep 测试通过（悬空引用判错 / citekey 与覆盖率判警）')
