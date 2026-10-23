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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendJsonl,
  bindAgentCwd,
  nowISO,
  optInt,
  optStr,
  readJson,
  requireStr,
  resolveRoot,
  vaultErr,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from './vault-core.mjs'
import { LAYOUT_V2, LAYOUT_VERSION, projectLayout } from './project-layout.mjs'

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
export const CLAIM_STATUSES = ['unverified', 'supported', 'contradicted']

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
  const paths = await projectLayout(root)
  for (const key of citekeys) {
    const file = join(root, paths.notes, `${key}.md`)
    if (!existsSync(file)) warnings.push(`文献库里没有 ${key}（${paths.notes}/${key}.md 不存在）`)
  }
  return warnings
}

// ── 索引（N6）────────────────────────────────────────────────────────────────

const table = (headers, rows) => {
  if (!rows.length) return '_（空）_'
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 70)

/** 自动生成 research/INDEX.md —— 人和机器都能一眼看全的研究目录 */
export function renderIndex(study, recordsIndex = { records: [] }, extra = {}) {
  const records = recordsIndex.records ?? []
  const out = []
  out.push(`# ${study.title || '未命名研究'}`)
  out.push('')
  out.push(`- 核心问题：${study.question?.text || '（未设定）'}`)
  out.push(`- 阶段：**${study.loop?.phase ?? '?'}** · 第 ${study.loop?.iteration ?? 0} 轮 · 更新于 ${study.updatedAt ?? ''}`)
  const noCite = study.hypotheses.filter((h) => !(h.citekeys ?? []).length)
  const noEvidence = study.claims.filter((c) => !(c.evidence?.citekeys ?? []).length && !(c.evidence?.records ?? []).length)
  out.push(`- 证据覆盖：假设 ${study.hypotheses.length - noCite.length}/${study.hypotheses.length} 有文献 · 论断 ${study.claims.length - noEvidence.length}/${study.claims.length} 有证据`)
  out.push('')

  if (extra.map?.length) {
    out.push('## 项目地图')
    out.push('')
    out.push(table(['层', '路径', '数量'], extra.map.map((m) => [m.layer, `\`${m.path}\``, m.count ?? '—'])))
    out.push('')
  }

  if (study.question?.history?.length) {
    out.push('## 问题演进')
    out.push('')
    out.push(table(['第几轮', '问题', '被哪次实验关闭'], study.question.history.map((q) => [q.iteration ?? '', cell(q.text), q.closedBy ?? ''])))
    out.push('')
  }

  out.push('## 假设')
  out.push('')
  out.push(table(['id', '状态', '内容', '文献', '实验'], study.hypotheses.map((h) => [
    h.id, h.status, cell(h.text), (h.citekeys ?? []).length ? h.citekeys.join(', ') : '⚠ 无', (h.experiments ?? []).join(', ') || '—',
  ])))
  out.push('')

  out.push('## 实验')
  out.push('')
  out.push(table(['id', '状态', '标题', '假设', '种子', '目录', '工件'], study.experiments.map((e) => [
    e.id, e.status, cell(e.title), e.hypothesis ?? '—', e.seed ?? '**未记录**', e.path ?? '—', (e.records ?? []).join(', ') || '—',
  ])))
  out.push('')

  out.push('## 决策')
  out.push('')
  out.push(table(['id', '问题', '选择', '否决', '理由'], study.decisions.map((d) => [
    d.id, cell(d.question), cell(d.chosen), (d.alternatives ?? []).join(', ') || '—', cell(d.rationale),
  ])))
  out.push('')

  out.push('## 工件')
  out.push('')
  out.push(table(['名称', '类型', '最新版本', '版本数', '更新时间'], records.map((r) => [
    cell(r.name), r.kind ?? '', `v${r.latest ?? '?'}`, r.versions ?? '', r.updatedAt ?? '',
  ])))
  out.push('')

  out.push('## 论断与证据')
  out.push('')
  out.push(table(['id', '状态', '论断', '文献', '工件'], study.claims.map((c) => [
    c.id, c.status, cell(c.text),
    (c.evidence?.citekeys ?? []).join(', ') || '⚠ 无',
    (c.evidence?.records ?? []).join(', ') || '⚠ 无',
  ])))
  out.push('')

  if ((study.reviews ?? []).length) {
    out.push('## 评审')
    out.push('')
    out.push(table(['id', '结论', '对象', '关联假设'], study.reviews.map((r) => [r.id, r.verdict, cell(r.target), r.hypothesis ?? '—'])))
    out.push('')
  }

  if (extra.surveys?.length) {
    out.push('## 调研')
    out.push('')
    out.push(table(['主题', '报告'], extra.surveys.map((s) => [s.name, `\`${s.path}\``])))
    out.push('')
  }

  if (extra.derivations?.length) {
    out.push('## 推导')
    out.push('')
    out.push(table(['id', '目录'], extra.derivations.map((d) => [d.name, `\`${d.path}\``])))
    out.push('')
  }

  if (extra.reviews?.length) {
    out.push('## 评审文档')
    out.push('')
    out.push(table(['文件', '路径'], extra.reviews.map((r) => [r.name, `\`${r.path}\``])))
    out.push('')
  }

  if (extra.outputs?.length) {
    out.push('## 交付物')
    out.push('')
    out.push(table(['目录', '路径'], extra.outputs.map((o) => [o.name, `\`${o.path}\``])))
    out.push('')
  }

  out.push('---')
  out.push('')
  out.push('由 study_* 工具自动生成；不要手改（会被覆盖）。')
  return `${out.join('\n')}\n`
}

