// vault-study —— 研究状态（8 个工具）
//
//   study_init        初始化研究（study.json + 目录），幂等
//   study_state       摘要视图：问题/阶段/假设/实验/决策/评审/工件/证据覆盖率 + 悬空引用
//   study_hypothesis  登记可证伪假设（citekeys 软提醒，不硬拒）
//   study_experiment  登记实验计划（关联假设、种子、环境、预期）
//   study_finding     记录观察与结论（推进假设状态与阶段；nextQuestion 归档旧问题）
//   study_decision    决策日志：选了什么、否了什么、为什么
//   study_review      登记评审结论（对 testing 假设更新状态）
//   study_phase       推进阶段（允许退一级，必须写原因）
//
// 相对 dsh-science research-loop 的修正（docs/research-record-plan.md §5）：
//   F6 换迭代时旧问题进 question.history（原版直接覆盖 → 研究脉络丢失）
//   F7 历史溢出转 JSONL 归档（原版 splice 丢弃）
//   F8 假设带 citekeys 并校验文献是否存在（原版无关联）
//   F9 实验 ↔ 工件双向（record_save 回写 experiments[].records）
//   F10 阶段可退一级但必须给原因（原版是一刀切开关）
//   F11 评审可查（study_state 汇总 + reviews[] 挂在假设上）

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendJsonl,
  nowISO,
  optInt,
  optStr,
  readJson,
  requireStr,
  resolveRoot,
  slugify,
  vaultErr,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from './vault-core.mjs'

export const name = 'dsh-scientist-vault-study'
export const inject = ['tools']

const STUDY = 'research/study.json'
const LOCK = 'research/.lock'
// 可用 VAULT_HISTORY_CAP 覆盖（测试用；正常固定 200）
const HISTORY_CAP = Number(process.env.VAULT_HISTORY_CAP ?? 200)
const SCHEMA = 1

export const PHASES = ['literature', 'hypothesis', 'experiment', 'analysis', 'manuscript', 'concluded']
export const HYP_STATUSES = ['proposed', 'testing', 'supported', 'refuted', 'inconclusive']
export const VERDICTS = ['supported', 'refuted', 'inconclusive', 'needs-work']

const HYP_TRANSITIONS = {
  proposed: ['testing'],
  testing: ['supported', 'refuted', 'inconclusive'],
  supported: ['testing'],
  refuted: ['testing'],
  inconclusive: ['testing'],
}

const tool = ({ name, description, parameters, presentTitle, execute, outputSchema }) => ({
  name,
  description,
  parameters,
  output: {
    schema: outputSchema ?? { type: 'string' },
    render: (_args, value) =>
      typeof value === 'string' ? [{ type: 'text', text: value }] : [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    return await execute(args ?? {}, exec)
  },
  presentCall: (args) => ({ card: 'generic', title: presentTitle, kind: 'other', rawInput: args }),
})

// ── 存取 ────────────────────────────────────────────────────────────────────

const studyPath = (root) => join(root, STUDY)
const lockPath = (root) => join(root, LOCK)
const historyArchive = (root) => join(root, 'research', 'loop-history.jsonl')

async function loadStudy(root) {
  const study = await readJson(studyPath(root), null)
  if (!study) throw vaultErr('ERR_NO_STUDY', '研究清单不存在：先运行 study_init')
  if ((study.schema ?? 0) > SCHEMA) {
    throw vaultErr('ERR_SCHEMA', `study.json schema=${study.schema} 比本工具支持的 ${SCHEMA} 新`)
  }
  study.hypotheses ??= []
  study.experiments ??= []
  study.decisions ??= []
  study.reviews ??= []
  study.claims ??= []
  study.question ??= { text: '', history: [] }
  study.question.history ??= []
  study.loop ??= { phase: 'literature', iteration: 0, history: [] }
  study.loop.history ??= []
  return study
}

const nextId = (list, prefix, pad = 0) => {
  const nums = list
    .map((item) => String(item.id ?? '').replace(prefix, ''))
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `${prefix}${pad ? String(next).padStart(pad, '0') : next}`
}

/** F7：溢出时先归档再裁剪，不丢审计信息 */
async function pushHistory(root, study, entry) {
  study.loop.history.push({ at: nowISO(), ...entry })
  if (study.loop.history.length > HISTORY_CAP) {
    const overflow = study.loop.history.slice(0, study.loop.history.length - HISTORY_CAP)
    for (const item of overflow) await appendJsonl(historyArchive(root), { archived: true, ...item })
    study.loop.history = study.loop.history.slice(-HISTORY_CAP)
  }
}

function setHypStatus(hypothesis, to, via) {
  const from = hypothesis.status
  const allowed = HYP_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw vaultErr('ERR_BAD_TRANSITION', `假设 ${hypothesis.id} 不能从 ${from} 变为 ${to}（允许：${allowed.join(' / ') || '无'}）`)
  }
  hypothesis.history ??= []
  hypothesis.history.push({ at: nowISO(), from, to, via })
  hypothesis.status = to
}

