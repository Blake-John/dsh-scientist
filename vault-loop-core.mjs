// vault-loop-core —— 约定 loop 的状态机与出口校验
//
// 设计见 docs/command-loops-plan.md：
//   · 每个斜杠命令创建一个 loop 记录（research/loops/<id>.json）
//   · 入口契约由命令 handler 保证；出口契约由 closeLoop 逐项校验
//   · 终态：running / closed / failed / stalled / aborted
//   · 惰性超时：读取时若 running 且 24h 无动作 → stalled（不引入定时器）
//
// 校验项是字符串 DSL（命令侧声明，这里执行）：
//   file:<path>                 文件存在
//   glob:<pattern>              至少匹配一个文件（* 通配）
//   contains:<path>:<a>|<b>     文件包含全部子串
//   min-citations:<path>:<n>    文件里不同 citekey 数量 ≥ n
//   bib-entry:<key>             literature/references.bib 有该条目
//   executable:<path>           文件存在且带 shebang 或以 .py 结尾
//   cite-check                  运行 scripts/cite-check.mjs（无错误）
//   cite-check-deep             同上加 --deep
//   reviews-since-open          项目里存在不早于 loop 开启时间的评审记录

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  nowISO,
  readJson,
  slugify,
  vaultErr,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from './vault-core.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export const LOOP_STATES = ['running', 'closed', 'failed', 'stalled', 'aborted']
export const TERMINAL_STATES = ['closed', 'failed', 'aborted']
export const DEFAULT_MAX_NUDGES = 3
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export const loopsDir = (root) => join(root, 'research', 'loops')
const lockPath = (root) => join(root, 'research', 'loops', '.lock')

// ── 读取与惰性超时 ──────────────────────────────────────────────────────────

const isStale = (loop) => {
  if (loop.status !== 'running') return false
  const last = Date.parse(loop.lastActivity ?? loop.openedAt ?? '')
  return Number.isFinite(last) && Date.now() - last > STALE_AFTER_MS
}

/** 读单个 loop；running 且超时则就地降级为 stalled 并落盘 */
export async function readLoop(root, id) {
  const file = withinRoot(root, join('research', 'loops', `${id}.json`))
  const loop = await readJson(file, null)
  if (!loop) throw vaultErr('ERR_NOT_FOUND', `没有 loop ${id}`)
  if (isStale(loop)) {
    loop.status = 'stalled'
    loop.stalledAt = nowISO()
    loop.stallReason = '超过 24h 无动作（惰性判定）'
    await writeJsonAtomic(file, loop)
  }
  return loop
}

/** 列出 loop（默认全部，可按状态过滤），按开启时间倒序 */
export async function listLoops(root, { status } = {}) {
  const dir = loopsDir(root)
  const entries = await readdir(dir).catch(() => [])
  const loops = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    const loop = await readJson(join(dir, entry), null)
    if (!loop) continue
    if (isStale(loop)) {
      loop.status = 'stalled'
      loop.stalledAt = nowISO()
      loop.stallReason = '超过 24h 无动作（惰性判定）'
      await writeJsonAtomic(join(dir, entry), loop)
    }
    if (status && loop.status !== status) continue
    loops.push(loop)
  }
  return loops.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
}

/** 当前进行中的 loop（多个时取最近开启的一个） */
export async function activeLoop(root) {
  const running = await listLoops(root, { status: 'running' })
  return running[0] ?? null
}