async function listNames(dir, { files = false, dirs = false, ext = '' } = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => (files ? e.isFile() : true) && (dirs ? e.isDirectory() : true))
    .map((e) => e.name)
    .filter((name) => !ext || name.endsWith(ext))
    .sort()
}

/** 扫项目目录，给 INDEX.md 提供“项目地图”与各层清单 */
async function scanProject(root) {
  const paths = await projectLayout(root)
  const surveys = await listNames(join(root, paths.surveys), { dirs: true })
  const derivations = await listNames(join(root, paths.derivations), { dirs: true })
  const reviews = await listNames(join(root, paths.reviews), { files: true, ext: '.md' })
  const outputs = await listNames(join(root, paths.outputs), { dirs: true })
  const notes = await listNames(join(root, paths.notes), { files: true, ext: '.md' })
  const experiments = await listNames(join(root, paths.experiments), { dirs: true })
  const reports = await listNames(join(root, paths.reports), { files: true, ext: '.md' })
  const logs = await listNames(join(root, paths.logs), { files: true, ext: '.md' })
  const findings = await listNames(join(root, paths.findings), { files: true, ext: '.md' })
  return {
    map: [
      { layer: '代码', path: paths.codes, count: '—' },
      { layer: '调研', path: paths.surveys, count: surveys.length },
      { layer: '文献笔记', path: paths.notes, count: notes.length },
      { layer: '阶段报告', path: paths.reports, count: reports.length },
      { layer: '研究日志', path: paths.logs, count: logs.length },
      { layer: '发现', path: paths.findings, count: findings.length },
      { layer: '实验', path: paths.experiments, count: experiments.filter((n) => n !== 'derivations').length },
      { layer: '推导', path: paths.derivations, count: derivations.length },
      { layer: '工件', path: paths.records, count: '—' },
      { layer: '评审', path: paths.reviews, count: reviews.length },
      { layer: '交付', path: paths.outputs, count: outputs.length },
    ],
    surveys: surveys.map((name) => ({ name, path: `${paths.surveys}/${name}/report.md` })),
    derivations: derivations.map((name) => ({ name, path: `${paths.derivations}/${name}` })),
    reviews: reviews.map((name) => ({ name, path: `${paths.reviews}/${name}` })),
    outputs: outputs.map((name) => ({ name, path: `${paths.outputs}/${name}` })),
  }
}