function setPhase(study, to, { reason, via }) {
  if (!PHASES.includes(to)) throw vaultErr('ERR_BAD_ARGS', `未知阶段 ${to}（可选：${PHASES.join(' / ')}）`)
  const from = study.loop.phase
  const i = PHASES.indexOf(from)
  const j = PHASES.indexOf(to)
  if (j < i) {
    if (!reason) throw vaultErr('ERR_PHASE_REWIND', `从 ${from} 回退到 ${to} 必须给出 reason`)
    if (i - j > 1) throw vaultErr('ERR_PHASE_REWIND', `一次只能回退一个阶段（${from} → ${to} 跨了 ${i - j} 级）`)
  }
  study.loop.phase = to
  // 注意：不能写成 to < from —— 那是字符串字典序，'experiment' < 'analysis' 为 false
  return { from, to, via, rewound: j < i }
}

/** citekey 校验：软提醒——不存在只警告，不阻断 */
async function checkCitekeys(root, citekeys) {
  const warnings = []
  for (const key of citekeys) {
    const file = join(root, 'literature', 'notes', `${key}.md`)
    if (!existsSync(file)) warnings.push(`文献库里没有 ${key}（literature/notes/${key}.md 不存在）`)
  }
  return warnings
}

// ── 1. study_init ───────────────────────────────────────────────────────────

async function cmdInit(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  return await withFileLock(lockPath(root), {}, async () => {
    const existing = await readJson(studyPath(root), null)
    if (existing) {
      return [
        `· 研究已存在，未做改动：${existing.title || '(未命名)'}`,
        `  阶段 ${existing.loop?.phase ?? '?'} · 假设 ${(existing.hypotheses ?? []).length} · 实验 ${(existing.experiments ?? []).length}`,
        '下一步：study_state 看全貌，或 study_hypothesis 登记第一条假设。',
      ].join('\n')
    }
    for (const dir of ['research/records', 'research/reviews', 'research/envs']) {
      await mkdir(withinRoot(root, dir), { recursive: true })
    }
    const stamp = nowISO()
    const study = {
      schema: SCHEMA,
      title: optStr(args, 'title', '未命名研究'),
      createdAt: stamp,
      updatedAt: stamp,
      question: { text: optStr(args, 'question'), history: [], updatedAt: stamp },
      loop: { phase: 'literature', iteration: 1, history: [] },
      hypotheses: [],
      experiments: [],
      decisions: [],
      reviews: [],
      claims: [],
    }
    await pushHistory(root, study, { action: 'init', detail: `研究「${study.title}」创建`, phase: 'literature' })
    await writeJsonAtomic(studyPath(root), study)
    return [
      `✓ 已创建研究：${study.title}`,
      `  清单 research/study.json · 目录 research/{records,reviews,envs}`,
      study.question.text ? `  核心问题：${study.question.text}` : '  （未填核心问题，可用 study_init --question 补，或在 study_hypothesis 里给）',
      '',
      '建议顺序：literature（lit_search/lit_pdf/lit-lib）→ study_hypothesis → study_experiment → 跑代码 → record_save → study_finding。',
    ].join('\n')
  })
}

// ── 2. study_state ──────────────────────────────────────────────────────────

