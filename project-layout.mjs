// project-layout —— 项目目录布局的唯一真相
//
// v2（当前）：
//   codes/ knowledge/ research/ data/ experiments/ outputs/ envs/ scratch/
//
// v1（旧项目，只读兼容）：
//   literature/ data/papers/ reports/ derivations/ figures/ manuscript/ reviews/
//
// 新项目写 `research/study.json.layout = 'v2'`；`vault migrate --to v2` 把 v1 迁到 v2。
// 所有工具/命令/技能都从这里取路径，不再散落硬编码。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './vault-core.mjs'

export const LAYOUT_VERSION = 'v2'

export const LAYOUT_V2 = {
  // 代码
  codes: 'codes',
  // 知识
  knowledge: 'knowledge',
  surveys: 'knowledge/surveys',
  literature: 'knowledge/literature',
  notes: 'knowledge/literature/notes',
  pdfs: 'knowledge/literature/pdfs',
  bib: 'knowledge/literature/references.bib',
  queries: 'knowledge/literature/queries.md',
  reports: 'knowledge/reports',
  logs: 'knowledge/logs',
  findings: 'knowledge/findings',
  // 研究状态
  research: 'research',
  study: 'research/study.json',
  index: 'research/INDEX.md',
  loops: 'research/loops',
  records: 'research/records',
  reviews: 'research/reviews',
  decisions: 'research/decisions',
  // 数据
  data: 'data',
  dataManifest: 'data/manifest.tsv',
  dataReadme: 'data/README.md',
  // 实验
  experiments: 'experiments',
  derivations: 'experiments/derivations',
  // 交付
  outputs: 'outputs',
  manuscript: 'outputs/manuscript',
  figures: 'outputs/figures',
  tables: 'outputs/tables',
  submission: 'outputs/submission',
  exports: 'outputs/exports',
  // 环境与临时
  envs: 'envs',
  scratch: 'scratch',
}

export const LAYOUT_V1 = {
  ...LAYOUT_V2,
  knowledge: 'reports',
  surveys: 'reports',
  literature: 'literature',
  notes: 'literature/notes',
  pdfs: 'data/papers',
  bib: 'literature/references.bib',
  queries: 'literature/queries.md',
  reports: 'reports',
  logs: 'reports',
  findings: 'reports',
  derivations: 'derivations',
  reviews: 'reviews',
  decisions: 'research/decisions',
  outputs: '.',
  manuscript: 'manuscript',
  figures: 'figures',
  tables: 'figures',
  submission: 'manuscript',
  exports: 'research/export',
}

/** 读 study.json.layout；没有就按目录特征猜（knowledge/codes 存在 → v2） */
export async function detectLayout(root) {
  const study = await readJson(join(root, 'research', 'study.json'), null).catch(() => null)
  if (study?.layout === 'v2' || study?.layout === 'v1') return study.layout
  if (existsSync(join(root, 'knowledge')) || existsSync(join(root, 'codes'))) return 'v2'
  return 'v1'
}

/** 返回 { version, ...路径 }；所有路径都是相对项目根的字符串 */
export async function projectLayout(root) {
  const version = await detectLayout(root)
  return { version, ...(version === 'v2' ? LAYOUT_V2 : LAYOUT_V1) }
}

export const layoutPaths = (version) => ({ version, ...(version === 'v2' ? LAYOUT_V2 : LAYOUT_V1) })

/** v2：knowledge/surveys/<slug>/report.md；v1：reports/landscape-<slug>.md */
export function surveyReportPath(root, paths, slug) {
  return paths.version === 'v2'
    ? join(root, paths.surveys, slug, 'report.md')
    : join(root, paths.reports, `landscape-${slug}.md`)
}

/** v2：knowledge/surveys/<slug>/；v1：reports/ */
export function surveyDir(root, paths, slug) {
  return paths.version === 'v2' ? join(root, paths.surveys, slug) : join(root, paths.reports)
}

export function derivationDir(root, paths, id) {
  return join(root, paths.derivations, id)
}

export function reportPath(root, paths, name) {
  return join(root, paths.reports, name)
}
