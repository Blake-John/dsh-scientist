#!/usr/bin/env node
/**
 * test-vault-loop —— 约定 loop 的状态机、出口校验与 CLI（全离线）
 *
 * 覆盖：创建/ID 唯一性、记账、四种终态、惰性超时、失败声明必须给原因、
 *       出口校验（文件/内容/引用数/work 条数）、CLI 全流程。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  abortLoop,
  activeLoop,
  closeLoop,
  createLoop,
  listLoops,
  noteLoop,
  readLoop,
  verifyExit,
} from '../vault-loop-core.mjs'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'vault.mjs')
const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }
const expectErr = async (fn, re, label) => {
  const out = await fn().then(() => 'no-error', (e) => `${e.code ?? ''} ${e.message}`)
  ok(re.test(out), `${label}: ${out}`)
}

const root = await mkdtemp(join(tmpdir(), 'vault-loop-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'reports'), { recursive: true })

  // ── 创建 ──
  const loop = await createLoop(root, {
    kind: 'survey',
    arg: 'PINN 求解器',
    requires: ['file:reports/landscape-pinn.md', 'min-citations:reports/landscape-pinn.md:3'],
    checks: ['contains:reports/landscape-pinn.md:方法|gap'],
    workMin: 2,
  })
  ok(/^survey-pinn-求解器-\d{8}T\d{4}$/.test(loop.id), `id 格式（中文保留）：${loop.id}`)
  ok(loop.status === 'running', '初始 running')
  ok(loop.nudges === 0 && loop.maxNudges === 3, '默认拦停 0/3')
  const onDisk = JSON.parse(await readFile(join(root, 'research/loops', `${loop.id}.json`), 'utf8'))
  ok(onDisk.id === loop.id, '已落盘')

  // 同分钟内再建同 kind 同 arg → id 不冲突
  const dup = await createLoop(root, { kind: 'survey', arg: 'PINN 求解器' })
  ok(dup.id !== loop.id, `ID 必须唯一：${dup.id}`)
  await abortLoop(root, dup.id, '测试用')

  // ── 出口校验：缺产物 ──
  const v1 = await verifyExit(root, await readLoop(root, loop.id))
  ok(!v1.ok, '缺产物时应不通过')
  ok(v1.failures.some((f) => f.includes('缺产物')), `缺产物信息：${JSON.stringify(v1.failures)}`)
  ok(v1.failures.some((f) => f.includes('work 记录不足')), 'work 不足应报出')

  // ── close 被拒绝 ──
  await expectErr(() => closeLoop(root, loop.id), /出口契约未满足/, '不满足时 close 应拒绝')
  const afterFail = await readLoop(root, loop.id)
  ok(afterFail.status === 'running', '拒绝后仍为 running')
  ok(afterFail.exit.lastFailure?.failures.length > 0, '记录 lastFailure')

  // ── 补产物与记账 ──
  await writeFile(join(root, 'reports/landscape-pinn.md'), '# PINN\n\n方法对比\n\n[@a2020] [@b2021] [@c2022]\n\n## gap\n')
  await noteLoop(root, loop.id, '完成流派梳理')
  await noteLoop(root, loop.id, '完成 gap 分析')
  const v2 = await verifyExit(root, await readLoop(root, loop.id))
  ok(v2.ok, `补齐后应通过：${JSON.stringify(v2.failures)}`)

  // ── 正常关闭 ──
  const closed = await closeLoop(root, loop.id)
  ok(closed.status === 'closed', 'close 后 closed')
  ok(closed.exit.done === true, 'exit.done')
  await expectErr(() => closeLoop(root, loop.id), /已结束/, '重复 close 应拒绝')
  await expectErr(() => noteLoop(root, loop.id, 'x'), /已结束/, '已关闭不能记账')

  // ── 引用数不足 ──
  const loop2 = await createLoop(root, {
    kind: 'paper',
    arg: 'x',
    requires: ['min-citations:reports/short.md:5'],
  })
  await writeFile(join(root, 'reports/short.md'), '[@only2020]\n')
  const v3 = await verifyExit(root, await readLoop(root, loop2.id))
  ok(v3.failures.some((f) => f.includes('引用不足：需要 ≥5 条，实际 1 条')), `引用计数：${JSON.stringify(v3.failures)}`)

  // ── 失败声明 ──
  await expectErr(() => closeLoop(root, loop2.id, { failed: true }), /必须给 --reason/, '失败必须给原因')
  const failed = await closeLoop(root, loop2.id, { failed: true, reason: '找不到原文' })
  ok(failed.status === 'failed', 'failed 终态')
  ok(failed.failReason === '找不到原文', '记录原因')

  // ── 中止 ──
  const loop3 = await createLoop(root, { kind: 'derive', arg: 'y' })
  const aborted = await abortLoop(root, loop3.id, '不需要了')
  ok(aborted.status === 'aborted', 'aborted 终态')

  // ── 惰性超时 ──
  const loop4 = await createLoop(root, { kind: 'write', arg: 'z' })
  const file4 = join(root, 'research/loops', `${loop4.id}.json`)
  const raw4 = JSON.parse(await readFile(file4, 'utf8'))
  raw4.lastActivity = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  await writeFile(file4, JSON.stringify(raw4, null, 2))
  const stale = await readLoop(root, loop4.id)
  ok(stale.status === 'stalled', `超时应降级为 stalled，实际 ${stale.status}`)
  const revived = await noteLoop(root, loop4.id, '继续做')
  ok(revived.status === 'running', '有动作即复活为 running')

  // ── 列表与 active ──
  const all = await listLoops(root)
  ok(all.length === 5, `应有 5 个 loop，实际 ${all.length}`)
  const runningOnly = await listLoops(root, { status: 'running' })
  ok(runningOnly.every((l) => l.status === 'running'), '状态过滤')
  const active = await activeLoop(root)
  ok(active?.id === loop4.id, `active 取最近开启：${active?.id}`)

  // ── 新增校验：contains 忽略大小写 / markdown-table / contains-any ──
  const loop5 = await createLoop(root, {
    kind: 'survey',
    arg: 'case',
    requires: ['contains:reports/case.md:gap', 'markdown-table:reports/case.md'],
    checks: ['contains-any:reports/case.md:空白|缺口'],
  })
  await writeFile(
    join(root, 'reports/case.md'),
    '# x\n\n| 方法 | 年份 |\n|---|---|\n| A | 2020 |\n\n## Gap\n\n研究缺口\n',
  )
  const v5 = await verifyExit(root, await readLoop(root, loop5.id))
  ok(v5.ok, `大小写/表格/任一子串应通过：${JSON.stringify(v5.failures)}`)
  await abortLoop(root, loop5.id, '测试用')

  const loop6 = await createLoop(root, {
    kind: 'survey',
    arg: 'notable',
    requires: ['markdown-table:reports/notable.md'],
  })
  await writeFile(join(root, 'reports/notable.md'), '# x\n\n没有表格\n')
  const v6 = await verifyExit(root, await readLoop(root, loop6.id))
  ok(v6.failures.some((f) => f.includes('没有 Markdown 表格')), `缺表格应报出：${JSON.stringify(v6.failures)}`)
  await abortLoop(root, loop6.id, '测试用')

  const loop7 = await createLoop(root, {
    kind: 'derive',
    arg: 'nany',
    requires: ['contains-any:reports/nany.md:数值|量纲'],
  })
  await writeFile(join(root, 'reports/nany.md'), '只有文字\n')
  const v7 = await verifyExit(root, await readLoop(root, loop7.id))
  ok(v7.failures.some((f) => f.includes('缺少以下任一项')), `contains-any 应报出：${JSON.stringify(v7.failures)}`)
  await abortLoop(root, loop7.id, '测试用')

  // ── paper-note：旧笔记不算 / 缺 bib 不算 / 新笔记 + bib 通过 ──
  await mkdir(join(root, 'literature', 'notes'), { recursive: true })
  const oldNote = join(root, 'literature/notes/old2020x.md')
  await writeFile(oldNote, '# old\n\n方法\n结果\n局限\n')
  await utimes(oldNote, new Date('2020-01-01'), new Date('2020-01-01'))
  await writeFile(join(root, 'literature/references.bib'), '@article{old2020x,\n  title={Old},\n}\n')
  const loop8 = await createLoop(root, { kind: 'paper', arg: 'p', requires: ['paper-note:方法|结果|局限'] })
  const v8 = await verifyExit(root, await readLoop(root, loop8.id))
  ok(v8.failures.some((f) => f.includes('没有本次 loop 新建或更新')), `旧笔记不应算：${JSON.stringify(v8.failures)}`)

  await writeFile(
    join(root, 'literature/notes/raissi2019pinn.md'),
    '# PINN\n\n## 方法\n...\n## 结果\n...\n## 局限\n...\n',
  )
  const v9 = await verifyExit(root, await readLoop(root, loop8.id))
  ok(v9.failures.some((f) => f.includes('没有对应的 references.bib 条目')), `缺 bib 应报出：${JSON.stringify(v9.failures)}`)

  await writeFile(
    join(root, 'literature/references.bib'),
    '@article{old2020x,\n  title={Old},\n}\n\n@article{raissi2019pinn,\n  title={PINN},\n}\n',
  )
  const v10 = await verifyExit(root, await readLoop(root, loop8.id))
  ok(v10.ok, `新笔记 + bib 应通过：${JSON.stringify(v10.failures)}`)
  await abortLoop(root, loop8.id, '测试用')

  // ── CLI 全流程 ──
  const cli = async (...args) => {
    try {
      const { stdout } = await run(process.execPath, [CLI, 'loop', ...args, '--root', root], { timeout: 30000 })
      return { code: 0, out: stdout }
    } catch (error) {
      return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }

  const made = await cli('new', 'survey', 'CLI 测试', '--requires', 'file:reports/cli.md', '--work-min', '1')
  ok(made.code === 0, `CLI new 失败：${made.out}`)
  const cliId = made.out.trim()
  ok(/^survey-cli-/.test(cliId), `CLI 返回 id：${cliId}`)

  const listed = await cli('list', '--status', 'running')
  ok(/CLI 测试|survey-cli-/.test(listed.out), `CLI list：${listed.out}`)

  const shown = await cli('show', cliId)
  ok(/出口契约：未满足/.test(shown.out), `CLI show 应报未满足：${shown.out}`)

  const closedTooEarly = await cli('close', cliId)
  ok(closedTooEarly.code !== 0 && /出口契约未满足/.test(closedTooEarly.out), `CLI close 应失败：${closedTooEarly.out}`)

  await writeFile(join(root, 'reports/cli.md'), 'ok')
  await cli('note', cliId, '做完了')
  const closedOk = await cli('close', cliId)
  ok(closedOk.code === 0 && /已关闭（已完成）/.test(closedOk.out), `CLI close 应成功：${closedOk.out}`)

  const abortedCli = await cli('abort', cliId)
  ok(abortedCli.code !== 0, '已关闭的 loop 不能再 abort')

  const badSub = await cli('nonsense')
  ok(badSub.code !== 0 && /未知子命令/.test(badSub.out), '未知子命令应报错')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-loop 测试通过（状态机 / 出口校验 / 四种终态 / 惰性超时 / CLI）')