async function cmdState(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const study = await loadStudy(root)
  const recordsIndex = await readJson(join(root, 'research', 'records', 'index.json'), { records: [] })
  const recordNames = new Set((recordsIndex.records ?? []).map((r) => r.slug))

  const hypBy = (status) => study.hypotheses.filter((h) => h.status === status)
  const expBy = (status) => study.experiments.filter((e) => e.status === status)
  const noCite = study.hypotheses.filter((h) => !(h.citekeys ?? []).length)
  const noRecord = study.experiments.filter((e) => !(e.records ?? []).length)

  const issues = []
  for (const exp of study.experiments) {
    if (exp.hypothesis && !study.hypotheses.some((h) => h.id === exp.hypothesis)) {
      issues.push(`实验 ${exp.id} 指向不存在的假设 ${exp.hypothesis}`)
    }
    for (const rec of exp.records ?? []) {
      const slug = String(rec).split('@')[0]
      if (!recordNames.has(slug)) issues.push(`实验 ${exp.id} 指向不存在的工件 ${rec}`)
    }
  }
  for (const hyp of study.hypotheses) {
    for (const expId of hyp.experiments ?? []) {
      if (!study.experiments.some((e) => e.id === expId)) issues.push(`假设 ${hyp.id} 指向不存在的实验 ${expId}`)
    }
    for (const reviewId of hyp.reviews ?? []) {
      if (!study.reviews.some((r) => r.id === reviewId)) issues.push(`假设 ${hyp.id} 指向不存在的评审 ${reviewId}`)
    }
  }

  const lines = [
    `# ${study.title}`,
    '',
    `问题：${study.question.text || '（未设定）'}（第 ${study.loop.iteration} 轮）`,
    `阶段：${study.loop.phase}`,
    '',
    `假设 ${study.hypotheses.length}` +
      (study.hypotheses.length ? `（${HYP_STATUSES.map((s) => `${s} ${hypBy(s).length}`).filter((s) => !s.endsWith(' 0')).join(' / ')}）` : ''),
    `实验 ${study.experiments.length}` +
      (study.experiments.length
        ? `（${['planned', 'running', 'done', 'abandoned'].map((s) => `${s} ${expBy(s).length}`).filter((s) => !s.endsWith(' 0')).join(' / ')}）`
        : ''),
    `决策 ${study.decisions.length} · 评审 ${study.reviews.length} · 工件 ${(recordsIndex.records ?? []).length}`,
    '',
    `证据覆盖：假设有文献支撑 ${study.hypotheses.length - noCite.length}/${study.hypotheses.length}` +
      `${noCite.length ? `（缺：${noCite.map((h) => h.id).join(', ')}）` : ''}`,
    `          实验有工件 ${study.experiments.length - noRecord.length}/${study.experiments.length}` +
      `${noRecord.length ? `（缺：${noRecord.map((e) => e.id).join(', ')}）` : ''}`,
  ]

  if (study.hypotheses.length) {
    lines.push('', '假设：')
    for (const h of study.hypotheses) {
      lines.push(`  ${h.id} [${h.status}] ${h.text.slice(0, 60)}${h.text.length > 60 ? '…' : ''}` +
        `${(h.citekeys ?? []).length ? ` · 文献 ${h.citekeys.length}` : ' · ⚠无文献'}`)
    }
  }
  if (study.experiments.length) {
    lines.push('', '实验：')
    for (const e of study.experiments) {
      lines.push(`  ${e.id} [${e.status}] ${e.title.slice(0, 50)}${e.title.length > 50 ? '…' : ''}` +
        `${e.hypothesis ? ` ← ${e.hypothesis}` : ''}${(e.records ?? []).length ? ` · 工件 ${e.records.length}` : ''}`)
    }
  }
  if (study.decisions.length) {
    lines.push('', '决策：')
    for (const d of study.decisions.slice(-5)) {
      lines.push(`  ${d.id} ${d.question.slice(0, 40)} → ${d.chosen.slice(0, 30)}`)
    }
  }
  if (issues.length) {
    lines.push('', '⚠ 悬空引用：')
    for (const issue of issues) lines.push(`  - ${issue}`)
  }

  const historyLimit = optInt(args, 'historyLimit') ?? 5
  const recent = study.loop.history.slice(-historyLimit)
  if (recent.length) {
    lines.push('', `最近历史（${recent.length}/${study.loop.history.length}）：`)
    for (const h of recent) lines.push(`  ${h.at?.slice(5, 16) ?? ''} [${h.phase ?? '-'}] ${h.detail ?? h.action ?? ''}`)
  }

  if (args.detail === true) {
    lines.push('', '```json', JSON.stringify(study, null, 2), '```')
  }
  return lines.join('\n')
}

// ── 3. study_hypothesis ────────────────────────────────────────────────────

