#!/usr/bin/env node
/**
 * test-vault-survey —— 分阶段调研状态机（全离线）
 *
 * 覆盖：fresh / 严格顺序 / --force skipped / done 重跑重置下游 /
 *       legacy report 识别 / 状态渲染 / 列表。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectLayout } from '../project-layout.mjs'
import { closeLoop, createLoop, setLoopSurvey } from '../vault-loop-core.mjs'
import {
  SURVEY_STAGES,
  beginStage,
  completeStage,
  ensureSurveyState,
  getSurveyState,
  listSurveyStates,
  nextStage,
  renderSurveyStatus,
  surveyStatePath,
  surveyWorkspace,
} from '../vault-survey.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }
const expectCode = async (fn, code, label) => {
  const out = await fn().then(() => 'no-error', (e) => e.code ?? e.message)
  ok(out === code, `${label}: ${out}`)
}

const root = await mkdtemp(join(tmpdir(), 'vault-survey-'))
try {
  await mkdir(join(root, 'knowledge', 'surveys'), { recursive: true })
  const paths = await projectLayout(root)
  ok(paths.version === 'v2', `layout 应为 v2，实际 ${paths.version}`)

  const slug = 'pinn-求解器'
  let state = await ensureSurveyState(root, paths, slug, 'PINN 求解器')
  ok(state.stages && Object.keys(state.stages).length === 5, '应有 5 个阶段')
  ok(state.stages.scan.status === 'pending', 'fresh scan pending')
  ok(nextStage(state) === 'scan', 'fresh next=scan')
  ok(await stat(surveyStatePath(root, paths, slug)).then(() => true, () => false), 'survey.json 应存在')

  state = await beginStage(root, paths, slug, 'scan', { loopId: 'l-scan' })
  ok(state.stages.scan.status === 'running' && state.stages.scan.loopId === 'l-scan', 'scan running')
  state = await completeStage(root, paths, slug, 'scan', { ok: true, loopId: 'l-scan' })
  ok(state.stages.scan.status === 'done', 'scan done')
  ok(nextStage(state) === 'scholar', 'next=scholar')

  // 严格顺序：scholar 未做，不能直接 map
  const orderErr = await beginStage(root, paths, slug, 'map', { loopId: 'l-map' }).then(() => null, (e) => e)
  ok(orderErr?.code === 'ERR_STAGE_ORDER', `严格顺序应报 ERR_STAGE_ORDER：${orderErr?.code}`)
  ok(orderErr?.nextCommand === 'survey-scholar', `应提示下一条命令：${orderErr?.nextCommand}`)

  // --force：未完成前序标 skipped
  state = await beginStage(root, paths, slug, 'map', { force: true, loopId: 'l-map' })
  ok(state.stages.scholar.status === 'skipped', 'force 应把 scholar 标 skipped')
  ok(state.stages.map.status === 'running', 'map running')
  state = await completeStage(root, paths, slug, 'map', { ok: true, loopId: 'l-map' })
  ok(nextStage(state) === 'papers', 'next=papers')

  // done 阶段无 force 拒绝
  await expectCode(
    () => beginStage(root, paths, slug, 'scan', { loopId: 'l-again' }),
    'ERR_STAGE_DONE',
    '已完成阶段无 force 应拒绝',
  )

  // done 阶段 force：当前及下游重置
  state = await beginStage(root, paths, slug, 'scan', { force: true, loopId: 'l-scan2' })
  ok(state.stages.scan.status === 'running', 'force 重跑 scan running')
  ok(state.stages.map.status === 'pending' && state.stages.papers.status === 'pending', 'force 应重置下游')

  // failed 可重试
  state = await completeStage(root, paths, slug, 'scan', { ok: false, reason: '测试失败', loopId: 'l-scan2' })
  ok(state.stages.scan.status === 'failed', 'failed 状态落盘')
  state = await beginStage(root, paths, slug, 'scan', { loopId: 'l-scan3' })
  ok(state.stages.scan.status === 'running', 'failed 可重试')

  // legacy：只有 report.md，没有 survey.json
  const legacyRoot = await mkdtemp(join(tmpdir(), 'vault-survey-legacy-'))
  try {
    const legacySlug = 'old-survey'
    await mkdir(join(legacyRoot, 'knowledge', 'surveys', legacySlug), { recursive: true })
    await writeFile(join(legacyRoot, 'knowledge', 'surveys', legacySlug, 'report.md'), '# old\n')
    const legacyPaths = await projectLayout(legacyRoot)
    const legacy = await getSurveyState(legacyRoot, legacyPaths, legacySlug, 'Old Survey')
    ok(legacy?.legacy === true, 'legacy 标记')
    ok(legacy.stages.report.status === 'done', 'legacy report done')
    ok(SURVEY_STAGES.slice(0, 4).every((stage) => legacy.stages[stage].status === 'skipped'), 'legacy 前序 skipped')
    ok(nextStage(legacy) === null, 'legacy next=null')
    ok(/legacy/.test(renderSurveyStatus(legacy, { paths: legacyPaths })), '状态页应显示 legacy')

    const stored = await ensureSurveyState(legacyRoot, legacyPaths, legacySlug, 'Old Survey')
    ok(stored.legacy === true, 'ensure 应保存 legacy 状态')
    ok(await stat(join(surveyWorkspace(legacyRoot, legacyPaths, legacySlug), 'survey.json')).then(() => true, () => false), 'legacy survey.json 应落盘')
    await expectCode(
      () => beginStage(legacyRoot, legacyPaths, legacySlug, 'scan', { loopId: 'l-legacy' }),
      'ERR_STAGE_LEGACY',
      'legacy 补阶段无 force 应拒绝',
    )
    const backfilled = await beginStage(legacyRoot, legacyPaths, legacySlug, 'scan', { force: true, loopId: 'l-legacy' })
    ok(backfilled.legacy === false && backfilled.stages.scan.status === 'running', 'legacy --force 可补阶段')
    const listed = await listSurveyStates(legacyRoot, legacyPaths)
    ok(listed.some((item) => item.slug === legacySlug), 'list 应包含 legacy')
  } finally {
    await rm(legacyRoot, { recursive: true, force: true })
  }

  const listed = await listSurveyStates(root, paths)
  ok(listed.some((item) => item.slug === slug), 'list 应包含当前 survey')

  // ── loop_close 回写阶段状态 ──
  const integRoot = await mkdtemp(join(tmpdir(), 'vault-survey-integ-'))
  try {
    await mkdir(join(integRoot, 'research'), { recursive: true })
    await mkdir(join(integRoot, 'knowledge', 'surveys'), { recursive: true })
    const integPaths = await projectLayout(integRoot)
    const integSlug = 'integ'
    await ensureSurveyState(integRoot, integPaths, integSlug, 'Integ')
    const integLoop = await createLoop(integRoot, { kind: 'survey-scan', arg: 'Integ', requires: [], workMin: 0 })
    await beginStage(integRoot, integPaths, integSlug, 'scan', { loopId: integLoop.id })
    await setLoopSurvey(integRoot, integLoop.id, { slug: integSlug, stage: 'scan' })
    const closed = await closeLoop(integRoot, integLoop.id)
    ok(closed.status === 'closed', '阶段 loop 应能关闭')
    const afterClose = await getSurveyState(integRoot, integPaths, integSlug, 'Integ')
    ok(afterClose.stages.scan.status === 'done', 'closeLoop 应把阶段标 done')
    ok(nextStage(afterClose) === 'scholar', 'close 后 next=scholar')
  } finally {
    await rm(integRoot, { recursive: true, force: true })
  }

  // 状态页至少能渲染
  const text = renderSurveyStatus(await getSurveyState(root, paths, slug, 'PINN 求解器'), { topic: 'PINN 求解器', slug, paths })
  ok(/阶段/.test(text) && /下一步/.test(text), `状态页渲染：${text}`)

  // survey.json 可读且 schema=1
  const raw = JSON.parse(await readFile(surveyStatePath(root, paths, slug), 'utf8'))
  ok(raw.schema === 1 && raw.slug === slug, 'survey.json schema/slug')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-survey 测试通过（状态机 / 严格顺序 / force / legacy / 渲染）')
