// vault-core —— 科研记录（research record）的共享底座，零第三方依赖
//
// 供 vault-record / vault-study 两组工具共用：
//   · 文件锁（跨进程串行化，带超时与陈旧锁回收）
//   · 原子写（临时文件 + rename，不会留半截 JSON）
//   · 流式 SHA-256（大文件不吃内存）
//   · 硬链接去重（跨设备自动降级为复制并报告）
//   · 带默认忽略集的目录遍历（跳过符号链接并记录）
//
// 设计依据见 docs/research-record-plan.md：
//   Sandve 2013 R1/R3（怎么产生、程序版本）、RO-Crate CreateAction（成败/耗时）、
//   Schnell 2015 R9（索引）、FAIR F1（持久标识）。

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat, lstat, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export class VaultError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    Object.assign(this, extra)
  }
}

export const vaultErr = (code, message, extra) => new VaultError(code, message, extra)

export const nowISO = () => new Date().toISOString()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 标识与路径 ──────────────────────────────────────────────────────────────

/** 工件名 → 目录名：小写、只留字母数字与 -_.，其余折叠为 - */
export function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug || fallback
}

/** 项目根：向上找含这些标记的目录 */
const ROOT_MARKERS = ['research', 'literature', 'artifacts', '.dsh', '.git']

export async function resolveRoot(explicit) {
  if (explicit) {
    const abs = resolve(explicit)
    const info = await stat(abs).catch(() => null)
    if (!info?.isDirectory()) throw vaultErr('ERR_BAD_ROOT', `项目根不是目录：${abs}`)
    return abs
  }
  let dir = resolve(process.cwd())
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      const hit = await stat(join(dir, marker)).catch(() => null)
      if (hit) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return resolve(process.cwd())
    dir = parent
  }
}

/** 防目录穿越：确认 child 落在 root 内 */
export function withinRoot(root, child) {
  const absRoot = resolve(root)
  const abs = resolve(absRoot, child)
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw vaultErr('ERR_OUTSIDE_ROOT', `路径越出项目根：${child}`)
  }
  return abs
}

// ── JSON 读写 ───────────────────────────────────────────────────────────────

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (fallback !== undefined && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback
    if (error.code === 'ENOENT') throw vaultErr('ERR_NOT_FOUND', `文件不存在：${file}`)
    if (error instanceof SyntaxError) throw vaultErr('ERR_BAD_JSON', `JSON 解析失败：${file}（${error.message}）`)
    throw error
  }
}

/** 原子写：先写临时文件再 rename，进程被杀也不会留下半截内容 */
export async function writeJsonAtomic(file, value, { indent = 2 } = {}) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, indent)}\n`, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** append-only 事件流：一行一条，便于 tail / grep，也不会被原子写打断 */
export async function appendJsonl(file, entry) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ at: nowISO(), ...entry })}\n`, { flag: 'a' })
}

// ── 文件锁 ──────────────────────────────────────────────────────────────────

/** 进程是否还活着（EPERM 说明存在但无权限，也算活着） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' ? true : false
  }
}

/**
 * 跨进程串行化。用 O_EXCL 创建锁文件。
 *
 * 两个关键点（都曾出错，见 docs/research-record-plan.md「实施中发现并修正的实现缺陷」）：
 *   1. **持锁期间心跳续期**：长任务（大目录复制）的锁若只靠创建时间判断，超过 staleMs
 *      就会被别人当成陈旧锁抢走 → 两个写者同时改 manifest/index。心跳让 mtime 始终新鲜。
 *   2. **抢锁前看 PID 是否还活着**：进程崩溃留下的锁可以立即回收，不用干等 staleMs。
 */
export async function withFileLock(lockPath, { timeoutMs = 10000, staleMs = 30000 } = {}, fn) {
  const started = Date.now()
  const beatMs = Math.max(50, Math.floor(staleMs / 3))
  await mkdir(dirname(lockPath), { recursive: true })
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowISO() }))
      await handle.close()
      handle = null
      // 心跳：持锁期间不断刷新 mtime，避免被误判为陈旧
      const beat = setInterval(() => {
        const now = new Date()
        utimes(lockPath, now, now).catch(() => {})
      }, beatMs)
      beat.unref?.()
      try {
        return await fn()
      } finally {
        clearInterval(beat)
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => null)
      if (info) {
        const holder = await readFile(lockPath, 'utf8')
          .then((text) => JSON.parse(text))
          .catch(() => null)
        const alive = pidAlive(holder?.pid)
        const expired = Date.now() - info.mtimeMs > staleMs
        // 持锁进程已死 → 立即回收；否则只有确认过期（心跳已停）才抢
        if (alive === false || expired) {
          await rm(lockPath, { force: true })
          continue
        }
      }
      if (Date.now() - started > timeoutMs) {
        throw vaultErr('ERR_LOCK_TIMEOUT', `等待文件锁超时（${timeoutMs}ms）：${lockPath}`)
      }
      await sleep(20 + Math.floor(Math.random() * 40))
    }
  }
}

// ── 哈希 ────────────────────────────────────────────────────────────────────