async function cmdHypothesis(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const text = requireStr(args, 'text')
  const citekeys = Array.isArray(args.citekeys) ? args.citekeys.map(String) : []
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const warnings = await checkCitekeys(root, citekeys)
    const id = nextId(study.hypotheses, 'H')
    const hypothesis = {
      id,
      text,
      status: 'proposed',
      rationale: optStr(args, 'rationale'),
      citekeys,
      experiments: [],
      reviews: [],
      history: [{ at: nowISO(), from: null, to: 'proposed', via: 'study_hypothesis' }],
      createdAt: nowISO(),
    }
    study.hypotheses.push(hypothesis)
    if (optStr(args, 'question') && !study.question.text) {
      study.question.text = optStr(args, 'question')
      study.question.updatedAt = nowISO()
    }
    study.updatedAt = nowISO()
    const phaseChange = study.loop.phase === 'literature' ? setPhase(study, 'hypothesis', { via: 'study_hypothesis' }) : null
    await pushHistory(root, study, { action: 'hypothesis', detail: `新增假设 ${id}`, phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)
    const lines = [`✓ 已登记假设 ${id}（${hypothesis.status}）`, `  ${text}`]
    if (citekeys.length) lines.push(`  文献支撑：${citekeys.join(', ')}`)
    else lines.push('  ⚠ 未给 citekeys——该假设暂无文献支撑，会出现在 study_state 的覆盖率里')
    for (const w of warnings) lines.push(`  ⚠ ${w}`)
    if (phaseChange) lines.push(`  阶段：${phaseChange.from} → ${phaseChange.to}`)
    lines.push('', `下一步：study_experiment --hypothesis ${id} 登记验证它的实验。`)
    return lines.join('\n')
  })
}

// ── 4. study_experiment ────────────────────────────────────────────────────

async function cmdExperiment(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const title = requireStr(args, 'title')
  const hypothesisId = optStr(args, 'hypothesis')
  const plan = Array.isArray(args.plan) ? args.plan.map(String) : optStr(args, 'plan') ? [optStr(args, 'plan')] : []
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const warnings = []
    let hypothesis = null
    if (hypothesisId) {
      hypothesis = study.hypotheses.find((h) => h.id === hypothesisId)
      if (!hypothesis) throw vaultErr('ERR_NOT_FOUND', `没有假设 ${hypothesisId}`)
    } else {
      warnings.push('未关联假设——该实验不会推进任何假设状态')
    }
    if (!plan.length) warnings.push('未给 plan——建议写下验证步骤')

    const id = nextId(study.experiments, 'E', 2)
    const experiment = {
      id,
      title,
      hypothesis: hypothesisId || undefined,
      objective: optStr(args, 'objective'),
      plan,
      expect: optStr(args, 'expect'),
      seed: optInt(args, 'seed'),
      env: optStr(args, 'env') || undefined,
      status: optStr(args, 'status', 'planned'),
      records: [],
      findings: [],
      startedAt: nowISO(),
      finishedAt: null,
    }
    study.experiments.push(experiment)
    if (hypothesis) {
      hypothesis.experiments = [...new Set([...(hypothesis.experiments ?? []), id])]
      if (hypothesis.status === 'proposed') setHypStatus(hypothesis, 'testing', `study_experiment:${id}`)
    }
    study.updatedAt = nowISO()
    const phaseChange = PHASES.indexOf(study.loop.phase) < PHASES.indexOf('experiment')
      ? setPhase(study, 'experiment', { via: 'study_experiment' })
      : null
    await pushHistory(root, study, { action: 'experiment', detail: `新增实验 ${id}`, phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)

    const lines = [`✓ 已登记实验 ${id}（${experiment.status}）`, `  ${title}`]
    if (hypothesis) lines.push(`  验证假设：${hypothesis.id}（${hypothesis.status}）`)
    if (plan.length) lines.push(`  步骤 ${plan.length} 条`)
    if (experiment.seed !== undefined) lines.push(`  种子 ${experiment.seed}`)
    if (experiment.env) lines.push(`  环境 ${experiment.env}`)
    for (const w of warnings) lines.push(`  ⚠ ${w}`)
    if (phaseChange) lines.push(`  阶段：${phaseChange.from} → ${phaseChange.to}`)
    lines.push('', `下一步：跑完后 record_save --experiment ${id} 保存工件，再 study_finding --experiment ${id} 记录结论。`)
    return lines.join('\n')
  })
}