export async function writeIndex(root, study) {
  const recordsIndex = await readJson(join(root, 'research', 'records', 'index.json'), { records: [] })
  const extra = await scanProject(root)
  const recordMap = extra.map.find((m) => m.layer === '工件')
  if (recordMap) recordMap.count = recordsIndex.records?.length ?? 0
  await mkdir(join(root, 'research'), { recursive: true })
  await writeFile(join(root, 'research', 'INDEX.md'), renderIndex(study, recordsIndex, extra), 'utf8')
}

/** v2 项目目录（按需建；scaffoldProject 建入口目录与说明） */
export const PROJECT_DIRS = [
  'codes', 'codes/notebooks', 'codes/scripts', 'codes/tests',
  'knowledge', 'knowledge/surveys', 'knowledge/literature', 'knowledge/literature/notes', 'knowledge/literature/pdfs',
  'knowledge/reports', 'knowledge/logs', 'knowledge/findings',
  'research', 'research/records', 'research/loops', 'research/reviews', 'research/decisions',
  'data', 'data/raw', 'data/interim', 'data/processed', 'data/external',
  'experiments', 'experiments/derivations',
  'outputs', 'outputs/manuscript', 'outputs/figures', 'outputs/tables', 'outputs/submission', 'outputs/exports',
  'envs', 'scratch',
]

const BIB_HEADER = `% references.bib —— 由 lit_bib 追加；也可手工维护\n% 校验：cite-check --root .\n\n`

const DIR_README = {
  'codes/README.md': '# codes\n\n可复用代码（模块 / notebooks / scripts / tests）。实验专用的一次性脚本放 `experiments/<id>/code/`，成熟后提升到这里。\n',
  'knowledge/README.md': '# knowledge\n\n学到的东西：`surveys/` 分阶段调研（survey.json + scope/sources/queries/candidates/landscape/papers/report）、`literature/` 论文与笔记、`reports/` 阶段总结、`logs/` 研究日志、`findings/` 原子发现。\n',
  'research/README.md': '# research\n\n当前研究状态（插件落地）：`study.json` 唯一真相、`INDEX.md` 项目地图、`loops/` 运行态、`records/` 工件登记、`reviews/` 评审长文、`decisions/` 决策长文。\n',
  'data/README.md': '# data\n\n原始/中间/处理后/外部数据；默认不入 git。新增数据登记到 `manifest.tsv`（来源、命令、sha256、许可、版本）。\n',
  'experiments/README.md': '# experiments\n\n每次实验一个目录：`design.md`、`config.yaml`、`run.sh`、`logs/`、`results/`；推导放 `derivations/<id>/`。\n',
  'outputs/README.md': '# outputs\n\n交付物：`manuscript/` 论文稿、`figures/` 最终图、`tables/` 最终表、`submission/` 投稿材料、`exports/` RO-Crate。\n',
  'envs/README.md': '# envs\n\n环境锁定文件（conda/uv lock）。跨 codes/ 与 experiments/ 共用。\n',
}

const ROOT_GITIGNORE = `# dsh-scientist —— 数据/临时/运行态默认不入 git
data/*
!data/README.md
!data/manifest.tsv
scratch/*
!scratch/.gitignore
research/loops/
research/export/
knowledge/literature/pdfs/
outputs/submission/
outputs/exports/
.pdf-assets/
__pycache__/
*.pyc
.venv/
node_modules/
*.h5
*.pt
*.pth
*.npy
*.npz
*.parquet
*.feather
*.sqlite
*.zip
*.tar.gz
`

const DATA_MANIFEST = 'path\tsource\tcommand\tsha256\tlicense\tversion\tnotes\n'