/** 流式 SHA-256：8 GiB 的文件也只占常量内存 */
export async function hashFileStreaming(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export const hashText = (text) => createHash('sha256').update(text).digest('hex')

// ── 去重落盘 ────────────────────────────────────────────────────────────────

/**
 * 硬链接去重：同设备直接 link（省空间、瞬时），跨设备降级为复制。
 * 返回值告诉调用方实际用了哪种，便于在结果里如实报告。
 */
export async function linkOrCopy(src, dest) {
  await mkdir(dirname(dest), { recursive: true })
  try {
    await link(src, dest)
    return 'hardlink'
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EMLINK', 'EEXIST'].includes(error.code)) throw error
    if (error.code === 'EEXIST') await unlink(dest)
    await copyFile(src, dest)
    return 'copy'
  }
}

// ── 目录遍历 ────────────────────────────────────────────────────────────────

/** 默认忽略：版本控制、依赖、缓存、构建产物、以及本工具自己的运行目录 */
export const DEFAULT_IGNORE_NAMES = new Set([
  '.git', '.hg', '.svn', '.jj',
  'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.ipynb_checkpoints', 'dist', 'build', 'target',
  '.DS_Store', 'Thumbs.db',
  '.lit-cache', '.pdf-render', '.pdf-assets',
])

export const DEFAULT_IGNORE_SUFFIXES = ['.pyc', '.pyo', '.swp', '.tmp', '.part']

export function isIgnoredPath(relPath, { ignoreNames, ignoreSuffixes, excludes = [] } = {}) {
  const parts = String(relPath).split(/[\\/]+/)
  for (const part of parts) {
    if ((ignoreNames ?? DEFAULT_IGNORE_NAMES).has(part)) return true
  }
  const base = parts[parts.length - 1] ?? ''
  for (const suffix of ignoreSuffixes ?? DEFAULT_IGNORE_SUFFIXES) {
    if (base.endsWith(suffix)) return true
  }
  for (const rule of excludes) {
    if (!rule) continue
    if (rule.includes('*')) {
      const re = new RegExp(`^${rule.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      if (re.test(base) || re.test(relPath)) return true
    } else if (base === rule || relPath === rule || relPath.startsWith(`${rule}/`)) {
      return true
    }
  }
  return false
}

/**
 * 遍历 sources 并返回文件清单。
 * 符号链接默认跳过并单独报告（不跟随：避免把项目外的文件卷进来或撞上循环）。
 */
export async function walkSources(inputs, options = {}) {
  const { maxFileBytes = 8 * 1024 ** 3, followSymlinks = false, excludes = [] } = options
  const files = []
  const skipped = []
  const seenPaths = new Set()

  const visit = async (absPath, baseDir, shownPath) => {
    let info
    try {
      info = await lstat(absPath)
    } catch (error) {
      skipped.push({ path: shownPath, reason: `lstat 失败：${error.code}` })
      return
    }
    if (info.isSymbolicLink()) {
      skipped.push({ path: shownPath, reason: 'symbolic-link' })
      if (!followSymlinks) return
      info = await stat(absPath).catch(() => null)
      if (!info) {
        skipped.push({ path: shownPath, reason: 'broken-symbolic-link' })
        return
      }
    }
    const relToBase = baseDir ? relative(baseDir, absPath).split(sep).join('/') : shownPath
    if (isIgnoredPath(relToBase, { excludes })) {
      skipped.push({ path: shownPath, reason: 'ignored' })
      return
    }
    if (info.isDirectory()) {
      const entries = await readdir(absPath).catch(() => [])
      for (const entry of entries.sort()) {
        await visit(join(absPath, entry), baseDir, `${shownPath}/${entry}`)
      }
      return
    }
    if (!info.isFile()) {
      skipped.push({ path: shownPath, reason: 'not-a-regular-file' })
      return
    }
    if (info.size > maxFileBytes) {
      skipped.push({ path: shownPath, reason: `超过单文件上限（${info.size} > ${maxFileBytes}）` })
      return
    }
    const real = resolve(absPath)
    if (seenPaths.has(real)) {
      skipped.push({ path: shownPath, reason: 'duplicate-input' })
      return
    }
    seenPaths.add(real)
    files.push({
      shownPath,
      absPath: real,
      relPath: relToBase,
      bytes: info.size,
      sha256: await hashFileStreaming(real),
    })
  }

  for (const input of inputs) {
    const abs = resolve(input)
    const info = await lstat(abs).catch(() => null)
    if (!info) {
      skipped.push({ path: input, reason: 'not-found' })
      continue
    }
    const baseDir = info.isDirectory() ? abs : dirname(abs)
    await visit(abs, baseDir, info.isDirectory() ? input.replace(/\/+$/, '') : input)
  }

  return { files, skipped }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

export const optStr = (args, key, fallback = '') =>
  typeof args?.[key] === 'string' && args[key].trim() ? args[key].trim() : fallback

export const requireStr = (args, key) => {
  const value = typeof args?.[key] === 'string' ? args[key].trim() : ''
  if (!value) throw vaultErr('ERR_BAD_ARGS', `缺少必填参数 ${key}`)
  return value
}

export const optInt = (args, key) => {
  const raw = args?.[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw vaultErr('ERR_BAD_ARGS', `${key} 必须是数字，收到 ${JSON.stringify(raw)}`)
  return value
}

/** 字节数 → 人类可读 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 短哈希，用于展示 */
export const shortHash = (hex, n = 8) => (typeof hex === 'string' ? hex.slice(0, n) : '—')
