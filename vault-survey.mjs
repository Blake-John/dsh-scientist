// vault-survey —— 分阶段调研的状态机
//
// 设计（0.6.0）：
//   · /survey-<stage> 每次只推进一个阶段，阶段之间严格顺序
//   · 状态落 knowledge/surveys/<slug>/survey.json，不靠模型记忆
//   · --force 把未完成的前序阶段标为 skipped，状态仍然自洽
//   · 旧版只有 report.md、没有 survey.json 的项目按 legacy 处理
//
// 这个模块不 import vault-loop-core，避免循环依赖；loop 侧通过
// loop.survey 元数据回调 completeStage。

import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nowISO, readJson, slugify, vaultErr, withFileLock, writeJsonAtomic } from './vault-core.mjs'
import { projectLayout, surveyDir } from './project-layout.mjs'

export const SURVEY_STAGES = ['scan', 'scholar', 'map', 'papers', 'report']

export const STAGE_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped']

export const STAGE_META = {
  scan: {
    title: '定框与网络调研',
    command: 'survey-scan',
    artifacts: ['scope.md', 'sources.md'],
    next: 'scholar',
  },
  scholar: {
    title: '学术检索与候选论文',
    command: 'survey-scholar',
    artifacts: ['queries.md', 'candidates.md'],
    next: 'map',
  },
  map: {
    title: '流派、时间线与 gap',
    command: 'survey-map',
    artifacts: ['landscape.md'],
    next: 'papers',
  },
  papers: {
    title: '论文总述与深读队列',
    command: 'survey-papers',
    artifacts: ['papers.md'],
    next: 'report',
  },
  report: {
    title: '综合调研报告',
    command: 'survey-report',
    artifacts: ['report.md'],
    next: null,
  },
}

export const stageCommand = (stage) => STAGE_META[stage]?.command ?? `survey-${stage}`

export const stageTitle = (stage) => STAGE_META[stage]?.title ?? stage

export const previousStages = (stage) => {
  const index = SURVEY_STAGES.indexOf(stage)
  return index < 0 ? [] : SURVEY_STAGES.slice(0, index)
}

export const nextStage = (state) => {
  if (!state) return SURVEY_STAGES[0]
  for (const stage of SURVEY_STAGES) {
    const status = state.stages?.[stage]?.status
    if (status !== 'done' && status !== 'skipped') return stage
  }
  return null
}

/** 阶段目录：v2 是 knowledge/surveys/<slug>/；v1 仅用于 legacy 只读展示 */
export function surveyWorkspace(root, paths, slug) {
  return paths.version === 'v2'
    ? surveyDir(root, paths, slug)
    : join(root, paths.reports, `survey-${slug}`)
}

/** survey.json 路径；v1 不支持分阶段状态 */
export function surveyStatePath(root, paths, slug) {
  return paths.version === 'v2' ? join(surveyWorkspace(root, paths, slug), 'survey.json') : null
}

/** 旧版报告路径：v2 在 surveys/<slug>/report.md；v1 在 reports/landscape-<slug>.md */
export function legacyReportPath(root, paths, slug) {
  return paths.version === 'v2'
    ? join(root, paths.surveys, slug, 'report.md')
    : join(root, paths.reports, `landscape-${slug}.md`)
}

const lockPath = (root, paths, slug) => join(surveyWorkspace(root, paths, slug), '.survey.lock')

const blankStages = () =>
  Object.fromEntries(SURVEY_STAGES.map((stage) => [stage, { status: 'pending' }]))

const freshState = (slug, topic) => {
  const at = nowISO()
  return {
    schema: 1,
    slug,
    topic: String(topic ?? slug),
    createdAt: at,
    updatedAt: at,
    legacy: false,
    stages: blankStages(),
  }
}

const legacyState = async (root, paths, slug, topic) => {
  const report = legacyReportPath(root, paths, slug)
  const info = await stat(report).catch(() => null)
  if (!info?.isFile()) return null
  const at = info.mtime.toISOString()
  const stages = {}
  for (const stage of SURVEY_STAGES) {
    stages[stage] = stage === 'report'
      ? { status: 'done', completedAt: at, legacy: true }
      : { status: 'skipped', skippedAt: at, reason: 'legacy' }
  }
  return {
    schema: 1,
    slug,
    topic: String(topic ?? slug),
    createdAt: at,
    updatedAt: at,
    legacy: true,
    stages,
  }
}

const normalizeState = (state, slug, topic) => {
  if (!state || typeof state !== 'object') return null
  state.slug = state.slug ?? slug
  state.topic = state.topic ?? topic ?? slug
  state.schema = state.schema ?? 1
  state.legacy = Boolean(state.legacy)
  state.stages = state.stages ?? {}
  for (const stage of SURVEY_STAGES) {
    const current = state.stages[stage]
    state.stages[stage] = current && typeof current === 'object'
      ? { ...current, status: STAGE_STATUSES.includes(current.status) ? current.status : 'pending' }
      : { status: 'pending' }
  }
  return state
}

