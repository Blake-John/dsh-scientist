#!/usr/bin/env node
/**
 * test-vault-commands —— 7 个斜杠命令的测试（全离线）
 *
 * 覆盖：注册、参数解析、自动建项目、同类互斥、--dry-run 不启动、
 *       loop 创建与出口契约注入、/status 两段式、/status --abort 逃生舱、/study-init 更新。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vault-commands.mjs'
import { createLoop, listLoops } from '../vault-loop-core.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const root = await mkdtemp(join(tmpdir(), 'vault-cmd-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'reports'), { recursive: true })

  // ── 假 ctx / agent ──
  const registered = []
  const followups = []
  const ctx = {
    get: (name) => (name === 'sessions' ? { get: () => ({ cwd: root }) } : undefined),
    inject: (_deps, cb) => cb({ commands: { register: (def) => registered.push(def) } }),
  }
  apply(ctx)

  const names = registered.map((d) => d.name).sort()
  ok(registered.length === 7, `应注册 7 个命令，实际 ${registered.length}: ${names}`)
  for (const expected of ['survey', 'paper', 'derive', 'write', 'review', 'status', 'study-init']) {
    ok(names.includes(expected), `缺少命令 /${expected}`)
  }
  for (const def of registered) {
    ok(typeof def.description === 'string' && def.description.length >= 10, `/${def.name} 描述过短`)
    ok(typeof def.handler === 'function', `/${def.name} 缺 handler`)
  }

  const byName = Object.fromEntries(registered.map((d) => [d.name, d]))
  const invoke = async (name, rawInput) => {
    followups.length = 0
    return await byName[name].handler({
      agent: { id: 's1', followup: (m) => followups.push(m) },
      rawInput,
      attachments: [],
    })
  }

  // ── 无参报错 ──
  for (const name of ['survey', 'paper', 'derive']) {
    const res = await invoke(name, '')
    ok(res.kind === 'error' && /用法/.test(res.text), `/${name} 无参应报错：${JSON.stringify(res)}`)
  }

  // ── --no-init 且无项目 → 报错 ──
  const noInit = await invoke('survey', 'PINN --no-init')
  ok(noInit.kind === 'error' && /--no-init/.test(noInit.text), `--no-init 无项目应报错：${noInit.text}`)

  // ── 自动建项目 + 启动 loop ──
  const res = await invoke('survey', 'PINN 求解器')
  ok(res.kind === 'success', `survey 应成功：${JSON.stringify(res)}`)
  ok(/已自动创建研究项目/.test(res.text), '应提示自动建项目')
  const study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.autoCreated === true, 'autoCreated 标记')
  ok(study.origin === '/survey PINN 求解器', `origin：${study.origin}`)
  ok(study.title === 'PINN 求解器', '标题取参数')

  const loops = await listLoops(root)
  ok(loops.length === 1 && loops[0].kind === 'survey', '创建了 survey loop')
  ok(loops[0].exit.workMin === 3, 'workMin=3')
  ok(loops[0].maxNudges === 3, 'maxNudges=3')
  ok(loops[0].skill === 'domain-survey', 'skill 记录')
  ok(loops[0].exit.requires.some((r) => r.includes('reports/landscape-pinn.md')), `产物路径：${loops[0].exit.requires}`)

  // 注入的 prompt 必须含出口契约与记账指令
  ok(followups.length === 1, `应注入一条消息，实际 ${followups.length}`)
  const prompt = followups[0].content[0].text
  ok(/## 出口契约/.test(prompt), 'prompt 含出口契约')
  ok(/## 步骤骨架/.test(prompt), 'prompt 含步骤骨架')
  ok(/domain-survey/.test(prompt), 'prompt 引用技能')
  ok(/loop_close\(\)/.test(prompt), 'prompt 含 loop_close 指令')
  ok(/failed=true, reason=/.test(prompt), 'prompt 含诚实失败出口')
  ok(/loop_note\(/.test(prompt), 'prompt 含 loop_note 记账')
  ok(followups[0].role === 'user' && typeof followups[0].id === 'string', '消息形状符合 MessageBase')

  // ── 同类互斥 ──
  const dup = await invoke('survey', '另一个方向')
  ok(dup.kind === 'error' && /已有 survey loop/.test(dup.text), `同类互斥：${dup.text}`)

  // ── 跨类不拦 ──
  const derive = await invoke('derive', '梯度推导')
  ok(derive.kind === 'success', `跨类应允许：${JSON.stringify(derive)}`)

  // ── --dry-run 不建 loop ──
  const before = (await listLoops(root)).length
  const dry = await invoke('paper', '10.1038/nature12373 --dry-run')
  ok(dry.kind === 'success' && /\(dry-run\)/.test(dry.text), 'dry-run 返回 prompt')
  ok(followups.length === 0, 'dry-run 不注入消息')
  ok((await listLoops(root)).length === before, 'dry-run 不创建 loop')

  // ── write 默认目标 ──
  const write = await invoke('write', '')
  ok(write.kind === 'success', `write 无参应成功：${JSON.stringify(write)}`)
  const writeLoop = (await listLoops(root)).find((l) => l.kind === 'write')
  ok(writeLoop.exit.requires[0].includes('reports/progress-'), `默认目标：${writeLoop.exit.requires[0]}`)

  // ── review 的校验项 ──
  const review = await invoke('review', '')
  ok(review.kind === 'success', `review 应成功：${JSON.stringify(review)}`)
  const reviewLoop = (await listLoops(root)).find((l) => l.kind === 'review')
  ok(reviewLoop.exit.requires.includes('reviews-since-open'), 'review 用 reviews-since-open')

  // ── /status ──
  const status = await invoke('status', '')
  ok(status.kind === 'success', '/status 应成功')
  ok(/进行中/.test(status.text), '/status 含进行中')
  ok(/PINN 求解器/.test(status.text), '/status 含项目名')
  ok(followups.length === 1 && /\/status 复看/.test(followups[0].content[0].text), '/status 默认注入复看')
  ok(/不超过 5 行/.test(followups[0].content[0].text), '复看有硬预算')

  const brief = await invoke('status', '--brief')
  ok(brief.kind === 'success' && followups.length === 0, '--brief 不注入')

  const json = await invoke('status', '--json')
  ok(json.kind === 'success' && /"loops"/.test(json.text), '--json 输出结构化')

  // ── 空工作区：/status 不注入无意义的复看 ──
  const emptyRoot = await mkdtemp(join(tmpdir(), 'vault-cmd-empty-'))
  try {
    const reg = []
    apply({
      get: (n) => (n === 'sessions' ? { get: () => ({ cwd: emptyRoot }) } : undefined),
      inject: (_d, cb) => cb({ commands: { register: (def) => reg.push(def) } }),
    })
    const localFollowups = []
    const st = await reg.find((d) => d.name === 'status').handler({
      agent: { id: 'e', followup: (m) => localFollowups.push(m) },
      rawInput: '',
      attachments: [],
    })
    ok(/没有研究项目/.test(st.text), `空工作区提示：${st.text}`)
    ok(localFollowups.length === 0, `空工作区不应注入复看，实际 ${localFollowups.length}`)
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
  }

  // ── /status --abort 逃生舱 ──
  const target = (await listLoops(root, { status: 'running' }))[0]
  const aborted = await invoke('status', `--abort ${target.id}`)
  ok(aborted.kind === 'success' && /已中止/.test(aborted.text), `abort：${aborted.text}`)
  const afterAbort = (await listLoops(root)).find((l) => l.id === target.id)
  ok(afterAbort.status === 'aborted', 'abort 生效')

  // ── /study-init 更新 ──
  const init1 = await invoke('study-init', '新标题 --question "核心问题是什么？"')
  ok(init1.kind === 'success' && /已更新研究/.test(init1.text), `study-init 更新：${init1.text}`)
  const updated = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(updated.title === '新标题', '标题已更新')
  ok(updated.question.text === '核心问题是什么？', '问题已更新')

  // 空目录里 study-init 应创建
  const root2 = await mkdtemp(join(tmpdir(), 'vault-cmd2-'))
  try {
    const ctx2 = {
      get: (name) => (name === 'sessions' ? { get: () => ({ cwd: root2 }) } : undefined),
      inject: (_d, cb) => cb({ commands: { register: (def) => registered.push(def) } }),
    }
    const reg2 = []
    apply({ ...ctx2, inject: (_d, cb) => cb({ commands: { register: (def) => reg2.push(def) } }) })
    const created = await reg2.find((d) => d.name === 'study-init').handler({
      agent: { id: 's', followup: () => {} },
      rawInput: '从零开始',
      attachments: [],
    })
    ok(/已创建研究/.test(created.text), `空目录创建：${created.text}`)
    ok(Boolean(await readFile(join(root2, 'research/study.json'), 'utf8')), 'study.json 已生成')
  } finally {
    await rm(root2, { recursive: true, force: true })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-commands 测试通过（注册 / 自动建项目 / 互斥 / dry-run / 出口契约 / status）')
