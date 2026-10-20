#!/usr/bin/env node
/**
 * Parse the installed composition with the LOADER'S OWN YAML dialect
 * (`@deepseek-ai/cordis-plugin-include` -> entryListSchema), so a file this
 * script accepts is exactly a file the loader can begin with.
 *
 * Usage: node scripts/check-loader.mjs [composition.yml]
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(process.argv[2] ?? join(here, '..', 'agent.cordis.yml'))

const checkout = process.env.DSH_CHECKOUT ?? '/home/blake/workspaces/dsh/deepseek-harness'
const includeEntry = join(checkout, 'vendor/include/lib/index.js')
if (!existsSync(includeEntry)) {
  console.log(`⚠ 找不到 DSH checkout（${checkout}），跳过本项校验。`)
  console.log('  可用 DSH_CHECKOUT=<harness 源码路径> 指定；或以 bundle 方式安装后忽略。')
  process.exit(0)
}
const { entryListSchema } = await import(includeEntry)

// `load` is js-yaml's, resolved from the include package's own dependency tree —
// the same instance whose `JSON_SCHEMA` `entryListSchema` extends.
const { createRequire } = await import('node:module')
const requireFromInclude = createRequire(includeEntry)
const yaml = requireFromInclude('js-yaml')

const text = await readFile(file, 'utf8')
let rows
try {
  rows = yaml.load(text, { schema: entryListSchema })
} catch (error) {
  console.error(`✗ ${file} is not valid in the loader dialect:`, error.message)
  process.exit(1)
}

if (!Array.isArray(rows)) {
  console.error('✗ composition must be a top-level list of plugin rows')
  process.exit(1)
}

const jsExprs = []
const names = []
const walk = (list, at = 'root') => {
  for (const [i, row] of list.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`${at} row ${i + 1} is not a plugin row`)
    }
    if (typeof row.name !== 'string' || row.name === '') {
      throw new Error(`${at} row ${i + 1} names no plugin`)
    }
    names.push(row.name)
    collectJs(row, `${at} row ${i + 1} (${row.name})`)
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${at} row ${i + 1} group config is not a list`)
      walk(row.config, `${at} row ${i + 1} (${row.name})`)
    }
  }
}
const collectJs = (value, at) => {
  if (Array.isArray(value)) return value.forEach((v) => collectJs(v, at))
  if (value && typeof value === 'object') {
    if (typeof value.__jsExpr === 'string') jsExprs.push({ at, expr: value.__jsExpr })
    else for (const v of Object.values(value)) collectJs(v, at)
  }
}

try {
  walk(rows)
} catch (error) {
  console.error('✗', error.message)
  process.exit(1)
}

console.log(`✓ ${file}`)
console.log(`  rows: ${names.length}, nested groups flattened`)
console.log(`  !!js expressions (${jsExprs.length}):`)
for (const { at, expr } of jsExprs) console.log(`    · ${at}\n      ${expr}`)

// Evaluate the expressions the way the loader does, to catch typos early.
for (const { at, expr } of jsExprs) {
  try {
    const value = new Function('process', `return (${expr})`)(process)
    console.log(`  → ${at} = ${JSON.stringify(value)}`)
  } catch (error) {
    console.error(`✗ ${at}: expression failed: ${error.message}`)
    process.exit(1)
  }
}