const readStateUnlocked = async (root, paths, slug) => {
  const file = surveyStatePath(root, paths, slug)
  if (!file) return null
  const state = await readJson(file, null)
  return state ? normalizeState(state, slug) : null
}

const writeStateUnlocked = async (root, paths, slug, state) => {
  const file = surveyStatePath(root, paths, slug)
  if (!file) throw vaultErr('ERR_LAYOUT', '分阶段调研需要 v2 项目；先运行 vault migrate --to v2')
  state.updatedAt = nowISO()
  await writeJsonAtomic(file, state)
  return state
}

/**
 * 只读读取：有 survey.json 用状态；没有但已有 report.md 返回临时 legacy 状态；
 * 都没有返回 null。不会写盘。
 */
export async function getSurveyState(root, paths, slug, topic) {
  if (paths.version !== 'v2') return await legacyState(root, paths, slug, topic)
  const state = await readStateUnlocked(root, paths, slug)
  if (state) return state
  return await legacyState(root, paths, slug, topic)
}

/**
 * 阶段命令使用：确保 survey.json 存在。
 * 旧 report.md 会转成 legacy 状态（不破坏旧产物）；v1 项目拒绝分阶段。
 */
export async function ensureSurveyState(root, paths, slug, topic) {
  if (paths.version !== 'v2') {
    throw vaultErr('ERR_LAYOUT', '分阶段调研需要 v2 项目；先运行 vault migrate --to v2')
  }
  return await withFileLock(lockPath(root, paths, slug), {}, async () => {
    const existing = await readStateUnlocked(root, paths, slug)
    if (existing) return existing
    const legacy = await legacyState(root, paths, slug, topic)
    const state = legacy ?? freshState(slug, topic)
    return await writeStateUnlocked(root, paths, slug, state)
  })
}

/**
 * 开始一个阶段。
 *   · 前序必须 done/skipped；否则抛 ERR_STAGE_ORDER
 *   · --force 把未完成的前序标 skipped
 *   · 当前阶段已完成时，--force 会重置当前及下游后重跑
 *   · 当前阶段 failed/skipped 可直接重试
 */
export async function beginStage(root, paths, slug, stage, { force = false, loopId = null, topic } = {}) {
  if (!SURVEY_STAGES.includes(stage)) throw vaultErr('ERR_BAD_ARGS', `未知 survey 阶段：${stage}`)
  return await withFileLock(lockPath(root, paths, slug), {}, async () => {
    let state = await readStateUnlocked(root, paths, slug)
    if (!state) {
      const legacy = await legacyState(root, paths, slug, topic)
      state = legacy ?? freshState(slug, topic)
    }

    const current = state.stages[stage]
    if (current.status === 'running' && current.loopId && current.loopId !== loopId) {
      throw vaultErr('ERR_STAGE_RUNNING', `阶段 ${stage} 已在运行（loop ${current.loopId}）；先 loop_close 或 /status --abort`, {
        stage,
        loopId: current.loopId,
      })
    }
    if (current.status === 'done' && !force) {
      throw vaultErr('ERR_STAGE_DONE', `阶段 ${stage} 已完成；重跑请加 --force`, { stage })
    }
    if (current.status === 'skipped' && !force && !state.legacy) {
      throw vaultErr('ERR_STAGE_SKIPPED', `阶段 ${stage} 已被跳过；补做请加 --force`, { stage })
    }
    if (state.legacy && stage !== 'report' && !force) {
      throw vaultErr('ERR_STAGE_LEGACY', `这是旧版 report（legacy）；补阶段请加 --force`, { stage })
    }

    const now = nowISO()
    const index = SURVEY_STAGES.indexOf(stage)
    const wasLegacy = state.legacy
    if (force) state.legacy = false
    if (force && (current.status === 'done' || current.status === 'skipped' || wasLegacy)) {
      // 重跑/补做当前阶段：当前及下游全部回到 pending，避免旧结论被当成新结论
      for (const later of SURVEY_STAGES.slice(index)) state.stages[later] = { status: 'pending' }
    }

    for (const before of previousStages(stage)) {
      const status = state.stages[before]
      if (status.status === 'done' || status.status === 'skipped') continue
      if (status.status === 'running') {
        throw vaultErr('ERR_STAGE_ORDER', `前序阶段 ${before} 正在运行（loop ${status.loopId ?? '?'}），不能开始 ${stage}`, {
          stage,
          missing: [before],
          nextCommand: stageCommand(before),
        })
      }
      if (!force) {
        throw vaultErr(
          'ERR_STAGE_ORDER',
          `阶段 ${stage} 需要先完成前序阶段：${previousStages(stage)
            .filter((s) => !['done', 'skipped'].includes(state.stages[s].status))
            .join('、')}`,
          {
            stage,
            missing: previousStages(stage).filter((s) => !['done', 'skipped'].includes(state.stages[s].status)),
            nextCommand: stageCommand(nextStage(state)),
          },
        )
      }
      state.stages[before] = { status: 'skipped', reason: 'forced', skippedAt: now }
    }

    state.stages[stage] = {
      status: 'running',
      startedAt: now,
      loopId,
      forced: Boolean(force),
    }
    state.updatedAt = now
    return await writeStateUnlocked(root, paths, slug, state)
  })
}

