#!/usr/bin/env node
/**
 * check-patch — 校验本包的 cordis.patch.yml
 *
 * 检查：能被 loader 方言解析、存在 preset-scientist 行、config.id/name/order 正确、
 * plugins 行数与 agent.cordis.yml 一致、!!js 表达式可求值、技能 provider 行存在。
 *
 * 用法：node scripts/check-patch.mjs [patch.yml]
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = resolve(process.argv[2] ?? join(ROOT, 'cordis.patch.yml'))
const checkout = process.env.DSH_CHECKOUT ?? '/home/blake/workspaces/dsh/deepseek-harness'

const includeEntry = join(checkout, 'vendor/include/lib/index.js')
if (!existsSync(includeEntry)) {
  console.log(`⚠ 找不到 DSH checkout（${checkout}），跳过本项校验。`)
  console.log('  可用 DSH_CHECKOUT=<harness 源码路径> 指定；或以 bundle 方式安装后忽略。')
  process.exit(0)
}
const { entryListSchema } = await import(includeEntry)
const yaml = createRequire(includeEntry)('js-yaml')

const load = async (file) => yaml.load(await readFile(file, 'utf8'), { schema: entryListSchema })

let doc
try {
  doc = await load(patchPath)
} catch (error) {
  console.error(`✗ ${patchPath} 不是合法的 patch 列表: ${error.message}`)
  process.exit(1)
}
if (!Array.isArray(doc)) {
  console.error('✗ patch 文件顶层必须是列表')
  process.exit(1)
}

let row = null
let jsExprs = 0
const walk = (value) => {
  if (Array.isArray(value)) return value.forEach(walk)
  if (value && typeof value === 'object') {
    if (typeof value.__jsExpr === 'string') jsExprs += 1
    if (value.id === 'preset-scientist') row = value
    Object.values(value).forEach(walk)
  }
}
walk(doc)

if (!row) {
  console.error('✗ 未找到 preset-scientist 行')
  process.exit(1)
}

// 与源组合对齐
const composition = await load(join(ROOT, 'agent.cordis.yml'))
const expected = composition.length
const actual = row.config?.plugins?.length ?? 0

const problems = []
if (row.config?.id !== 'scientist') problems.push(`config.id = ${row.config?.id}`)
if (!row.config?.name) problems.push('config.name 缺失')
if (row.config?.order !== 10) problems.push(`config.order = ${row.config?.order}`)
if (actual !== expected) problems.push(`plugins 行数 ${actual} != 源组合 ${expected}`)
if (jsExprs === 0) problems.push('未找到 !!js 表达式（tool-bash / tool-pwsh 的平台判断）')

const plugins = row.config?.plugins ?? []
const pdfRow = plugins.find((p) => p.id === 'pdf-tools')
if (!pdfRow) problems.push('缺少 pdf-tools 行')
else if (pdfRow.name !== 'dsh-scientist/pdf-tools.mjs') problems.push(`pdf-tools 的 name = ${pdfRow.name}`)
const litRow = plugins.find((p) => p.id === 'lit-tools')
if (!litRow) problems.push('缺少 lit-tools 行')
else if (litRow.name !== 'dsh-scientist/lit-tools.mjs') problems.push(`lit-tools 的 name = ${litRow.name}`)

const providerRow = plugins.find((p) => p.id === 'science-skills')
if (!providerRow) problems.push('缺少 science-skills 技能 provider 行')
else if (providerRow.name !== 'dsh-scientist/skills-provider.mjs') {
  problems.push(`science-skills 的 name = ${providerRow.name}`)
}
const fsRow = plugins.find((p) => p.id === 'skill-filesystem')
if (fsRow?.config?.customSkillDirs) problems.push('skill-filesystem 仍带 customSkillDirs（应改用 provider）')

// 每个 dsh-scientist/* 的插件行都必须能从本包解析到（exports 漏写会导致挂载失败）
const selfName = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).name
const selfRequire = createRequire(join(ROOT, 'package.json'))
for (const row of plugins) {
  if (typeof row.name !== 'string' || !row.name.startsWith(`${selfName}/`)) continue
  try {
    selfRequire.resolve(row.name)
  } catch (error) {
    problems.push(`${row.id}: ${row.name} 无法解析（${error.code}）—— 检查 package.json exports`)
  }
}

console.log(`patch: ${patchPath}`)
console.log(`  顶层 patch 条目: ${doc.length}`)
console.log(`  preset: id=${row.config?.id} name=${row.config?.name} order=${row.config?.order}`)
console.log(`  plugins: ${actual}（源组合 ${expected}）`)
console.log(`  !!js 表达式: ${jsExprs}`)
console.log(`  技能 provider: ${providerRow?.name ?? '(缺失)'}`)

if (problems.length) {
  console.error('\n✗ ' + problems.join('；'))
  process.exit(1)
}
console.log('\n✓ bundle patch 注册正确。')