// ── 5. study_finding ───────────────────────────────────────────────────────

async function cmdFinding(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const experimentId = requireStr(args, 'experiment')
  const finding = optStr(args, 'finding')
  const conclusion = optStr(args, 'conclusion')
  const nextQuestion = optStr(args, 'nextQuestion')
  if (!finding && !conclusion && !nextQuestion) {
    throw vaultErr('ERR_BAD_ARGS', '至少给 finding / conclusion / nextQuestion 之一')
  }
  if (conclusion && !HYP_STATUSES.includes(conclusion)) {
    throw vaultErr('ERR_BAD_ARGS', `conclusion 必须是 ${HYP_TRANSITIONS.testing.join(' / ')}`)
  }
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const experiment = study.experiments.find((e) => e.id === experimentId)
    if (!experiment) throw vaultErr('ERR_NOT_FOUND', `没有实验 ${experimentId}`)

    const notes = []
    if (finding) {
      experiment.findings.push({ at: nowISO(), text: finding })
      notes.push(`记录观察：${finding.slice(0, 60)}${finding.length > 60 ? '…' : ''}`)
    }
    if (conclusion) {
      const hypothesis = study.hypotheses.find((h) => h.id === experiment.hypothesis)
      if (!hypothesis) {
        throw vaultErr('ERR_NO_HYPOTHESIS', `实验 ${experimentId} 没有关联假设，无法给出 conclusion`)
      }
      setHypStatus(hypothesis, conclusion, `study_finding:${experimentId}`)
      experiment.status = 'done'
      experiment.finishedAt = nowISO()
      notes.push(`假设 ${hypothesis.id} → ${conclusion}`)
    }
    if (nextQuestion) {
      // F6：旧问题归档，绝不覆盖丢弃
      if (study.question.text) {
        study.question.history.push({
          text: study.question.text,
          iteration: study.loop.iteration,
          replacedAt: nowISO(),
          closedBy: experimentId,
        })
      }
      study.question.text = nextQuestion
      study.question.updatedAt = nowISO()
      study.loop.iteration += 1
      notes.push(`第 ${study.loop.iteration} 轮问题：${nextQuestion}`)
    }
    study.updatedAt = nowISO()
    const phaseChange = conclusion && PHASES.indexOf(study.loop.phase) < PHASES.indexOf('analysis')
      ? setPhase(study, 'analysis', { via: 'study_finding' })
      : null
    await pushHistory(root, study, { action: 'findings', detail: notes.join('；'), phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)

    const lines = [`✓ 已记录（${experimentId}）`]
    for (const note of notes) lines.push(`  ${note}`)
    if (phaseChange) lines.push(`  阶段：${phaseChange.from} → ${phaseChange.to}`)
    if (study.question.history.length) {
      lines.push(`  问题历史 ${study.question.history.length} 条（旧问题已归档，未丢弃）`)
    }
    return lines.join('\n')
  })
}

// ── 6. study_decision ──────────────────────────────────────────────────────

async function cmdDecision(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const question = requireStr(args, 'question')
  const chosen = requireStr(args, 'chosen')
  const rationale = requireStr(args, 'rationale')
  const alternatives = Array.isArray(args.alternatives) ? args.alternatives.map(String) : []
  const citekeys = Array.isArray(args.citekeys) ? args.citekeys.map(String) : []
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const warnings = await checkCitekeys(root, citekeys)
    const id = nextId(study.decisions, 'D')
    const experimentId = optStr(args, 'experiment')
    if (experimentId && !study.experiments.some((e) => e.id === experimentId)) {
      throw vaultErr('ERR_NOT_FOUND', `没有实验 ${experimentId}`)
    }
    study.decisions.push({
      id,
      question,
      chosen,
      alternatives,
      rationale,
      citekeys,
      experiment: experimentId || undefined,
      createdAt: nowISO(),
    })
    study.updatedAt = nowISO()
    await pushHistory(root, study, { action: 'decision', detail: `${id}：${question.slice(0, 40)} → ${chosen.slice(0, 30)}`, phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)
    const lines = [`✓ 已登记决策 ${id}`, `  问题：${question}`, `  选择：${chosen}`]
    if (alternatives.length) lines.push(`  否决：${alternatives.join(', ')}`)
    lines.push(`  理由：${rationale}`)
    if (citekeys.length) lines.push(`  依据文献：${citekeys.join(', ')}`)
    for (const w of warnings) lines.push(`  ⚠ ${w}`)
    return lines.join('\n')
  })
}