/** 建全目录与最小脚手架文件；返回实际创建/已存在的清单 */
export async function scaffoldProject(root) {
  const created = []
  for (const dir of PROJECT_DIRS) {
    const abs = withinRoot(root, dir)
    const existed = existsSync(abs)
    await mkdir(abs, { recursive: true })
    if (!existed) created.push(`${dir}/`)
  }
  for (const [rel, text] of Object.entries(DIR_README)) {
    const abs = withinRoot(root, rel)
    if (!existsSync(abs)) {
      await writeFile(abs, text, 'utf8')
      created.push(rel)
    }
  }
  const bib = withinRoot(root, LAYOUT_V2.bib)
  if (!existsSync(bib)) {
    await writeFile(bib, BIB_HEADER, 'utf8')
    created.push(LAYOUT_V2.bib)
  }
  const queries = withinRoot(root, LAYOUT_V2.queries)
  if (!existsSync(queries)) {
    await writeFile(queries, '# 检索式\n\n把可复用的检索式写在这里（同义词/布尔/字段限定）。\n', 'utf8')
    created.push(LAYOUT_V2.queries)
  }
  const manifest = withinRoot(root, LAYOUT_V2.dataManifest)
  if (!existsSync(manifest)) {
    await writeFile(manifest, DATA_MANIFEST, 'utf8')
    created.push(LAYOUT_V2.dataManifest)
  }
  const scratchIgnore = withinRoot(root, 'scratch/.gitignore')
  if (!existsSync(scratchIgnore)) {
    await writeFile(scratchIgnore, '*\n!.gitignore\n', 'utf8')
    created.push('scratch/.gitignore')
  }
  const gitignore = withinRoot(root, '.gitignore')
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, ROOT_GITIGNORE, 'utf8')
    created.push('.gitignore')
  }
  return created
}

/** 根 README 的托管块；保留用户自己写的内容 */
export async function writeRootReadme(root, study) {
  const BEGIN = '<!-- dsh-scientist:begin -->'
  const END = '<!-- dsh-scientist:end -->'
  const block = [
    BEGIN,
    `# ${study.title || '未命名研究'}`,
    '',
    `- 核心问题：${study.question?.text || '（未设定）'}`,
    `- 阶段：**${study.loop?.phase ?? '?'}** · 第 ${study.loop?.iteration ?? 0} 轮`,
    '- 研究状态：`research/study.json` · 项目地图：`research/INDEX.md`',
    '',
    '## 目录',
    '| 层 | 放什么 |',
    '|---|---|',
    '| `codes/` | 可复用代码 |',
    '| `knowledge/` | 调研 / 文献 / 阶段报告 / 研究日志 / 发现 |',
    '| `research/` | 研究状态、工件登记、推导、评审、决策 |',
    '| `data/` | 原始/中间/处理后/外部数据（默认不入 git） |',
    '| `experiments/` | 每次实验的设计、运行、日志与结果 |',
    '| `outputs/` | 论文稿、最终图、表、投稿材料、导出 |',
    '| `envs/` | 环境锁定 |',
    '| `scratch/` | 临时文件（不入 git） |',
    '',
    '## 接手',
    '新会话先跑 `/status`；调研从 `/survey-scan` 开始（scan→scholar→map→papers→report）；精读 `/paper`；推导 `/derive`；成文 `/write`；评审 `/review`。',
    END,
  ].join('\n')
  const file = withinRoot(root, 'README.md')
  const existing = await readFile(file, 'utf8').catch(() => '')
  const next = existing.includes(BEGIN) && existing.includes(END)
    ? existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block)
    : existing
      ? `${block}\n\n${existing}`
      : `${block}\n`
  await writeFile(file, next, 'utf8')
}

/**
 * 供命令层复用：不存在则建（可标记 autoCreated/origin），存在则可更新 title/question。
 * 与 study_init 工具共用同一份 schema，避免两套初始化逻辑漂移。
 */