// ── 创建与更新 ──────────────────────────────────────────────────────────────

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`
}

export async function createLoop(root, spec) {
  const kind = String(spec.kind ?? '').trim()
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw vaultErr('ERR_BAD_ARGS', `非法的 loop kind：${kind}`)
  const arg = String(spec.arg ?? '').trim()
  const base = `${kind}-${slugify(arg || 'untitled')}-${stamp()}`

  return await withFileLock(lockPath(root), {}, async () => {
    const dir = loopsDir(root)
    let id = base
    let n = 2
    while (existsSync(join(dir, `${id}.json`))) id = `${base}-${n++}`
    const at = nowISO()
    const loop = {
      id,
      kind,
      arg,
      title: spec.title ?? arg,
      autoCreated: Boolean(spec.autoCreated),
      openedAt: at,
      lastActivity: at,
      status: 'running',
      entry: { requires: spec.entryRequires ?? [], done: true },
      work: [],
      exit: {
        requires: spec.requires ?? [],
        checks: spec.checks ?? [],
        workMin: spec.workMin ?? 0,
        done: false,
        lastFailure: null,
      },
      nudges: 0,
      maxNudges: Number.isFinite(spec.maxNudges) ? spec.maxNudges : DEFAULT_MAX_NUDGES,
      closedAt: null,
      failReason: null,
      skill: spec.skill ?? null,
    }
    await writeJsonAtomic(join(dir, `${id}.json`), loop)
    return loop
  })
}

async function mutateLoop(root, id, fn) {
  return await withFileLock(lockPath(root), {}, async () => {
    const file = withinRoot(root, join('research', 'loops', `${id}.json`))
    const loop = await readJson(file, null)
    if (!loop) throw vaultErr('ERR_NOT_FOUND', `没有 loop ${id}`)
    const result = await fn(loop)
    await writeJsonAtomic(file, loop)
    return result ?? loop
  })
}

/** 追加一条工作记录（AI 自由记账），刷新 lastActivity */
export async function noteLoop(root, id, note) {
  const text = String(note ?? '').trim()
  if (!text) throw vaultErr('ERR_BAD_ARGS', 'note 不能为空')
  return await mutateLoop(root, id, (loop) => {
    if (TERMINAL_STATES.includes(loop.status)) {
      throw vaultErr('ERR_LOOP_CLOSED', `loop ${id} 已结束（${loop.status}），不能再记账`)
    }
    loop.work.push({ at: nowISO(), note: text })
    loop.lastActivity = nowISO()
    if (loop.status === 'stalled') {
      loop.status = 'running' // 有动作即复活
      loop.nudges = 0          // 复活后重置拦停预算，否则永远不再拦
    }
    return loop
  })
}

/** 拦停计数 +1；返回更新后的 loop（enforcement 用） */
export async function bumpNudge(root, id) {
  return await mutateLoop(root, id, (loop) => {
    loop.nudges = (loop.nudges ?? 0) + 1
    loop.lastActivity = nowISO()
    return loop
  })
}

/** 拦停超限：置 stalled 并放行（enforcement 用） */
export async function stallLoop(root, id, reason = '拦停次数超限') {
  return await mutateLoop(root, id, (loop) => {
    if (loop.status !== 'running') return loop
    loop.status = 'stalled'
    loop.stalledAt = nowISO()
    loop.stallReason = reason
    return loop
  })
}

export async function abortLoop(root, id, reason = '') {
  return await mutateLoop(root, id, (loop) => {
    if (loop.status === 'closed') throw vaultErr('ERR_LOOP_CLOSED', `loop ${id} 已完成，无需中止`)
    loop.status = 'aborted'
    loop.closedAt = nowISO()
    loop.failReason = reason || '用户中止'
    return loop
  })
}

// ── 出口校验 ────────────────────────────────────────────────────────────────

const CITE_KEY_PATTERNS = [/\[@([^\]]+)\]/g, /\\cite\{([^}]+)\}/g]

async function countCitations(file) {
  const text = await readFile(file, 'utf8')
  const keys = new Set()
  for (const pattern of CITE_KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      for (const raw of match[1].split(/[;,]/)) {
        const key = raw.trim().replace(/^@/, '')
        if (key) keys.add(key)
      }
    }
  }
  return keys.size
}

async function runCiteCheck(root, deep) {
  const script = join(HERE, 'scripts', 'cite-check.mjs')
  if (!existsSync(script)) return { ok: false, message: `找不到 cite-check：${script}` }
  try {
    await run(process.execPath, [script, '--root', root, '--no-network', ...(deep ? ['--deep'] : [])], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n')
    const firstError = out.find((line) => line.includes('✗')) ?? out[out.length - 1] ?? '未知错误'
    return { ok: false, message: `cite-check 未通过：${firstError.trim()}` }
  }
}

/** 执行单条校验；返回 null 表示通过，否则返回失败描述 */
export async function runCheck(root, loop, spec) {
  const [kind, ...rest] = String(spec).split(':')
  const rel = (p) => withinRoot(root, p)

  switch (kind) {
    case 'file': {
      const path = rel(rest.join(':'))
      return (await stat(path).catch(() => null))?.isFile() ? null : `缺产物：${rest.join(':')}`
    }
    case 'glob': {
      const pattern = rest.join(':')
      const dir = rel(pattern.split('*')[0].includes('/') ? pattern.slice(0, pattern.lastIndexOf('/')) || '.' : '.')
      const entries = await readdir(dir).catch(() => [])
      const re = new RegExp(`^${basename(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      return entries.some((e) => re.test(e)) ? null : `没有匹配 ${pattern} 的文件`
    }
    case 'contains': {
      const [path, labels] = [rest[0], rest.slice(1).join(':')]
      const text = await readFile(rel(path), 'utf8').catch(() => null)
      if (text === null) return `缺产物：${path}`
      const missing = labels.split('|').filter((label) => !text.includes(label))
      return missing.length ? `${path} 缺少：${missing.join('、')}` : null
    }
    case 'min-citations': {
      const [path, n] = [rest[0], Number(rest[1])]
      const file = rel(path)
      if (!(await stat(file).catch(() => null))?.isFile()) return `缺产物：${path}`
      const count = await countCitations(file)
      return count >= n ? null : `引用不足：需要 ≥${n} 条，实际 ${count} 条`
    }
    case 'bib-entry': {
      const key = rest.join(':')
      const bib = await readFile(join(root, 'literature', 'references.bib'), 'utf8').catch(() => '')
      return new RegExp(`\\{[\\s]*${key}\\s*,`).test(bib) ? null : `references.bib 里没有条目 ${key}`
    }
    case 'executable': {
      const path = rest.join(':')
      const file = rel(path)
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) return `缺产物：${path}`
      if (path.endsWith('.py') || path.endsWith('.sh')) return null
      const head = (await readFile(file, 'utf8').catch(() => '')).slice(0, 2)
      return head === '#!' ? null : `${path} 既不是脚本也没有 shebang`
    }
    case 'cite-check':
      return (await runCiteCheck(root, false)).ok ? null : (await runCiteCheck(root, false)).message
    case 'cite-check-deep':
      return (await runCiteCheck(root, true)).ok ? null : (await runCiteCheck(root, true)).message
    case 'reviews-since-open': {
      const study = await readJson(join(root, 'research', 'study.json'), null)
      if (!study) return '没有 research/study.json'
      const since = Date.parse(loop.openedAt ?? '')
      const fresh = (study.reviews ?? []).filter((r) => !Number.isFinite(since) || Date.parse(r.createdAt ?? '') >= since)
      return fresh.length ? null : '本次 loop 开始后没有新增评审记录（用 study_review）'
    }
    default:
      return `未知校验项：${spec}`
  }
}