/**
 * loop 关闭时回写阶段状态。loopId 不匹配时不动，避免旧 loop 覆盖新状态。
 */
export async function completeStage(root, paths, slug, stage, { ok = true, reason = '', loopId = null } = {}) {
  if (!SURVEY_STAGES.includes(stage)) return null
  return await withFileLock(lockPath(root, paths, slug), {}, async () => {
    const state = await readStateUnlocked(root, paths, slug)
    if (!state) return null
    const current = state.stages[stage]
    if (!current) return state
    if (loopId && current.loopId && current.loopId !== loopId) return state
    if (current.status === 'done' && ok) return state
    const at = nowISO()
    if (ok) {
      state.stages[stage] = { status: 'done', completedAt: at, loopId: loopId ?? current.loopId ?? null }
    } else {
      state.stages[stage] = {
        ...current,
        status: 'failed',
        failedAt: at,
        failReason: String(reason ?? '').trim() || '未说明原因',
      }
    }
    state.updatedAt = at
    return await writeStateUnlocked(root, paths, slug, state)
  })
}

/** 由 loop 记录回写：vault-loop-core.closeLoop 调用 */
export async function completeStageForLoop(root, loop, { ok, reason } = {}) {
  const survey = loop?.survey
  if (!survey?.slug || !survey?.stage) return null
  const paths = await projectLayout(root)
  return await completeStage(root, paths, survey.slug, survey.stage, {
    ok,
    reason,
    loopId: loop.id,
  })
}

/** 列出所有 survey（供 /survey 无参使用） */
export async function listSurveyStates(root, paths) {
  const results = []
  if (paths.version === 'v2') {
    const dir = join(root, paths.surveys)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const state = await getSurveyState(root, paths, entry.name, entry.name)
      if (state) results.push(state)
    }
  } else {
    const dir = join(root, paths.reports)
    const entries = await readdir(dir).catch(() => [])
    for (const entry of entries) {
      const match = /^landscape-(.+)\.md$/.exec(entry)
      if (!match) continue
      const state = await getSurveyState(root, paths, match[1], match[1])
      if (state) results.push(state)
    }
  }
  return results.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

const STATUS_LABEL = {
  pending: '未开始',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
}

/** 渲染 /survey 状态页 */
export function renderSurveyStatus(state, { topic, slug, paths } = {}) {
  if (!state) {
    const name = topic || slug || '（未命名）'
    return [
      `调研：${name}`,
      '状态：未开始',
      `下一步：/survey-scan "${name}"`,
    ].join('\n')
  }

  const name = topic || state.topic || state.slug
  const lines = [
    `调研：${name}`,
    `目录：${paths?.version === 'v2' ? `${paths.surveys}/${state.slug}/` : `${paths?.reports ?? 'reports'}/`}`,
    `状态：${state.legacy ? '旧版报告（legacy）' : '分阶段调研'}`,
    '',
    '阶段        状态      产物',
  ]
  for (const stage of SURVEY_STAGES) {
    const info = state.stages[stage] ?? { status: 'pending' }
    const artifacts = STAGE_META[stage].artifacts.join(' · ')
    lines.push(`${stage.padEnd(10)} ${String(STATUS_LABEL[info.status] ?? info.status).padEnd(8)} ${artifacts}${info.loopId ? `  (${info.loopId})` : ''}`)
  }

  const skipped = SURVEY_STAGES.filter((stage) => state.stages[stage]?.status === 'skipped')
  if (skipped.length) lines.push('', `跳过阶段：${skipped.join('、')}（--force 或 legacy）`)

  const next = nextStage(state)
  lines.push('')
  if (!next) {
    lines.push(state.legacy
      ? `下一步：旧版报告；要补阶段用 /survey-scan "${name}" --force`
      : '下一步：全部阶段已完成；需要重写请加 --force 重跑对应阶段')
  } else {
    const info = state.stages[next] ?? {}
    if (info.status === 'running') {
      lines.push(`下一步：${next} 正在运行（loop ${info.loopId ?? '?'}）；先 loop_status 或 /status --abort`)
    } else if (info.status === 'failed') {
      lines.push(`下一步：/survey-${next} "${name}"（重试；上次失败：${info.failReason ?? '未说明'}）`)
    } else {
      lines.push(`下一步：/survey-${next} "${name}"`)
    }
    lines.push(`或：/survey "${name}" --next`)
  }
  return lines.join('\n')
}

/** 供测试/命令层使用的 slug 规范化 */
export const surveySlug = (topic) => slugify(topic, 'topic')

/** 确保目录存在（测试/命令在创建 loop 前可用） */
export async function ensureSurveyDir(root, paths, slug) {
  await mkdir(surveyWorkspace(root, paths, slug), { recursive: true })
}

export const __test__ = {
  blankStages,
  freshState,
  legacyState,
  normalizeState,
  readStateUnlocked,
  writeStateUnlocked,
}