export async function ensureStudy(root, { title, question, autoCreated = false, origin, update = false } = {}) {
  return await withFileLock(lockPath(root), {}, async () => {
    const existing = await readJson(studyPath(root), null)
    if (existing) {
      if (update && (title || question)) {
        if (title) existing.title = title
        if (question) {
          existing.question ??= { text: '', history: [] }
          existing.question.text = question
          existing.question.updatedAt = nowISO()
        }
        existing.updatedAt = nowISO()
        await writeJsonAtomic(studyPath(root), existing)
        await writeRootReadme(root, existing)
      }
      return { study: existing, created: false }
    }
    const createdPaths = await scaffoldProject(root)
    const stamp = nowISO()
    const study = {
      schema: SCHEMA,
      layout: LAYOUT_VERSION,
      title: title || '未命名研究',
      createdAt: stamp,
      updatedAt: stamp,
      autoCreated: Boolean(autoCreated),
      origin: origin ?? undefined,
      question: { text: question ?? '', history: [], updatedAt: stamp },
      loop: { phase: 'literature', iteration: 1, history: [] },
      hypotheses: [],
      experiments: [],
      decisions: [],
      reviews: [],
      claims: [],
    }
    await writeJsonAtomic(studyPath(root), study)
    await writeRootReadme(root, study)
    await writeIndex(root, study)
    return { study, created: true, createdPaths }
  })
}

// ── 1. study_init ───────────────────────────────────────────────────────────

async function cmdInit(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
  return await withFileLock(lockPath(root), {}, async () => {
    const existing = await readJson(studyPath(root), null)
    if (existing) {
      return [
        `· 研究已存在，未做改动：${existing.title || '(未命名)'}`,
        `  阶段 ${existing.loop?.phase ?? '?'} · 假设 ${(existing.hypotheses ?? []).length} · 实验 ${(existing.experiments ?? []).length}`,
        '下一步：study_state 看全貌，或 study_hypothesis 登记第一条假设。',
      ].join('\n')
    }
    const createdPaths = await scaffoldProject(root)
    const stamp = nowISO()
    const study = {
      schema: SCHEMA,
      layout: LAYOUT_VERSION,
      title: optStr(args, 'title', '未命名研究'),
      createdAt: stamp,
      updatedAt: stamp,
      question: { text: optStr(args, 'question'), history: [], updatedAt: stamp  },
      loop: { phase: 'literature', iteration: 1, history: [] },
      hypotheses: [],
      experiments: [],
      decisions: [],
      reviews: [],
      claims: [],
    }
    await pushHistory(root, study, { action: 'init', detail: `研究「${study.title}」创建`, phase: 'literature' })
    await writeJsonAtomic(studyPath(root), study)
    await writeRootReadme(root, study)
    await writeIndex(root, study)
    return [
      `✓ 已创建研究：${study.title}`,
      `  清单 research/study.json`,
      `  目录 ${createdPaths.filter((p) => p.endsWith('/')).length} 个（见 README.md 的目录表）`,
      createdPaths.some((p) => p.includes('references.bib')) ? `  书目 ${LAYOUT_V2.bib}` : '  书目（已存在）',
      study.question.text ? `  核心问题：${study.question.text}` : '  （未填核心问题，可用 study_init --question 补，或在 study_hypothesis 里给）',
      '',
      '建议顺序：literature（lit_search/lit_pdf/lit-lib）→ study_hypothesis → study_experiment → 跑代码 → record_save → study_finding。',
    ].join('\n')
  })
}

// ── 2. study_state ──────────────────────────────────────────────────────────

async function cmdState(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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

  const paths = await projectLayout(root)
  const noteFiles = await readdir(join(root, paths.notes)).catch(() => [])
  const noteKeys = new Set(noteFiles.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))
  const usedKeys = new Set([
    ...study.hypotheses.flatMap((h) => h.citekeys ?? []),
    ...study.decisions.flatMap((d) => d.citekeys ?? []),
    ...study.claims.flatMap((c) => c.evidence?.citekeys ?? []),
  ])
  const missingNotes = [...usedKeys].filter((k) => !noteKeys.has(k))
  const unusedNotes = [...noteKeys].filter((k) => !usedKeys.has(k))
  lines.push(
    '',
    `文献库：笔记 ${noteKeys.size} 篇 · 被研究引用 ${usedKeys.size} 个 · 缺笔记 ${missingNotes.length} · 未引用 ${unusedNotes.length}`,
  )
  if (missingNotes.length) lines.push(`  缺笔记：${missingNotes.slice(0, 8).join(', ')}`)

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
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
    await writeIndex(root, study)
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