/** 跑完整出口契约 */
export async function verifyExit(root, loop) {
  const failures = []
  for (const spec of loop.exit?.requires ?? []) {
    const failure = await runCheck(root, loop, spec)
    if (failure) failures.push(failure)
  }
  for (const spec of loop.exit?.checks ?? []) {
    const failure = await runCheck(root, loop, spec)
    if (failure) failures.push(failure)
  }
  const workMin = loop.exit?.workMin ?? 0
  if ((loop.work ?? []).length < workMin) {
    failures.push(`work 记录不足：需要 ≥${workMin} 条，实际 ${(loop.work ?? []).length} 条`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * 关闭 loop。
 *   默认：校验全过才 closed，否则抛 ERR_EXIT_UNMET 并记 lastFailure（loop 保持 running）
 *   failed=true：必须给 reason，直接置 failed（诚实失败优于凑数）
 */
export async function closeLoop(root, id, { failed = false, reason = '' } = {}) {
  const loop = await readLoop(root, id)
  if (TERMINAL_STATES.includes(loop.status)) {
    throw vaultErr('ERR_LOOP_CLOSED', `loop ${id} 已结束（${loop.status}）`)
  }

  if (failed) {
    const text = String(reason ?? '').trim()
    if (!text) throw vaultErr('ERR_BAD_ARGS', '声明失败必须给 --reason（说明为什么做不成）')
    return await mutateLoop(root, id, (target) => {
      target.status = 'failed'
      target.closedAt = nowISO()
      target.failReason = text
      target.exit.done = false
      return target
    })
  }

  const { ok, failures } = await verifyExit(root, loop)
  if (!ok) {
    await mutateLoop(root, id, (target) => {
      target.exit.lastFailure = { at: nowISO(), failures }
      target.lastActivity = nowISO()
    })
    throw vaultErr('ERR_EXIT_UNMET', `出口契约未满足（loop 保持 running）：\n  · ${failures.join('\n  · ')}`, { failures })
  }

  return await mutateLoop(root, id, (target) => {
    target.status = 'closed'
    target.closedAt = nowISO()
    target.exit.done = true
    target.exit.lastFailure = null
    return target
  })
}

// ── 展示 ────────────────────────────────────────────────────────────────────

export const LOOP_STATE_LABEL = {
  running: '进行中',
  closed: '已完成',
  failed: '未完成',
  stalled: '卡住',
  aborted: '已中止',
}

export function renderLoop(loop) {
  const lines = [
    `${loop.id}  [${LOOP_STATE_LABEL[loop.status] ?? loop.status}]`,
    `  类型 ${loop.kind} · 参数 ${loop.arg || '（无）'}`,
    `  开启 ${loop.openedAt} · 最近动作 ${loop.lastActivity}`,
  ]
  if (loop.work?.length) {
    lines.push(`  工作记录 ${loop.work.length} 条：`)
    for (const item of loop.work.slice(-3)) lines.push(`    ${item.at?.slice(11, 16)} ${item.note}`)
  }
  const remaining = loop.exit?.lastFailure?.failures ?? []
  if (loop.status === 'running' && remaining.length) {
    lines.push('  待补：')
    for (const item of remaining) lines.push(`    · ${item}`)
  }
  if (loop.failReason) lines.push(`  原因：${loop.failReason}`)
  if (loop.nudges) lines.push(`  已拦停 ${loop.nudges}/${loop.maxNudges} 次`)
  return lines.join('\n')
}
