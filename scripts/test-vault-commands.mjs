#!/usr/bin/env node
/**
 * test-vault-commands —— 12 个斜杠命令的测试（全离线）
 *
 * 覆盖：注册、参数解析、自动建项目、阶段命令、严格顺序、--dry-run、
 *       /survey 状态页与 --next、/status、/study-init、工作区切换。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __test__, sessionCwd } from '../vault-commands.mjs'
import { layoutPaths, projectLayout } from '../project-layout.mjs'
import { createLoop, closeLoop, listLoops, noteLoop } from '../vault-loop-core.mjs'
import { getSurveyState, surveySlug } from '../vault-survey.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const root = await mkdtemp(join(tmpdir(), 'vault-cmd-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'reports'), { recursive: true })

  // ── 假 ctx / agent ──
  // 真实宿主没有 session.cwd；命令必须走 workingDirectory 服务。
  const wd = (cwd) => ({ ensure: async () => cwd, get: () => cwd, set: async (_agent, next) => next })
  const registered = []
  const followups = []
  const ctx = {
    get: (name) => (name === 'workingDirectory' ? wd(root) : undefined),
    inject: (_deps, cb) => cb({ commands: { register: (def) => registered.push(def) } }),
  }
  apply(ctx)
  ok((await sessionCwd(ctx, { id: 's1' })) === root, 'sessionCwd 必须走 workingDirectory，而不是 process.cwd')

  const names = registered.map((d) => d.name).sort()
  ok(registered.length === 12, `应注册 12 个命令，实际 ${registered.length}: ${names}`)
  for (const expected of [
    'survey', 'survey-scan', 'survey-scholar', 'survey-map', 'survey-papers', 'survey-report',
    'paper', 'derive', 'write', 'review', 'status', 'study-init',
  ]) {
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

  // ── 阶段契约计划（不建 loop）：中文保留 / 每阶段产物 / 门槛 ──
  const planOf = (name, arg) => __test__.LOOP_COMMANDS.find((c) => c.name === name).plan(arg, { paths: layoutPaths('v2') })
  ok(planOf('survey-scan', '航磁补偿').artifacts[0] === 'knowledge/surveys/航磁补偿/scope.md', `scan 产物：${planOf('survey-scan', '航磁补偿').artifacts}`)
  ok(planOf('survey-scholar', '航磁补偿').artifacts[0] === 'knowledge/surveys/航磁补偿/queries.md', `scholar 产物：${planOf('survey-scholar', '航磁补偿').artifacts}`)
  ok(planOf('survey-map', '航磁补偿').artifacts[0] === 'knowledge/surveys/航磁补偿/landscape.md', `map 产物：${planOf('survey-map', '航磁补偿').artifacts}`)
  ok(planOf('survey-papers', '航磁补偿').artifacts[0] === 'knowledge/surveys/航磁补偿/papers.md', `papers 产物：${planOf('survey-papers', '航磁补偿').artifacts}`)
  ok(planOf('survey-report', '航磁补偿').artifacts[0] === 'knowledge/surveys/航磁补偿/report.md', `report 产物：${planOf('survey-report', '航磁补偿').artifacts}`)
  ok(planOf('survey-scan', 'x').checks.some((c) => c.startsWith('min-links:') && c.endsWith(':8')), `scan 应有 min-links 8：${planOf('survey-scan', 'x').checks}`)
  ok(planOf('survey-scholar', 'x').checks.some((c) => c.startsWith('min-citekeys:') && c.endsWith(':12')), `scholar 应有 ≥12 候选：${planOf('survey-scholar', 'x').checks}`)
  ok(planOf('survey-papers', 'x').checks.some((c) => c.startsWith('min-citekeys:') && c.endsWith(':10')), `papers 应有 ≥10 篇：${planOf('survey-papers', 'x').checks}`)
  ok(planOf('survey-scan', 'x').nextCommand === '/survey-scholar "x"', `scan next：${planOf('survey-scan', 'x').nextCommand}`)
  ok(planOf('survey-report', 'x').nextCommand === null, 'report next=null')
  ok(planOf('derive', '航磁补偿').artifacts[0] === 'experiments/derivations/航磁补偿/derive.py', `derive 中文目录：${planOf('derive', '航磁补偿').artifacts[0]}`)
  ok(planOf('write', '航磁补偿').artifacts[0] === 'knowledge/reports/航磁补偿.md', `write 中文目标：${planOf('write', '航磁补偿').artifacts[0]}`)
  ok(planOf('write', '§3').artifacts[0] === 'outputs/manuscript/section-3.md', `write 按章节：${planOf('write', '§3').artifacts[0]}`)
  ok(planOf('paper', '10.1038/nature12373').requires[0] === 'paper-note:核心主张|方法要点|局限', `paper key-agnostic：${planOf('paper', '10.1038/nature12373').requires}`)

  // ── 无参报错 ──
  for (const name of ['survey-scan', 'paper', 'derive']) {
    const res = await invoke(name, '')
    ok(res.kind === 'error' && /用法/.test(res.text), `/${name} 无参应报错：${JSON.stringify(res)}`)
  }
  const statusNoArg = await invoke('survey', '')
  ok(statusNoArg.kind === 'success', '/survey 无参应成功（状态页）')

  // ── --no-init 且无项目 → 报错 ──
  const noInit = await invoke('survey-scan', 'PINN --no-init')
  ok(noInit.kind === 'error' && /--no-init/.test(noInit.text), `--no-init 无项目应报错：${noInit.text}`)

  // ── 自动建项目 + 启动 scan 阶段 ──
  const res = await invoke('survey-scan', 'PINN 求解器')
  ok(res.kind === 'success', `survey-scan 应成功：${JSON.stringify(res)}`)
  ok(/已自动创建研究项目/.test(res.text), '应提示自动建项目')
  ok(/下一步：\/survey-scholar/.test(res.text), `应提示下一条命令：${res.text}`)
  const study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.autoCreated === true, 'autoCreated 标记')
  ok(study.origin === '/survey-scan PINN 求解器', `origin：${study.origin}`)
  ok(study.title === 'PINN 求解器', '标题取参数')

  const loops = await listLoops(root)
  ok(loops.length === 1 && loops[0].kind === 'survey-scan', '创建了 survey-scan loop')
  ok(loops[0].exit.workMin === 2, 'workMin=2')
  ok(loops[0].maxNudges === 2, 'maxNudges=2')
  ok(loops[0].skill === 'domain-survey', 'skill 记录')
  ok(loops[0].exit.requires.some((r) => r.includes('knowledge/surveys/pinn-求解器/scope.md')), `scan 产物路径：${loops[0].exit.requires}`)
  ok(loops[0].exit.checks.some((c) => c.startsWith('min-links:')), `scan 契约含 min-links：${loops[0].exit.checks}`)

  const layout = await projectLayout(root)
  const survey = await getSurveyState(root, layout, surveySlug('PINN 求解器'), 'PINN 求解器')
  ok(survey?.stages?.scan?.status === 'running', `scan 应为 running：${survey?.stages?.scan?.status}`)
  ok(survey?.stages?.scan?.loopId === loops[0].id, '阶段应记录 loopId')

  // 注入的 prompt 必须含阶段边界、出口契约与记账指令
  ok(followups.length === 1, `应注入一条消息，实际 ${followups.length}`)
  const prompt = followups[0].content[0].text
  ok(/## 本阶段边界/.test(prompt), 'prompt 含本阶段边界')
  ok(/只做 `scan`/.test(prompt), 'prompt 明确只做 scan')
  ok(/下一步：`\/survey-scholar/.test(prompt), 'prompt 含下一步命令')
  ok(/## 出口契约/.test(prompt), 'prompt 含出口契约')
  ok(/## 步骤骨架/.test(prompt), 'prompt 含步骤骨架')
  ok(/domain-survey/.test(prompt), 'prompt 引用技能')
  ok(/loop_close\(\)/.test(prompt), 'prompt 含 loop_close 指令')
  ok(followups[0].role === 'user' && typeof followups[0].id === 'string', '消息形状符合 MessageBase')

  // ── 同类互斥（同主题） ──
  const dup = await invoke('survey-scan', 'PINN 求解器')
  ok(dup.kind === 'error' && /已有 survey-scan/.test(dup.text), `同类互斥：${dup.text}`)

  // ── 严格顺序：scan 还在 running，不能直接 map ──
  const mapEarly = await invoke('survey-map', 'PINN 求解器')
  ok(mapEarly.kind === 'error' && /前序阶段|需要先完成/.test(mapEarly.text), `阶段顺序应拦住 map：${mapEarly.text}`)

  // ── --dry-run 不建 loop / 不改状态 ──
  const beforeLoops = (await listLoops(root)).length
  const dry = await invoke('survey-scan', '另一个方向 --dry-run')
  ok(dry.kind === 'success' && /\(dry-run\)/.test(dry.text), 'dry-run 返回 prompt')
  ok(followups.length === 0, 'dry-run 不注入消息')
  ok((await listLoops(root)).length === beforeLoops, 'dry-run 不创建 loop')

  // ── /survey 状态页 ──
  const surveyStatus = await invoke('survey', 'PINN 求解器')
  ok(surveyStatus.kind === 'success', '/survey 状态页应成功')
  ok(/scan/.test(surveyStatus.text) && /进行中/.test(surveyStatus.text), `状态页应显示 scan running：${surveyStatus.text}`)
  ok(/下一步/.test(surveyStatus.text), '状态页应给出下一步')

  // ── 完成 scan 后 /survey --next 应进入 scholar ──
  const surveyDir = join(root, 'knowledge', 'surveys', 'pinn-求解器')
  await mkdir(surveyDir, { recursive: true })
  await writeFile(join(surveyDir, 'scope.md'), '# 决策问题\n\nPINN 精度\n\n## 边界\n\n小样本\n\n## 检索式\n\nPINN\n')
  const sourceRows = Array.from({ length: 8 }, (_, i) => `| S${i + 1} | https://example.com/${i + 1} | lab | 高 | 用途${i + 1} |`).join('\n')
  await writeFile(join(surveyDir, 'sources.md'), `| 标题 | URL | 类型 | 可信度 |\n|---|---|---|---|\n${sourceRows}\n`)
  await noteLoop(root, loops[0].id, '完成定框')
  await noteLoop(root, loops[0].id, '完成网络调研')
  const closedScan = await closeLoop(root, loops[0].id)
  ok(closedScan.status === 'closed', 'scan loop 应能关闭')
  const afterScan = await getSurveyState(root, layout, surveySlug('PINN 求解器'), 'PINN 求解器')
  ok(afterScan.stages.scan.status === 'done', `closeLoop 后 scan 应 done：${afterScan.stages.scan.status}`)
  const nextScholar = await invoke('survey', 'PINN 求解器 --next')
  ok(nextScholar.kind === 'success' && /已启动 \/survey-scholar/.test(nextScholar.text), `--next 应进入 scholar：${nextScholar.text}`)
  ok(followups.length === 1 && /本阶段只做 `scholar`/.test(followups[0].content[0].text), 'scholar prompt 应有阶段边界')

  // ── /survey --next：新主题自动从 scan 开始 ──
  const next = await invoke('survey', '全新方向 --next')
  ok(next.kind === 'success' && /已启动 \/survey-scan/.test(next.text), `--next 应启动 scan：${next.text}`)
  const nextLoops = await listLoops(root, { status: 'running' })
  ok(nextLoops.some((l) => l.kind === 'survey-scan' && l.arg === '全新方向'), '--next 创建了 scan loop')

  // ── --dry-run 不建 loop（paper） ──
  const beforePaper = (await listLoops(root)).length
  const dryPaper = await invoke('paper', '10.1038/nature12373 --dry-run')
  ok(dryPaper.kind === 'success' && /\(dry-run\)/.test(dryPaper.text), 'paper dry-run 返回 prompt')
  ok(followups.length === 0, 'paper dry-run 不注入消息')
  ok((await listLoops(root)).length === beforePaper, 'paper dry-run 不创建 loop')

  // ── write 默认目标 ──
  const write = await invoke('write', '')
  ok(write.kind === 'success', `write 无参应成功：${JSON.stringify(write)}`)
  const writeLoop = (await listLoops(root)).find((l) => l.kind === 'write')
  ok(writeLoop.exit.requires[0].includes('knowledge/reports/progress-'), `默认目标：${writeLoop.exit.requires[0]}`)

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
      get: (n) => (n === 'workingDirectory' ? wd(emptyRoot) : undefined),
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

  // 空目录里 study-init 应创建，并把工作区切到项目根
  const root2 = await mkdtemp(join(tmpdir(), 'vault-cmd2-'))
  try {
    let switched = null
    const ctx2 = {
      get: (name) => (name === 'workingDirectory'
        ? { ensure: async () => root2, get: () => root, set: async (_agent, next) => { switched = next; return next } }
        : undefined),
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
    ok(switched === root2, `命令应把工作区切到项目根，实际 ${switched}`)
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
console.log('✓ vault-commands 测试通过（12 命令 / 阶段契约 / /survey --next / status / 工作区）')