async function scaffoldExperiment(root, experiment) {
  const dir = join(root, 'experiments', experiment.id)
  await mkdir(join(dir, 'code'), { recursive: true })
  await mkdir(join(dir, 'logs'), { recursive: true })
  await mkdir(join(dir, 'results'), { recursive: true })
  const design = join(dir, 'design.md')
  if (!existsSync(design)) {
    await writeFile(
      design,
      [
        `# ${experiment.id} ${experiment.title}`,
        '',
        `- 假设：${experiment.hypothesis ?? '（未关联）'}`,
        `- 目标：${experiment.objective ?? '（待补）'}`,
        `- 预期：${experiment.expect ?? '（待补）'}`,
        `- 种子：${experiment.seed ?? '（待补）'}`,
        `- 环境：${experiment.env ?? '（待补）'}`,
        '',
        '## 步骤',
        ...(experiment.plan?.length ? experiment.plan.map((p, i) => `${i + 1}. ${p}`) : ['1. （待补）']),
        '',
      ].join('\n'),
      'utf8',
    )
  }
  const config = join(dir, 'config.yaml')
  if (!existsSync(config)) {
    await writeFile(config, `seed: ${experiment.seed ?? ''}\nenv: ${experiment.env ?? ''}\nparams: {}\n`, 'utf8')
  }
  const run = join(dir, 'run.sh')
  if (!existsSync(run)) {
    await writeFile(run, '#!/usr/bin/env bash\nset -euo pipefail\n\n# 调用 codes/ 里的模块；结果写 results/\n', 'utf8')
  }
}

async function cmdExperiment(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
      path: `experiments/${id}`,
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
    await scaffoldExperiment(root, experiment)
    await pushHistory(root, study, { action: 'experiment', detail: `新增实验 ${id}`, phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)
    await writeIndex(root, study)

    const lines = [`✓ 已登记实验 ${id}（${experiment.status}）`, `  ${title}`]
    if (hypothesis) lines.push(`  验证假设：${hypothesis.id}（${hypothesis.status}）`)
    if (plan.length) lines.push(`  步骤 ${plan.length} 条`)
    if (experiment.seed !== undefined) lines.push(`  种子 ${experiment.seed}`)
    if (experiment.env) lines.push(`  环境 ${experiment.env}`)
    for (const w of warnings) lines.push(`  ⚠ ${w}`)
    if (phaseChange) lines.push(`  阶段：${phaseChange.from} → ${phaseChange.to}`)
    lines.push('', `目录：${experiment.path}/（design.md / config.yaml / run.sh / logs/ / results/）`)
    lines.push(`下一步：跑完后 record_save --experiment ${id} 保存工件，再 study_finding --experiment ${id} 记录结论。`)
    return lines.join('\n')
  })
}

// ── 5. study_finding ───────────────────────────────────────────────────────

async function cmdFinding(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
    await writeIndex(root, study)

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
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
    await writeIndex(root, study)
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
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
      path: `research/reviews/${id}.md`,
      createdAt: nowISO(),
    }
    study.reviews.push(review)
    const notes = [`评审 ${id}：${verdict}`]

    await mkdir(join(root, 'research', 'reviews'), { recursive: true })
    await writeFile(
      join(root, 'research', 'reviews', `${id}.md`),
      [
        `# ${id} 评审：${target}`,
        '',
        `- 结论：${verdict}`,
        `- 关联假设：${hypothesisId ?? '—'}`,
        `- 关联实验：${review.experiment ?? '—'}`,
        `- 日期：${review.createdAt}`,
        '',
        '## 摘要',
        review.summary || '（待补）',
        '',
        '## 问题',
        ...(issues.length ? issues.map((x, i) => `${i + 1}. ${x}`) : ['（无）']),
        '',
      ].join('\n'),
      'utf8',
    ).catch(() => {})

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
    await writeIndex(root, study)

    const lines = [`✓ 已登记评审 ${id}`, `  对象：${target}`, `  结论：${verdict}`, `  文档：${review.path}`]
    if (issues.length) lines.push(`  问题 ${issues.length} 条：${issues.slice(0, 3).join('；')}`)
    for (const note of notes.slice(1)) lines.push(`  ${note}`)
    return lines.join('\n')
  })
}

