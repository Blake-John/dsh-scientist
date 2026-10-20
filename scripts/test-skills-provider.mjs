#!/usr/bin/env node
/**
 * test-skills-provider — 不启动 harness，直接验证 skills-provider.mjs。
 *
 * 用一个假的 ctx 捕获 registerProvider 的工厂，然后断言：
 *   · 14 个候选、name 与目录名一致、description 非空
 *   · rank=600 / source=bundled / resourceBase 指向各自目录
 *   · get() 能取回正文，且正文不含 frontmatter
 *   · frontmatter 解析器处理标量、引号与 `>` 折行块
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, parseFrontmatter } from '../skills-provider.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const skillsDir = join(ROOT, 'skills')

const problems = []
const fail = (msg) => problems.push(msg)

// —— frontmatter 解析器单测 ——
{
  const sample = ['---', 'name: demo', 'description: >-', '  第一行', '  第二行', 'whenToUse: "带引号"', '---', '', '# 标题', '正文'].join('\n')
  const { meta, body } = parseFrontmatter(sample)
  if (meta.name !== 'demo') fail(`parse: name=${meta.name}`)
  if (meta.description !== '第一行 第二行') fail(`parse: description=${JSON.stringify(meta.description)}`)
  if (meta.whenToUse !== '带引号') fail(`parse: whenToUse=${meta.whenToUse}`)
  if (body.trim() !== '# 标题\n正文') fail(`parse: body=${JSON.stringify(body)}`)
}

// —— provider 端到端 ——
let provider
const ctx = {
  skills: {
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate() {} })
      return () => {}
    },
  },
}
apply(ctx)
if (!provider) {
  fail('apply() 没有注册 provider')
} else {
  const observation = await provider.list({})
  const candidates = Array.isArray(observation) ? observation : observation.candidates
  const dirs = (await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)

  if (candidates.length !== dirs.length) fail(`候选 ${candidates.length} != 目录 ${dirs.length}`)
  for (const dir of dirs) {
    if (!candidates.some((c) => c.name === dir)) fail(`缺少候选: ${dir}`)
  }
  for (const candidate of candidates) {
    if (!candidate.description) fail(`${candidate.name}: description 为空`)
    if (candidate.rank !== 600) fail(`${candidate.name}: rank=${candidate.rank}`)
    if (candidate.source !== 'bundled') fail(`${candidate.name}: source=${candidate.source}`)
    if (candidate.resourceBase?.kind !== 'directory') fail(`${candidate.name}: resourceBase 缺失`)
    if (candidate.invocation?.modelInvocable !== true) fail(`${candidate.name}: modelInvocable 应为 true`)
  }

  const sample = candidates[0]
  const definition = await provider.get(sample, {})
  if (!definition) fail(`get(${sample.name}) 返回 undefined`)
  else {
    if (!definition.content || definition.content.length < 200) fail(`get(${sample.name}): 正文过短`)
    if (definition.content.startsWith('---')) fail(`get(${sample.name}): 正文仍含 frontmatter`)
  }
  console.log(`provider: ${provider.name}`)
  console.log(`  candidates: ${candidates.length}`)
  console.log(`  sample: ${sample.name} (${definition?.content?.length ?? 0} 字符正文)`)
}

if (problems.length) {
  console.error('\n✗ ' + problems.join('\n✗ '))
  process.exit(1)
}
console.log('\n✓ skills-provider 通过（frontmatter 解析 + 候选 + 正文加载）')