// ── 7. study_review ────────────────────────────────────────────────────────

async function cmdReview(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const target = requireStr(args, 'target')
  const verdict = requireStr(args, 'verdict')
  if (!VERDICTS.includes(verdict)) throw vaultErr('ERR_BAD_ARGS', `verdict 必须是 ${VERDICTS.join(' / ')}`)
  const hypothesisId = optStr(args, 'hypothesis')
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const id = nextId(study.reviews, 'R', 2)
    const issues = Array.isArray(args.issues) ? args.issues.map(String) : []
    const review = {
      id,
      target,
      verdict,
      summary: optStr(args, 'summary'),
      issues,
      hypothesis: hypothesisId || undefined,
      experiment: optStr(args, 'experiment') || undefined,
      createdAt: nowISO(),
    }
    study.reviews.push(review)
    const notes = [`评审 ${id}：${verdict}`]

    if (hypothesisId) {
      const hypothesis = study.hypotheses.find((h) => h.id === hypothesisId)
      if (!hypothesis) throw vaultErr('ERR_NOT_FOUND', `没有假设 ${hypothesisId}`)
      hypothesis.reviews = [...new Set([...(hypothesis.reviews ?? []), id])]
      // needs-work 不改变状态；其余按 verdict 推进（仅 testing 可被推进）
      if (verdict !== 'needs-work') {
        if (hypothesis.status === 'testing') {
          setHypStatus(hypothesis, verdict, `study_review:${id}`)
          notes.push(`假设 ${hypothesis.id} → ${verdict}`)
        } else {
          notes.push(`假设 ${hypothesis.id} 当前是 ${hypothesis.status}，未改动（只有 testing 能被评审结论推进）`)
        }
      }
    }
    study.updatedAt = nowISO()
    await pushHistory(root, study, { action: 'review', detail: notes.join('；'), phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)

    const lines = [`✓ 已登记评审 ${id}`, `  对象：${target}`, `  结论：${verdict}`]
    if (issues.length) lines.push(`  问题 ${issues.length} 条：${issues.slice(0, 3).join('；')}`)
    for (const note of notes.slice(1)) lines.push(`  ${note}`)
    return lines.join('\n')
  })
}

// ── 8. study_phase ─────────────────────────────────────────────────────────

async function cmdPhase(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const phase = requireStr(args, 'phase')
  const reason = optStr(args, 'reason')
  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const change = setPhase(study, phase, { reason, via: 'study_phase' })
    study.updatedAt = nowISO()
    await pushHistory(root, study, {
      action: 'phase',
      detail: `${change.from} → ${change.to}${reason ? `（原因：${reason}）` : ''}`,
      phase: change.to,
    })
    await writeJsonAtomic(studyPath(root), study)
    return [
      `✓ 阶段：${change.from} → ${change.to}${change.rewound && reason ? `（回退原因：${reason}）` : ''}`,
      `  阶段序列：${PHASES.join(' → ')}`,
    ].join('\n')
  })
}

// ── 注册 ────────────────────────────────────────────────────────────────────

const ROOT_PROP = { root: { type: 'string', description: '项目根（默认自动探测）' } }