// ── 8. study_phase ─────────────────────────────────────────────────────────

async function cmdPhase(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
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
    await writeIndex(root, study)
    return [
      `✓ 阶段：${change.from} → ${change.to}${change.rewound && reason ? `（回退原因：${reason}）` : ''}`,
      `  阶段序列：${PHASES.join(' → ')}`,
    ].join('\n')
  })
}

// ── 9. study_claim ────────────────────────────────────────────────────────

async function cmdClaim(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd), exec?.cwd)
  const status = optStr(args, 'status', 'unverified')
  if (!CLAIM_STATUSES.includes(status)) throw vaultErr('ERR_BAD_ARGS', `status 必须是 ${CLAIM_STATUSES.join(' / ')}`)
  const citekeys = Array.isArray(args.citekeys) ? args.citekeys.map(String) : []
  const records = Array.isArray(args.records) ? args.records.map(String) : []
  const existingId = optStr(args, 'id')

  return await withFileLock(lockPath(root), {}, async () => {
    const study = await loadStudy(root)
    const recordsIndex = await readJson(join(root, 'research', 'records', 'index.json'), { records: [] })
    const known = new Set((recordsIndex.records ?? []).map((r) => r.slug))
    for (const rec of records) {
      const slug = String(rec).split('@')[0]
      if (!known.has(slug)) throw vaultErr('ERR_NOT_FOUND', `工件不存在：${rec}（用 record_save 先保存，或 record_list 查看）`)
    }
    const warnings = await checkCitekeys(root, citekeys)

    if (existingId) {
      const claim = study.claims.find((c) => c.id === existingId)
      if (!claim) throw vaultErr('ERR_NOT_FOUND', `没有论断 ${existingId}`)
      claim.status = status
      if (optStr(args, 'text')) claim.text = optStr(args, 'text')
      for (const key of citekeys) if (!(claim.evidence.citekeys ?? []).includes(key)) (claim.evidence.citekeys ??= []).push(key)
      for (const rec of records) if (!(claim.evidence.records ?? []).includes(rec)) (claim.evidence.records ??= []).push(rec)
      claim.history ??= []
      claim.history.push({ at: nowISO(), to: status, via: 'study_claim' })
      study.updatedAt = nowISO()
      await pushHistory(root, study, { action: 'claim', detail: `更新论断 ${existingId} → ${status}`, phase: study.loop.phase })
      await writeJsonAtomic(studyPath(root), study)
      await writeIndex(root, study)
      const lines = [`✓ 已更新论断 ${existingId} → ${status}`, `  ${claim.text}`]
      if (!(claim.evidence.citekeys ?? []).length && !(claim.evidence.records ?? []).length) {
        lines.push('  ⚠ 该论断目前没有任何证据')
      }
      for (const w of warnings) lines.push(`  ⚠ ${w}`)
      return lines.join('\n')
    }

    const text = requireStr(args, 'text')
    const id = nextId(study.claims, 'C')
    const claim = {
      id,
      text,
      location: optStr(args, 'location') || undefined,
      evidence: { citekeys, records },
      status,
      createdAt: nowISO(),
      history: [{ at: nowISO(), to: status, via: 'study_claim' }],
    }
    study.claims.push(claim)
    study.updatedAt = nowISO()
    await pushHistory(root, study, { action: 'claim', detail: `新增论断 ${id}（${status}）`, phase: study.loop.phase })
    await writeJsonAtomic(studyPath(root), study)
    await writeIndex(root, study)

    const lines = [`✓ 已登记论断 ${id}（${status}）`, `  ${text}`]
    if (citekeys.length) lines.push(`  文献证据：${citekeys.join(', ')}`)
    if (records.length) lines.push(`  工件证据：${records.join(', ')}`)
    if (!citekeys.length && !records.length) lines.push('  ⚠ 没有证据——这类论断会被 cite-check --deep 列出来')
    for (const w of warnings) lines.push(`  ⚠ ${w}`)
    return lines.join('\n')
  })
}

