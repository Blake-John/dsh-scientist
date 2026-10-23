#!/usr/bin/env node
/**
 * test-vault-enforce —— 强制插件测试（全离线）
 *
 * 覆盖：无 loop 时零动作、pre-step 注入缺项、turn-stopping 塞 next-step 阻止收尾、
 *       拦停超限置 stalled 并放行、guard 拦截改 loop 文件但不拦读。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, reminderText, nudgeText, touchesLoopDir } from '../vault-enforce.mjs'
import { createLoop, closeLoop, isSuspended, listLoops, noteLoop, suspendEnforcement } from '../vault-loop-core.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const root = await mkdtemp(join(tmpdir(), 'vault-enforce-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'reports'), { recursive: true })

  // ── 捕获钩子 ──
  const hooks = {}
  const guards = []
  const ctx = {
    on: (event, handler) => { hooks[event] = handler; return () => {} },
    tools: { guard: (fn) => { guards.push(fn); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { ensure: async () => root } : undefined),
  }
  apply(ctx)
  ok(typeof hooks['agent/pre-step'] === 'function', '注册了 pre-step')
  ok(typeof hooks['agent/turn-stopping'] === 'function', '注册了 turn-stopping')
  ok(guards.length === 1, '注册了一个 guard')

  const agent = { id: 's1', session: { header: { cwd: root } }, send: (msg, target, wakeup) => { sent.push({ msg, target, wakeup }) } }
  const sent = []
  const nextDefault = async () => ({ kind: 'enter', messages: [{ id: 'orig', role: 'user', content: [], source: { kind: 'user' } }] })

  // ── 无 loop：完全惰性 ──
  const idle = await hooks['agent/pre-step']({ agent, messages: [] }, nextDefault)
  ok(idle.kind === 'enter' && idle.messages.length === 1, '无 loop 时不注入')
  await hooks['agent/turn-stopping']({ agent, turn: 1 })
  ok(sent.length === 0, '无 loop 时不拦停')

  // ── 有 loop：pre-step 注入 ──
  const loop = await createLoop(root, { kind: 'survey', arg: 'x', requires: ['file:reports/x.md'], workMin: 2 })
  await closeLoop(root, loop.id).catch(() => {})   // 制造 lastFailure
  const withLoop = await hooks['agent/pre-step']({ agent, messages: [] }, nextDefault)
  ok(withLoop.messages.length === 2, `应追加一条提醒，实际 ${withLoop.messages.length}`)
  ok(/出口契约/.test(withLoop.messages[1].content[0].text), '提醒含契约')
  ok(/产出 `reports\/x\.md`/.test(withLoop.messages[1].content[0].text), `提醒列出具体产物：${withLoop.messages[1].content[0].text}`)

  // next() 被拒绝时不注入
  const rejected = await hooks['agent/pre-step']({ agent, messages: [] }, async () => ({ kind: 'reject' }))
  ok(rejected.kind === 'reject', 'reject 原样透传')

  // ── turn-stopping：塞 next-step ──
  await hooks['agent/turn-stopping']({ agent, turn: 1 })
  ok(sent.length === 1, `应拦停一次，实际 ${sent.length}`)
  ok(sent[0].target === 'next-step' && sent[0].wakeup === false, `send 参数：${JSON.stringify({ t: sent[0].target, w: sent[0].wakeup })}`)
  ok(/尚未完成/.test(sent[0].msg.content[0].text), '拦停消息内容')
  const after1 = (await listLoops(root))[0]
  ok(after1.nudges === 1, `nudges 落盘：${after1.nudges}`)

  // ── 超限：置 stalled 且不再拦 ──
  await hooks['agent/turn-stopping']({ agent, turn: 2 })
  await hooks['agent/turn-stopping']({ agent, turn: 3 })
  ok(sent.length === 3, `前三次都拦：${sent.length}`)
  await hooks['agent/turn-stopping']({ agent, turn: 4 })
  ok(sent.length === 3, `超限后不再拦：${sent.length}`)
  const stalled = (await listLoops(root))[0]
  ok(stalled.status === 'stalled', `应置 stalled：${stalled.status}`)
  ok(/拦停 3 次/.test(stalled.stallReason ?? ''), `stall 原因：${stalled.stallReason}`)

  // stalled 后 pre-step 不再注入
  const afterStall = await hooks['agent/pre-step']({ agent, messages: [] }, nextDefault)
  ok(afterStall.messages.length === 1, 'stalled 后不注入')

  // ── 挂起：非 loop 命令执行期间不拦 ──
  const l5 = await createLoop(root, { kind: 'survey', arg: 'suspend', requires: ['file:reports/s.md'] })
  await suspendEnforcement(root, 60_000)
  ok(await isSuspended(root), '挂起标记已写入')
  const beforeSuspend = sent.length
  await hooks['agent/turn-stopping']({ agent, turn: 9 })
  ok(sent.length === beforeSuspend, '挂起期间不拦停')
  const suspendedPre = await hooks['agent/pre-step']({ agent, messages: [] }, nextDefault)
  ok(suspendedPre.messages.length === 1, '挂起期间不注入')
  // 记账会清除挂起并恢复强制
  await noteLoop(root, l5.id, '回到 loop')
  ok(!(await isSuspended(root)), '记账后挂起被清除')
  await hooks['agent/turn-stopping']({ agent, turn: 10 })
  ok(sent.length === beforeSuspend + 1, '恢复后重新拦停')

  // ── guard ──
  const guard = guards[0]
  ok(guard({ name: 'write', arguments: { file_path: `${root}/research/loops/x.json` } }) !== undefined, 'write 改 loop 文件应被拦')
  ok(guard({ name: 'edit', arguments: { file_path: 'research/loops/x.json' } }) !== undefined, 'edit 改 loop 文件应被拦')
  ok(guard({ name: 'bash', arguments: { command: 'echo {} > research/loops/x.json' } }) !== undefined, 'bash 重定向写 loop 应被拦')
  ok(guard({ name: 'bash', arguments: { command: 'rm -f research/loops/x.json' } }) !== undefined, 'bash rm loop 应被拦')
  ok(guard({ name: 'bash', arguments: { command: 'cat research/loops/x.json' } }) === undefined, 'bash 读 loop 不应被拦')
  ok(guard({ name: 'write', arguments: { file_path: 'reports/x.md' } }) === undefined, '写普通文件不应被拦')
  ok(guard({ name: 'bash', arguments: { command: 'ls reports' } }) === undefined, '无关命令不应被拦')

  // ── 文本工具 ──
  ok(/需要满足/.test(nudgeText({ id: 'l', kind: 'survey', arg: 'x', exit: { requires: ['file:reports/x.md'], workMin: 2 }, work: [] })), 'nudgeText 含契约')
  ok(/产出 `reports\/x\.md`/.test(nudgeText({ id: 'l', kind: 'survey', arg: 'x', exit: { requires: ['file:reports/x.md'], workMin: 2 }, work: [] })), 'nudgeText 给出具体产物')
  ok(/work 记录 ≥2 条（当前 0 条/.test(nudgeText({ id: 'l', kind: 'survey', arg: 'x', exit: { requires: [], workMin: 2 }, work: [] })), 'nudgeText 给出 work 差距')
  ok(reminderText({ id: 'l', exit: { requires: [], workMin: 0 } }) === null, '无契约项时 reminder 为空')
  ok(touchesLoopDir('bash', { command: 'echo 1 > research/loops/a.json' }) === true, 'touchesLoopDir 写')
  ok(touchesLoopDir('bash', { command: 'cat research/loops/a.json' }) === false, 'touchesLoopDir 读')

  // ── 复活：note 后重新拦停 ──
  const revived = await noteLoop(root, stalled.id, '继续')
  ok(revived.status === 'running', 'note 后复活')
  ok(revived.nudges === 0, `复活应重置拦停预算，实际 ${revived.nudges}`)
  const before = sent.length
  await hooks['agent/turn-stopping']({ agent, turn: 5 })
  ok(sent.length === before + 1, '复活后应重新开始拦停')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-enforce 测试通过（惰性 / 注入 / 拦停 / 超限降级 / guard）')