export function apply(ctx) {
  ctx.tools.register(
    tool({
      name: 'study_init',
      description: '初始化研究项目：创建 research/study.json 与 records/reviews/envs 目录。幂等——已存在时只回报现状。研究循环的第一步。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { ...ROOT_PROP, title: { type: 'string' }, question: { type: 'string', description: '核心研究问题' } },
      },
      presentTitle: '初始化研究',
      execute: cmdInit,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_state',
      description:
        '研究全景：核心问题（含历史）、阶段、假设与状态、实验与工件、决策、评审、证据覆盖率（多少假设有文献支撑、多少实验有工件），' +
        '以及悬空引用检查。开始任何研究任务前先调它。detail=true 附完整 JSON。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          detail: { type: 'boolean', description: '附完整 study.json' },
          historyLimit: { type: 'number', description: '最近历史条数，默认 5' },
        },
      },
      presentTitle: '研究全景',
      execute: cmdState,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_hypothesis',
      description:
        '登记一条可证伪的研究假设。citekeys 可选：给了会校验文献库里是否存在（缺失只警告，不阻断）。' +
        '初始状态 proposed；结论不能在这里给，必须经 study_finding 或 study_review。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          text: { type: 'string', description: '假设内容（一句话、可证伪）' },
          citekeys: { type: 'array', items: { type: 'string' }, description: '支撑该假设的文献 citekey' },
          rationale: { type: 'string', description: '为什么这么猜' },
          question: { type: 'string', description: '若研究尚无核心问题，顺带设定' },
        },
        required: ['text'],
      },
      presentTitle: '登记假设',
      execute: cmdHypothesis,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_experiment',
      description:
        '登记一个验证假设的实验计划（分配 E01/E02…）：步骤、预期、随机种子、环境文件。' +
        '关联的 proposed 假设会自动转入 testing。跑完后用 record_save --experiment 保存工件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          title: { type: 'string' },
          hypothesis: { type: 'string', description: '关联假设编号，如 H1' },
          objective: { type: 'string', description: '要检验什么' },
          plan: { type: 'array', items: { type: 'string' }, description: '实验步骤' },
          expect: { type: 'string', description: '预期结果（先写下来，避免事后合理化）' },
          seed: { description: '随机种子' },
          env: { type: 'string', description: '环境文件路径' },
          status: { type: 'string', enum: ['planned', 'running', 'done', 'abandoned'] },
        },
        required: ['title'],
      },
      presentTitle: '登记实验',
      execute: cmdExperiment,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_finding',
      description:
        '记录实验的观察与结论：finding 追加到实验；conclusion 推进关联假设状态（仅 testing 可推进）并把阶段推向 analysis；' +
        'nextQuestion 开启下一轮——**旧问题会被归档到 question.history，不会丢失**。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          experiment: { type: 'string', description: '实验编号，如 E01' },
          finding: { type: 'string', description: '观察/分析发现' },
          conclusion: { type: 'string', enum: ['supported', 'refuted', 'inconclusive'], description: '对关联假设的结论' },
          nextQuestion: { type: 'string', description: '下一轮研究问题（会开启新一轮迭代）' },
        },
        required: ['experiment'],
      },
      presentTitle: '记录发现',
      execute: cmdFinding,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_decision',
      description:
        '登记一条技术决策：问题是什么、选了哪个、否决了哪些、为什么、依据哪些文献。' +
        '用于留住「当时为什么这么选」——这是纯结果记录无法回答的部分。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          question: { type: 'string', description: '要决定的问题' },
          chosen: { type: 'string', description: '最终选择' },
          alternatives: { type: 'array', items: { type: 'string' }, description: '否决掉的备选' },
          rationale: { type: 'string', description: '理由（必须写，否则决策日志没意义）' },
          citekeys: { type: 'array', items: { type: 'string' }, description: '支撑决策的文献' },
          experiment: { type: 'string', description: '关联实验编号' },
        },
        required: ['question', 'chosen', 'rationale'],
      },
      presentTitle: '登记决策',
      execute: cmdDecision,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_review',
      description:
        '登记一次评审结论（supported/refuted/inconclusive/needs-work）：写入 reviews 列表并与假设/实验关联；' +
        'testing 状态的假设会随评审结论推进。评审本身通常由 scientific-reviewer 技能启动子代理执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          target: { type: 'string', description: '被评审的对象（假设/实验/论断）' },
          verdict: { type: 'string', enum: ['supported', 'refuted', 'inconclusive', 'needs-work'] },
          summary: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
          hypothesis: { type: 'string' },
          experiment: { type: 'string' },
        },
        required: ['target', 'verdict'],
      },
      presentTitle: '登记评审',
      execute: cmdReview,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'study_phase',
      description:
        '推进研究阶段：literature → hypothesis → experiment → analysis → manuscript → concluded。' +
        '允许回退，但一次只能退一级且必须给出 reason（避免随手倒退，也避免一刀切禁止）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          phase: { type: 'string', enum: PHASES },
          reason: { type: 'string', description: '回退时必须给' },
        },
        required: ['phase'],
      },
      presentTitle: '推进阶段',
      execute: cmdPhase,
    }),
  )
}

export const __test__ = { cmdInit, cmdState, cmdHypothesis, cmdExperiment, cmdFinding, cmdDecision, cmdReview, cmdPhase }