// ── 注册 ────────────────────────────────────────────────────────────────────

const ROOT_PROP = { root: { type: 'string' } }

export function apply(ctx) {
  const register = (def) => ctx.tools.register(bindAgentCwd(ctx, def))
  register(
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

  register(
    tool({
      name: 'study_state',
      description:
        '研究全景：核心问题（含历史）、阶段、假设、实验、决策、评审、证据覆盖率、悬空引用。detail=true 附 JSON。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          detail: { type: 'boolean' },
          historyLimit: { type: 'number' },
        },
      },
      presentTitle: '研究全景',
      execute: cmdState,
    }),
  )

  register(
    tool({
      name: 'study_hypothesis',
      description:
        '登记可证伪假设；citekeys 可选（缺失只警告）。结论不能在这里给，须经 study_finding 或 study_review。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          text: { type: 'string' },
          citekeys: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['text'],
      },
      presentTitle: '登记假设',
      execute: cmdHypothesis,
    }),
  )

  register(
    tool({
      name: 'study_experiment',
      description:
        '登记实验计划（E01…）：步骤、预期、种子、环境。关联的 proposed 假设自动转 testing。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          title: { type: 'string'  },
          hypothesis: { type: 'string' },
          objective: { type: 'string' },
          plan: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['planned', 'running', 'done', 'abandoned'] },
          expect: { type: 'string', description: '预期结果（先写下来，避免事后合理化）' },
          seed: { description: '随机种子'  },
          env: { type: 'string', description: '环境文件路径' },
        },
        required: ['title'],
      },
      presentTitle: '登记实验',
      execute: cmdExperiment,
    }),
  )

  register(
    tool({
      name: 'study_finding',
      description:
        '记录观察与结论：conclusion 推进假设状态与阶段；nextQuestion 开启新一轮并归档旧问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          experiment: { type: 'string' },
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

  register(
    tool({
      name: 'study_decision',
      description:
        '登记决策：问题、选择、否决项、理由、依据文献。留住「当时为什么这么选」。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          question: { type: 'string' },
          chosen: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          citekeys: { type: 'array', items: { type: 'string' } },
          experiment: { type: 'string' },
        },
        required: ['question', 'chosen', 'rationale'],
      },
      presentTitle: '登记决策',
      execute: cmdDecision,
    }),
  )

  register(
    tool({
      name: 'study_review',
      description:
        '登记评审结论（supported/refuted/inconclusive/needs-work）；testing 假设随之推进。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          target: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'refuted', 'inconclusive', 'needs-work']  },
          summary: { type: 'string'  },
          issues: { type: 'array', items: { type: 'string' }  },
          hypothesis: { type: 'string'  },
          experiment: { type: 'string'  },
        },
        required: ['target', 'verdict'],
      },
      presentTitle: '登记评审',
      execute: cmdReview,
    }),
  )

  register(
    tool({
      name: 'study_claim',
      description:
        '把论断绑到证据（citekey + 工件）；给 id 则更新状态。无证据的论断会被 cite-check --deep 列出。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          text: { type: 'string' },
          citekeys: { type: 'array', items: { type: 'string' } },
          records: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: CLAIM_STATUSES },
          id: { type: 'string' },
        },
      },
      presentTitle: '登记论断',
      execute: cmdClaim,
    }),
  )

  register(
    tool({
      name: 'study_phase',
      description:
        '推进阶段 literature→hypothesis→experiment→analysis→manuscript→concluded。回退只能一级且必须给 reason。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ROOT_PROP,
          phase: { type: 'string', enum: PHASES  },
          reason: { type: 'string' },
        },
        required: ['phase'],
      },
      presentTitle: '推进阶段',
      execute: cmdPhase,
    }),
  )
}

export const __test__ = { ensureStudy, cmdInit, cmdState, cmdHypothesis, cmdExperiment, cmdFinding, cmdDecision, cmdReview, cmdPhase, cmdClaim, writeIndex }
