#!/usr/bin/env node
/**
 * check-patch — 校验本包的 cordis.patch.yml
 *
 * 检查：能被 loader 方言解析、存在 preset-scientist 行、config.id/name/order 正确、
 * plugins 行数与 agent.cordis.yml 一致、!!js 表达式可求值、技能 provider 行存在。
 *
 * 用法：node scripts/check-patch.mjs [patch.yml]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = resolve(process.argv[2] ?? join(ROOT, 'cordis.patch.yml'))
const checkout = process.env.DSH_CHECKOUT ?? '/home/blake/workspaces/dsh/deepseek-harness'

// ── 不依赖 checkout 的文本级断言（CI 环境也能跑）────────────────────────────
// 历史 bug：persona 行把 config 的 `prefix` 写成 `text`，YAML 结构校验全过，
// 挂载时插件 schema 报 "prefix required"。这里做最廉价的一道拦截。
const rawPatch = await readFile(patchPath, 'utf8').catch(() => '')
const textKeyHits = [...rawPatch.matchAll(/^\s{8,}text:\s*[|>]/gm)].length
if (textKeyHits) {
  console.error(`✗ patch 中出现 ${textKeyHits} 处裸 \`text:\` 配置键——persona 插件要求的是 \`prefix:\``)
  process.exit(1)
}
if (!/^\s{8,}prefix:\s*[|>]/m.test(rawPatch)) {
  console.error('✗ patch 中找不到 persona 的 `prefix:` 文本块')
  process.exit(1)
}

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

// 科研记录两组工具（P4 加入）
for (const [id, file] of [['vault-record', 'vault-record.mjs'], ['vault-study', 'vault-study.mjs']]) {
  const row = plugins.find((p) => p.id === id)
  if (!row) problems.push(`缺少 ${id} 行`)
  else if (row.name !== `dsh-scientist/${file}`) problems.push(`${id} 的 name = ${row.name}`)
}

// 凡是 dsh-scientist/ 开头的行，对应文件必须真的存在（防拼错文件名）
for (const row of plugins) {
  if (typeof row.name !== 'string' || !row.name.startsWith('dsh-scientist/')) continue
  const rel = row.name.slice('dsh-scientist/'.length)
  if (!existsSync(join(ROOT, rel))) problems.push(`行 ${row.id} 指向不存在的文件: ${rel}`)
}

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


// ── 插件 config 字段审计 ────────────────────────────────────────────────────
// 曾经踩过的坑：persona 行把 `prefix` 写成了 `text`，YAML 结构校验全过，
// 但挂载时插件 schema 报 "prefix required"。这里直接读插件源码的 z.object 定义比对。
function auditConfigs(list, checkoutRoot, problems) {
  const nameToSrc = new Map()
  const skipDirs = new Set(['node_modules', 'lib', 'dist', 'tests', 'test'])
  const walk = (dir, depth = 0) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('package.json') && entries.includes('src')) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const srcDir = join(dir, 'src')
        for (const file of readdirSync(srcDir)) {
          if (!file.endsWith('.ts')) continue
          const full = join(srcDir, file)
          const src = readFileSync(full, 'utf8')
          if (src.includes('Config') && src.includes('z.object')) {
            nameToSrc.set(pkg.name, full)
            break
          }
        }
      } catch {
        /* 忽略坏包 */
      }
    }
    for (const entry of entries) {
      if (skipDirs.has(entry) || entry.startsWith('.')) continue
      const child = join(dir, entry)
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1)
      } catch {
        /* 忽略 */
      }
    }
  }
  for (const base of ['packages', 'apps']) walk(join(checkoutRoot, base))

  const flatten = (rows, out = []) => {
    for (const row of rows) {
      out.push(row)
      if (Array.isArray(row.group)) flatten(row.group, out)
      if (Array.isArray(row.config?.plugins)) flatten(row.config.plugins, out)
    }
    return out
  }

  let checked = 0
  for (const row of flatten(list)) {
    if (!String(row.name).startsWith('@deepseek-ai/')) continue
    const hasConfig = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
    const used = hasConfig ? Object.keys(row.config).filter((key) => key !== 'plugins') : []
    const srcPath = nameToSrc.get(row.name)
    // 找不到源码不是错误：包名合法性已由 auditShippedNames 负责，
    // 这里只做「能读到 schema 就比对」的增量校验。
    if (!srcPath) continue
    const text = readFileSync(srcPath, 'utf8')
    const start = Math.max(text.indexOf('const Config'), text.indexOf('static Config'))
    const body = start >= 0 ? /z\.object\(\{([\s\S]*?)\n\}\)/.exec(text.slice(start, start + 4000)) : null
    if (!body) continue
    const allowed = new Set([...body[1].matchAll(/^\s{2}([a-zA-Z]\w*)\s*:/gm)].map((m) => m[1]))
    if (!allowed.size) continue
    const required = new Set(
      [...body[1].matchAll(/^\s{2}([a-zA-Z]\w*)\s*:\s*[^\n]*\.required\(\)/gm)].map((m) => m[1]),
    )
    checked += 1
    const unknown = used.filter((key) => !allowed.has(key))
    if (unknown.length) {
      problems.push(`${row.id}: config 含 ${row.name} 不接受的字段 ${unknown.join(', ')}（合法：${[...allowed].join(', ')}）`)
    }
    const missingRequired = [...required].filter((key) => !used.includes(key))
    if (missingRequired.length) {
      problems.push(`${row.id}: ${row.name} 要求必填字段 ${missingRequired.join(', ')}，但未提供`)
    }
  }
  return checked
}


// ── 包名必须来自宿主已发布的组合 ────────────────────────────────────────────
// 曾经踩过的坑：workflow 行写成了 @deepseek-ai/dsh-workflow-worker-thread，
// 该目录只有 lib/ 没有 package.json，加载器解析不到，挂载时报 "never started"。
// 这里把我们的 @deepseek-ai/* 行名与宿主 standard/base 组合比对。
function auditShippedNames(list, checkoutRoot, problems) {
  const flatten = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) flatten(item, out)
      return out
    }
    if (!node || typeof node !== 'object') return out
    if (typeof node.name === 'string') out.push(node)
    for (const key of ['insert', 'override', 'config', 'group', 'plugins']) {
      if (node[key]) flatten(node[key], out)
    }
    return out
  }

  const shipped = new Set()
  const sources = [
    join(checkoutRoot, 'packages/bundle/web-app/presets/standard.patch.yml'),
    join(checkoutRoot, 'packages/bundle/base/cordis.patch.yml'),
  ]
  let loaded = 0
  for (const file of sources) {
    if (!existsSync(file)) continue
    try {
      for (const row of flatten(yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema }))) {
        shipped.add(row.name)
      }
      loaded += 1
    } catch {
      /* 宿主文件结构变化时跳过 */
    }
  }
  if (!loaded || !shipped.size) {
    problems.push('无法读取宿主已发布的组合，跳过包名白名单比对')
    return 0
  }

  const ours = new Set(flatten(list).map((row) => row.name))
  const unknown = [...ours].filter((name) => name.startsWith('@deepseek-ai/') && !shipped.has(name))
  if (unknown.length) {
    problems.push(`以下包名在宿主已发布的组合中从未出现（很可能写错或不可挂载）：${unknown.join(', ')}`)
  }
  return shipped.size
}

const shippedCount = auditShippedNames(plugins, checkout, problems)
if (shippedCount) console.log(`  宿主已发布行名: ${shippedCount}`)
const audited = auditConfigs(plugins, checkout, problems)
if (audited) console.log(`  config 字段审计: ${audited} 行`)
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
