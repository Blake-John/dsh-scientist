#!/usr/bin/env node
/**
 * Roster smoke test: for every preset directory under the user preset root,
 * parse `preset.yml` metadata and validate `agent.cordis.yml` with the LOADER'S
 * own YAML dialect — the same pair of checks the roster runs when it marks a
 * preset "broken".
 *
 * Self-contained on purpose: importing the checkout's @deepseek-ai/dsh-agent-presets
 * pulls in workspace packages whose built lib can be version-skewed against the
 * checkout, so this script only borrows the schema (`entryListSchema`).
 *
 * Usage: node scripts/check-roster.mjs [preset-root]
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(new URL(import.meta.url).pathname)
const checkout = process.env.DSH_CHECKOUT ?? '/home/blake/workspaces/dsh/deepseek-harness'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = resolve(process.argv[2] ?? join(dshHome, '.agent-presets'))

const includeEntry = join(checkout, 'vendor/include/lib/index.js')
if (!existsSync(includeEntry)) {
  console.log(`⚠ 找不到 DSH checkout（${checkout}），跳过本项校验。`)
  console.log('  可用 DSH_CHECKOUT=<harness 源码路径> 指定；或以 bundle 方式安装后忽略。')
  process.exit(0)
}
const { entryListSchema } = await import(includeEntry)
const requireFromInclude = createRequire(includeEntry)
const yaml = requireFromInclude('js-yaml')

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const rowsProblem = (rows) => {
  if (!Array.isArray(rows)) return 'the composition must be a top-level list of plugin rows'
  for (const [i, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return `row ${i + 1} is not a plugin row (expected a map with a "name")`
    }
    if (typeof row.name !== 'string' || row.name === '') return `row ${i + 1} names no plugin`
    if (row.group === true && !Array.isArray(row.config)) return `row ${i + 1} group config is not a list`
  }
  return undefined
}

const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
const ids = entries
  .filter((entry) => entry.isDirectory() && PRESET_ID.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (ids.length === 0) {
  console.log(`roster root: ${root}`)
  console.log('  （没有目录形态的 preset —— bundle 安装不依赖此目录，跳过）')
  process.exit(0)
}

let broken = 0
console.log(`roster root: ${root}`)
for (const id of ids) {
  const dir = join(root, id)
  let name = '(no name)'
  let order = '-'
  let problem
  try {
    const meta = yaml.load(await readFile(join(dir, 'preset.yml'), 'utf8')) ?? {}
    name = meta.name ?? '(no name)'
    order = meta.order ?? '-'
  } catch {
    /* preset.yml is optional */
  }
  const composition = join(dir, 'agent.cordis.yml')
  const exists = await stat(composition).then(() => true, () => false)
  if (!exists) {
    problem = 'agent.cordis.yml is missing'
  } else {
    try {
      problem = rowsProblem(yaml.load(await readFile(composition, 'utf8'), { schema: entryListSchema }))
    } catch (error) {
      problem = `invalid YAML: ${error.message}`
    }
  }
  if (problem) broken += 1
  console.log(`  · ${id.padEnd(14)} ${String(name).padEnd(12)} order=${String(order).padEnd(3)} ${problem ? `BROKEN — ${problem}` : 'ok'}`)
}

if (broken > 0) {
  console.error(`\n✗ ${broken} broken preset(s); fix before restarting the app`)
  process.exit(1)
}
console.log('\nOK: 目录形态的 preset 全部可解析。')
if (!ids.includes('scientist')) {
  console.log('  注：scientist 已改为 bundle 安装（dsh plugin add），不需要在这里出现。')
}
