#!/usr/bin/env node
/**
 * test-vault-core —— vault-core 的单测（全离线，用临时目录）
 *
 * 覆盖：slugify / resolveRoot / withinRoot / 原子写 / jsonl / 文件锁（互斥、陈旧锁、超时）
 *       / 流式哈希 / 硬链接去重 / 忽略规则 / 目录遍历（跳过符号链接、上限、去重）
 */
import { mkdir, readFile, readdir, stat, symlink, utimes, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendJsonl,
  DEFAULT_IGNORE_NAMES,
  hashFileStreaming,
  hashText,
  humanBytes,
  isIgnoredPath,
  linkOrCopy,
  nowISO,
  optInt,
  optStr,
  readJson,
  requireStr,
  resolveRoot,
  shortHash,
  slugify,
  VaultError,
  vaultErr,
  walkSources,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from '../vault-core.mjs'

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}
const expectCode = async (fn, code, label) => {
  try {
    await fn()
    problems.push(`${label}: 没有抛错`)
  } catch (error) {
    ok(error instanceof VaultError, `${label}: 抛的不是 VaultError`)
    ok(error.code === code, `${label}: code=${error.code}，期望 ${code}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'vault-core-'))

try {
  // ── 1. slugify ────────────────────────────────────────────────────────────
  ok(slugify('Loss Curve v2!') === 'loss-curve-v2', `slugify: ${slugify('Loss Curve v2!')}`)
  ok(slugify('  ') === 'item', 'slugify 兜底')
  ok(slugify('a--b') === 'a-b', 'slugify 折叠连字符')

  // ── 2. resolveRoot / withinRoot ───────────────────────────────────────────
  const proj = join(dir, 'proj')
  await mkdir(join(proj, 'research'), { recursive: true })
  ok((await resolveRoot(proj)) === proj, 'resolveRoot 显式路径')
  await expectCode(() => resolveRoot(join(dir, 'nope')), 'ERR_BAD_ROOT', 'resolveRoot 非法路径')
  ok(withinRoot(proj, 'research/x.json').startsWith(proj), 'withinRoot 正常')
  await expectCode(() => withinRoot(proj, '../escape'), 'ERR_OUTSIDE_ROOT', 'withinRoot 拒绝穿越')

  // ── 3. JSON 读写 ──────────────────────────────────────────────────────────
  const jf = join(proj, 'research', 'a.json')
  ok((await readJson(jf, { d: 1 })).d === 1, 'readJson 缺失用 fallback')
  await expectCode(() => readJson(jf), 'ERR_NOT_FOUND', 'readJson 缺失无 fallback')
  await writeJsonAtomic(jf, { hello: '世界', n: [1, 2] })
  ok((await readJson(jf)).hello === '世界', 'writeJsonAtomic 往返')
  const leftovers = (await readdir(join(proj, 'research'))).filter((f) => f.includes('.tmp'))
  ok(leftovers.length === 0, `原子写不留临时文件：${leftovers}`)
  await writeFile(jf, '{ broken')
  await expectCode(() => readJson(jf), 'ERR_BAD_JSON', 'readJson 坏 JSON')

  const jl = join(proj, 'research', 'events.jsonl')
  await appendJsonl(jl, { kind: 'a' })
  await appendJsonl(jl, { kind: 'b' })
  const lines = (await readFile(jl, 'utf8')).trim().split('\n')
  ok(lines.length === 2, `jsonl 追加：${lines.length} 行`)
  ok(JSON.parse(lines[1]).kind === 'b', 'jsonl 内容')

  // ── 4. 文件锁 ─────────────────────────────────────────────────────────────
  const lock = join(proj, 'research', '.lock')
  const counter = join(proj, 'research', 'counter.txt')
  await writeFile(counter, '0')
  // 20 个并发任务做 read-modify-write，无锁必然丢更新
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withFileLock(lock, {}, async () => {
        const n = Number(await readFile(counter, 'utf8'))
        await new Promise((r) => setTimeout(r, 2))
        await writeFile(counter, String(n + 1))
      }),
    ),
  )
  ok(Number(await readFile(counter, 'utf8')) === 20, `文件锁互斥：计数=${await readFile(counter, 'utf8')}，期望 20`)
  ok(!(await stat(lock).catch(() => null)), '锁使用后释放')

  // 陈旧锁可被回收
  await writeFile(lock, '{}')
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  let reclaimed = false
  await withFileLock(lock, { staleMs: 1000, timeoutMs: 2000 }, async () => {
    reclaimed = true
  })
  ok(reclaimed, '陈旧锁被回收')

  // 未过期的锁 → 超时
  await writeFile(lock, '{}')
  await expectCode(() => withFileLock(lock, { timeoutMs: 150, staleMs: 60_000 }, async () => {}), 'ERR_LOCK_TIMEOUT', '锁超时')
  await rm(lock, { force: true })

  // 异常时也释放锁
  await withFileLock(lock, {}, async () => {
    throw new Error('boom')
  }).catch(() => {})
  ok(!(await stat(lock).catch(() => null)), '异常路径释放锁')

  // ── 5. 哈希 ───────────────────────────────────────────────────────────────
  const hf = join(dir, 'hello.txt')
  await writeFile(hf, 'hello')
  ok(
    (await hashFileStreaming(hf)) === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    '流式哈希与已知值一致',
  )
  ok(hashText('hello') === (await hashFileStreaming(hf)), 'hashText 与 hashFileStreaming 一致')

  // 大文件（8 MB）也走流式
  const big = join(dir, 'big.bin')
  await writeFile(big, Buffer.alloc(8 * 1024 * 1024, 7))
  const bigHash = await hashFileStreaming(big)
  ok(/^[0-9a-f]{64}$/.test(bigHash), '大文件哈希格式正确')

  // ── 6. 硬链接去重 ─────────────────────────────────────────────────────────
  const src = join(dir, 'src.txt')
  await writeFile(src, 'dedupe me')
  const dst = join(dir, 'nested', 'dst.txt')
  const mode = await linkOrCopy(src, dst)
  ok(mode === 'hardlink', `同设备应硬链接，实际 ${mode}`)
  ok((await stat(src)).ino === (await stat(dst)).ino, '硬链接共享 inode')
  ok((await readFile(dst, 'utf8')) === 'dedupe me', '硬链接内容可读')
  // 目标已存在时不应抛错
  const again = await linkOrCopy(src, dst)
  ok(again === 'hardlink' || again === 'copy', '重复落盘不抛错')

  // ── 7. 忽略规则 ───────────────────────────────────────────────────────────
  ok(DEFAULT_IGNORE_NAMES.has('node_modules'), '默认忽略含 node_modules')
  ok(isIgnoredPath('a/node_modules/b.js'), '嵌套 node_modules 被忽略')
  ok(isIgnoredPath('x.pyc'), '后缀规则生效')
  ok(!isIgnoredPath('src/main.py'), '正常文件不忽略')
  ok(isIgnoredPath('drafts/old.txt', { excludes: ['drafts'] }), 'excludes 目录规则')
  ok(isIgnoredPath('data/tmp.csv', { excludes: ['*.csv'] }), 'excludes 通配规则')

  // ── 8. 目录遍历 ───────────────────────────────────────────────────────────
  const tree = join(dir, 'tree')
  await mkdir(join(tree, 'src'), { recursive: true })
  await mkdir(join(tree, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(tree, '.git'), { recursive: true })
  await writeFile(join(tree, 'src', 'main.py'), 'print(1)')
  await writeFile(join(tree, 'src', 'util.py'), 'x = 1')
  await writeFile(join(tree, 'node_modules', 'pkg', 'index.js'), 'module.exports=1')
  await writeFile(join(tree, '.git', 'HEAD'), 'ref: main')
  await writeFile(join(tree, 'cache.pyc'), 'binary')
  await writeFile(join(tree, 'outside.txt'), 'ok')
  await symlink('/etc/hostname', join(tree, 'link-out'))

  const walked = await walkSources([tree])
  const rels = walked.files.map((f) => f.relPath).sort()
  ok(rels.includes('src/main.py') && rels.includes('src/util.py'), `应含源码：${rels}`)
  ok(!rels.some((r) => r.includes('node_modules')), 'node_modules 被跳过')
  ok(!rels.some((r) => r.startsWith('.git')), '.git 被跳过')
  ok(!rels.some((r) => r.endsWith('.pyc')), '.pyc 被跳过')
  ok(!rels.includes('link-out'), '符号链接不跟随')
  ok(walked.skipped.some((s) => s.reason === 'symbolic-link'), '符号链接被报告')
  ok(walked.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), '每个文件都有 sha256')

  // 单文件上限
  const capped = await walkSources([big], { maxFileBytes: 1024 })
  ok(capped.files.length === 0 && capped.skipped.some((s) => s.reason.includes('上限')), '单文件上限生效')

  // 同一文件被传两次 → 去重
  const dup = await walkSources([join(tree, 'outside.txt'), join(tree, 'outside.txt')])
  ok(dup.files.length === 1, `重复输入去重，实际 ${dup.files.length}`)
  ok(dup.skipped.some((s) => s.reason === 'duplicate-input'), '重复输入被报告')

  // 不存在的输入
  const missing = await walkSources([join(dir, 'ghost')])
  ok(missing.files.length === 0 && missing.skipped[0]?.reason === 'not-found', '缺失输入被报告')

  // ── 9. 参数与格式化小工具 ─────────────────────────────────────────────────
  ok(optStr({ a: '  x ' }, 'a') === 'x', 'optStr 去空白')
  ok(optStr({}, 'a', 'd') === 'd', 'optStr 兜底')
  await expectCode(async () => requireStr({}, 'a'), 'ERR_BAD_ARGS', 'requireStr 缺参数')
  ok(optInt({ n: '5' }, 'n') === 5, 'optInt 转换')
  await expectCode(async () => optInt({ n: 'abc' }, 'n'), 'ERR_BAD_ARGS', 'optInt 非法')
  ok(humanBytes(0) === '0 B', 'humanBytes 0')
  ok(humanBytes(1536) === '1.5 KiB', `humanBytes 1536 = ${humanBytes(1536)}`)
  ok(shortHash('abcdef1234567890', 6) === 'abcdef', 'shortHash')
  ok(/^\d{4}-\d{2}-\d{2}T/.test(nowISO()), 'nowISO 格式')
  ok(vaultErr('ERR_X', 'm') instanceof VaultError, 'vaultErr 返回 VaultError')
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-core 单测通过（锁 / 原子写 / 哈希 / 硬链接 / 遍历 / 忽略规则）')
