// science-skills —— 把本包 `skills/` 目录注册成 preset 作用域内的技能 provider。
//
// 为什么需要这个插件：加载器的 `!!js` 求值环境是
//   new Function("ctx", "expr", "with (ctx) { return eval(expr) }")
// 里面没有 require / import.meta，因此 `skill-filesystem.customSkillDirs` 拼不出
// "包内 skills 目录"的绝对路径。插件用 import.meta.url 定位自己，就绕开了这个问题，
// 也让 preset 不必依赖 ~/.dsh 的具体布局。
//
// 零第三方依赖：只用 node 内置模块。
//
// rank 600 = BUNDLED_SKILL_RANK：项目级（100/200）与用户级（400/500）技能优先于本包，
// 便于用户在项目里覆盖同名的包内技能。

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-scientist-skills'
export const inject = ['skills']

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills')
const PROVIDER = 'scientist-skills'
const RANK = 600
const SOURCE = 'bundled'

/** 解析 frontmatter：只支持本包技能用到的子集（标量、引号、`|`/`>` 块）。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    let value = kv[2]
    // 块标量：`|` `|-` `>` `>-`
    if (/^[|>][-+]?$/.test(value.trim())) {
      const folded = value.trim().startsWith('>')
      const block = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1
        block.push(lines[i].replace(/^\s{1,4}/, ''))
      }
      value = folded ? block.join(' ').trim() : block.join('\n').trim()
    } else {
      value = value.trim().replace(/^['"]|['"]$/g, '')
    }
    meta[key] = value
  }
  return { meta, body: text.slice(match[0].length) }
}

const bool = (value, fallback) => {
  if (value === undefined) return fallback
  const normalized = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return fallback
}

const invocationOf = (meta) => ({
  modelInvocable: !bool(meta['disable-model-invocation'], false),
  userInvocable: bool(meta['user-invocable'], true),
})

export function apply(ctx) {
  const provider = {
    name: PROVIDER,

    async list() {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => [])
      const candidates = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const file = join(SKILLS_DIR, entry.name, 'SKILL.md')
        let text
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        const { meta } = parseFrontmatter(text)
        if (!meta.name || !meta.description) continue
        candidates.push({
          name: meta.name,
          description: meta.description,
          ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
          invocation: invocationOf(meta),
          source: SOURCE,
          provider: PROVIDER,
          rank: RANK,
          path: file,
          resourceBase: { kind: 'directory', path: dirname(file) },
          locator: file,
        })
      }
      return { candidates, complete: true }
    },

    async get(candidate) {
      const file = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.path
      if (!file) return undefined
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return undefined
      }
      const { meta, body } = parseFrontmatter(text)
      return {
        name: meta.name ?? candidate.name,
        description: meta.description ?? candidate.description,
        ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
        invocation: invocationOf(meta),
        source: SOURCE,
        provider: PROVIDER,
        path: file,
        resourceBase: { kind: 'directory', path: dirname(file) },
        content: body,
      }
    },
  }

  ctx.skills.registerProvider(() => provider)
}
