#!/usr/bin/env node
/**
 * build-patch — 从 agent.cordis.yml 生成 bundle 的 cordis.patch.yml
 *
 * bundle 的 patch 是 `- insert: [...]` 的 patch 列表，里面插一行
 * `@deepseek-ai/dsh-agent-preset`（与 web-app 的 standard preset 同机制）。
 * plugins 列表逐行取自 agent.cordis.yml，保持单一事实来源。
 *
 * 用法：
 *   node scripts/build-patch.mjs          # 生成/更新 cordis.patch.yml
 *   node scripts/build-patch.mjs --check  # 只校验是否与源一致（不写）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'agent.cordis.yml')
const TARGET = join(ROOT, 'cordis.patch.yml')

const DESCRIPTION =
  '通用科研 agent：领域调研（landscape 测绘）、文献检索（lit_search/lit_doi/lit_bib/lit_pdf 四个原生工具，' +
  '覆盖 Crossref/arXiv/PubMed/Europe PMC/LibGen）、' +
  '专业推导（sympy + pint + uncertainties + LaTeX）、出图与统计规范、版本化工件与溯源；' +
  '面向数理 / 物理工程材料 / AI 计算科学。'

const rows = (await readFile(SOURCE, 'utf8')).replace(/\s+$/, '')
const indented = rows
  .split('\n')
  .map((line) => (line.trim() ? '          ' + line : ''))
  .join('\n')

const patch = `# dsh-scientist — bundle patch
#
# 由 scripts/build-patch.mjs 从 agent.cordis.yml 生成，请勿手改。
# 改 preset（人格 / 工具面 / 技能行）请编辑 agent.cordis.yml 后重新生成。
#
# 安装：dsh plugin --profile web add link:<本包路径>
# 说明：本部署的 web profile 未挂载 @deepseek-ai/dsh-agent-presets（目录发现），
#       因此 preset 必须以「组合里声明的行」形式注册 —— 与 web-app 的 standard 同机制。
- insert:
    - id: preset-scientist
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: scientist
        name: 科学家模式
        description: >-
          ${DESCRIPTION}
        order: 10
        plugins:
${indented}
`

const check = process.argv.includes('--check')
let current = ''
try {
  current = await readFile(TARGET, 'utf8')
} catch {
  /* 首次生成 */
}

if (current === patch) {
  console.log('✓ cordis.patch.yml 与 agent.cordis.yml 一致')
  process.exit(0)
}
if (check) {
  console.error('✗ cordis.patch.yml 与 agent.cordis.yml 不一致，请运行 node scripts/build-patch.mjs')
  process.exit(1)
}

await writeFile(TARGET, patch)
const pluginRows = rows.split('\n').filter((line) => /^- id: /.test(line)).length
console.log(`✓ 已生成 ${TARGET}`)
console.log(`  顶层插件行: ${pluginRows}（含 group 的子行见文件）`)
