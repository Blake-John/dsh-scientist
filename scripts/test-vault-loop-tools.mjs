#!/usr/bin/env node
/**
 * test-vault-loop-tools —— loop_note / loop_close / loop_status（全离线）
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vault-loop-tools.mjs'
import { createLoop, listLoops, noteLoop, readLoop } from '../vault-loop-core.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const root = await mkdtemp(join(tmpdir(), 'vault-lt-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'reports'), { recursive: true })

  const reg = []
  apply({ tools: { register: (d) => (reg.push(d), () => {}) } })
  ok(reg.length === 3, `应注册 3 个工具，实际 ${reg.length}`)
  const t = Object.fromEntries(reg.map((d) => [d.name, d]))
  for (const n of ['loop_note', 'loop_close', 'loop_status']) ok(t[n], `缺少 ${n}`)
  const call = (n, a) => t[n].execute(a, { cwd: root })

  // 无 loop
  const none = await call('loop_note', { note: 'x' }).then(() => 'no-error', (e) => e.message)
  ok(/没有进行中或卡住的 loop/.test(none), `无 loop 应报错：${none}`)

  const loop = await createLoop(root, { kind: 'survey', arg: 'x', requires: ['file:reports/x.md'], workMin: 2 })

  // note
  const n1 = await call('loop_note', { note: '第一步' })
  ok(/已记账/.test(n1) && /work 1 条/.test(n1), `note：${n1}`)
  const after = await readLoop(root, loop.id)
  ok(after.work.length === 1, 'work 落盘')

  // close 未满足
  const c1 = await call('loop_close', {})
  ok(/出口契约未满足/.test(c1), `close 应拒绝：${c1}`)
  ok(/缺产物/.test(c1), '列出缺产物')
  ok((await readLoop(root, loop.id)).status === 'running', '仍 running')

  // 补齐后 close
  await writeFile(join(root, 'reports/x.md'), 'ok')
  await call('loop_note', { note: '第二步' })
  const c2 = await call('loop_close', {})
  ok(/已关闭（完成）/.test(c2), `close 应成功：${c2}`)
  ok((await readLoop(root, loop.id)).status === 'closed', 'closed')

  // 失败声明
  const l2 = await createLoop(root, { kind: 'paper', arg: 'y' })
  const f1 = await call('loop_close', { loop_id: l2.id, failed: true }).then(() => 'no-error', (e) => e.message)
  ok(/必须给 --reason|必须给/.test(f1), `失败必须给原因：${f1}`)
  const f2 = await call('loop_close', { loop_id: l2.id, failed: true, reason: '找不到原文' })
  ok(/标记为「未完成」/.test(f2), `失败声明：${f2}`)

  // status
  const st = await call('loop_status', {})
  ok(/survey|paper/.test(st), `status 列表：${st}`)
  const one = await call('loop_status', { loop_id: l2.id })
  ok(/未完成|failed/.test(one), `单个 status：${one}`)

  // stalled 复活
  const l3 = await createLoop(root, { kind: 'derive', arg: 'z' })
  await noteLoop(root, l3.id, 'a'); await noteLoop(root, l3.id, 'b')
  const core = await import('../vault-loop-core.mjs')
  await core.stallLoop(root, l3.id, '测试')
  const revived = await call('loop_note', { note: '继续' })   // 不传 id：应命中 stalled 的那个
  ok(/复活/.test(revived), `复活提示：${revived}`)
  ok(revived.includes(l3.id), `应命中 stalled 的 loop：${revived}`)
  const r = await readLoop(root, l3.id)
  ok(r.status === 'running' && r.nudges === 0, `复活状态：${r.status}/${r.nudges}`)

  // 断点续跑：running 返回契约/已完成/继续方式；终态拒绝
  const l4 = await createLoop(root, { kind: 'survey', arg: 'resume', requires: ['file:reports/r.md'], workMin: 2 })
  await noteLoop(root, l4.id, '已完成一步')
  const resumed = await call('loop_status', { resume: true })
  ok(
    /继续 loop/.test(resumed) && /出口契约/.test(resumed) && /已完成的工作/.test(resumed) && /继续方式/.test(resumed),
    `resume 提示：${resumed}`,
  )
  const closedResume = await call('loop_status', { resume: true, loop_id: l2.id }).then(() => 'no-error', (e) => e.message)
  ok(/已结束/.test(closedResume), `终态不能续跑：${closedResume}`)
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-loop-tools 测试通过（记账 / 关闭 / 失败声明 / 状态 / 复活）')
