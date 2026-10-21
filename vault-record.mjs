// vault-record —— 工件与运行记录（3 个工具）
//
//   record_save       保存工件 / 登记一次运行：内容哈希 + 成败 + 耗时 + 种子 + 环境 + 关联
//   record_verify     校验：哈希、缺失、**多余文件**、env 漂移、种子缺失
//   record_reproduce  复现指引：命令 + 输入预检（哈希是否还一致）
//
// 与 dsh-science 的 artifact-* 的差别（见 docs/research-record-plan.md §5）：
//   · 记录执行成败与耗时（PROV actionStatus / Sandve R1）
//   · 记录随机种子并在缺失时告警（Sandve R6）
//   · verify 检测版本目录里多出来的文件
//   · 记录图的原始数据（Sandve R7）
//   · 与假设/实验/文献 citekey 建立链接（Sandve R9 / FAIR F1）
//
// 存储（硬链接去重，不做 blob store）：
//   research/records/<slug>/v<N>/files/…   版本快照（副本或到既有同内容文件的硬链接）
//   research/records/<slug>/v<N>/manifest.json
//   research/records/<slug>/provenance.jsonl
//   research/records/by-hash.json           哈希 → 已存文件，跨版本/跨工件去重
//   research/records/index.json
//
// 关键约定：**绝不对用户工作区的文件做硬链接**——那会让原文件被改动时污染工件。
// 同内容只在库内部之间去重。

import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  appendJsonl,
  DEFAULT_IGNORE_NAMES,
  hashFileStreaming,
  humanBytes,
  linkOrCopy,
  nowISO,
  optInt,
  optStr,
  readJson,
  requireStr,
  resolveRoot,
  shortHash,
  slugify,
  vaultErr,
  walkSources,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from './vault-core.mjs'
import { renderIndex } from './vault-study.mjs'

export const name = 'dsh-scientist-vault-record'
export const inject = ['tools']

const run = promisify(execFile)

const RECORDS = 'research/records'
const LOCK = 'research/.lock'
const MAX_FILE_BYTES = 8 * 1024 ** 3

const tool = ({ name, description, parameters, presentTitle, execute, outputSchema }) => ({
  name,
  description,
  parameters,
  output: {
    schema: outputSchema ?? { type: 'string' },
    render: (_args, value) =>
      typeof value === 'string' ? [{ type: 'text', text: value }] : [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    return await execute(args ?? {}, exec)
  },
  presentCall: (args) => ({ card: 'generic', title: presentTitle, kind: 'other', rawInput: args }),
})

// ── 执行上下文采集（PROV：谁在哪以什么版本跑的）──────────────────────────────

async function captureRuntime() {
  const read = async (cmd, args) => {
    try {
      const { stdout } = await run(cmd, args, { timeout: 5000 })
      return String(stdout).trim().split('\n')[0] || undefined
    } catch {
      return undefined
    }
  }
  return {
    node: process.version,
    python: await read('python3', ['--version']),
    platform: `${process.platform}-${process.arch}`,
    host: (await read('hostname', [])) ?? undefined,
  }
}

async function captureGitCommit(root) {
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })
    return String(stdout).trim() || undefined
  } catch {
    return undefined
  }
}

// ── 索引与去重表 ────────────────────────────────────────────────────────────

const paths = (root) => ({
  recordsDir: join(root, RECORDS),
  index: join(root, RECORDS, 'index.json'),
  byHash: join(root, RECORDS, 'by-hash.json'),
  lock: join(root, LOCK),
  study: join(root, 'research', 'study.json'),
})

const artifactDir = (root, slug) => withinRoot(root, join(RECORDS, slug))

async function readIndex(root) {
  const index = await readJson(paths(root).index, { records: [] })
  index.records = Array.isArray(index.records) ? index.records : []
  return index
}

async function nextVersion(root, slug) {
  const dir = artifactDir(root, slug)
  const manifest = await readJson(join(dir, 'artifact-manifest.json'), null)
  if (manifest?.versions?.length) return Math.max(...manifest.versions.map((v) => v.version)) + 1
  const entries = await readdir(dir).catch(() => [])
  const versions = entries.filter((e) => /^v\d+$/.test(e)).map((e) => Number(e.slice(1)))
  return (versions.length ? Math.max(...versions) : 0) + 1
}

/** 相对 records/ 的路径，用于 by-hash 索引 */
const relToRecords = (root, abs) => relative(paths(root).recordsDir, abs).split(sep).join('/')

// ── 工具 1：record_save ─────────────────────────────────────────────────────

async function cmdSave(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const displayName = requireStr(args, 'name')
  const slug = slugify(displayName)
  const sources = Array.isArray(args.sources) ? args.sources.filter((s) => typeof s === 'string' && s.trim()) : []
  if (!sources.length) throw vaultErr('ERR_BAD_ARGS', 'sources 至少给一个文件或目录')

  const absSources = sources.map((s) => withinRoot(root, s))
  // 逐源遍历：需要知道每个文件来自哪个源，才能在「不同源含同名文件」时避免互相覆盖
  const walk = { files: [], skipped: [] }
  for (const [index, abs] of absSources.entries()) {
    const one = await walkSources([abs], { maxFileBytes: MAX_FILE_BYTES })
    const sourceTag = basename(abs) || `source${index + 1}`
    for (const file of one.files) walk.files.push({ ...file, sourceTag })
    walk.skipped.push(...one.skipped)
  }
  // 冲突消解：同一路径且内容不同 → 加源名前缀，绝不让后一个静默覆盖前一个
  const usedDest = new Map()
  for (const file of walk.files) {
    let dest = file.relPath
    if (usedDest.has(dest) && usedDest.get(dest) !== file.sha256) {
      dest = `${file.sourceTag}/${file.relPath}`
      let n = 1
      while (usedDest.has(dest) && usedDest.get(dest) !== file.sha256) {
        dest = `${file.sourceTag}-${n}/${file.relPath}`
        n += 1
      }
      file.renamedFrom = file.relPath
    }
    usedDest.set(dest, file.sha256)
    file.destPath = dest
  }
  if (!walk.files.length) {
    throw vaultErr('ERR_NO_FILES', `没有可保存的文件（跳过 ${walk.skipped.length} 项，例如：${walk.skipped
      .slice(0, 3)
      .map((s) => `${s.path}:${s.reason}`)
      .join('; ')}）`)
  }

  // 溯源入参
  const command = optStr(args, 'command')
  const exitCode = optInt(args, 'exitCode')
  const durationMs = optInt(args, 'durationMs')
  const seed = optInt(args, 'seed') === undefined ? args.seed : optInt(args, 'seed')
  const kind = optStr(args, 'kind', 'data')
  const envPath = optStr(args, 'env')

  const runtime = await captureRuntime()
  const gitCommit = await captureGitCommit(root)

  return await withFileLock(paths(root).lock, {}, async () => {
    const version = await nextVersion(root, slug)
    const vdir = join(artifactDir(root, slug), `v${version}`)
    const filesDir = join(vdir, 'files')
    await mkdir(filesDir, { recursive: true })

    // 去重：同内容只在库内部硬链接
    const byHash = await readJson(paths(root).byHash, {})
    const stored = []
    for (const file of walk.files) {
      const dest = join(filesDir, file.destPath)
      await mkdir(dirname(dest), { recursive: true })
      const known = byHash[file.sha256]
      const knownAbs = known ? join(paths(root).recordsDir, known) : null
      const knownOk = knownAbs ? (await stat(knownAbs).catch(() => null))?.isFile() : false
      let mode
      if (knownOk) {
        mode = await linkOrCopy(knownAbs, dest)
      } else {
        await copyFile(file.absPath, dest)
        mode = 'copy'
        byHash[file.sha256] = relToRecords(root, dest)
      }
      stored.push({
        path: file.destPath, // 版本目录内的相对路径（冲突时已加源名前缀）
        renamedFrom: file.renamedFrom,
        sourcePath: relative(root, file.absPath).split(sep).join('/'), // 相对项目根，供复现时回查
        sha256: file.sha256,
        bytes: file.bytes,
        stored: mode,
      })
    }

    // env 文件
    let env = null
    if (envPath) {
      const envAbs = withinRoot(root, envPath)
      const info = await stat(envAbs).catch(() => null)
      if (!info?.isFile()) throw vaultErr('ERR_NOT_FOUND', `env 文件不存在：${envPath}`)
      env = { file: envPath, sha256: await hashFileStreaming(envAbs), bytes: info.size }
    }

    // 图的原始数据（Sandve R7）
    let raw = []
    if (Array.isArray(args.raw) && args.raw.length) {
      const rawWalk = await walkSources(
        args.raw.filter((r) => typeof r === 'string' && r.trim()).map((r) => withinRoot(root, r)),
        { maxFileBytes: MAX_FILE_BYTES },
      )
      raw = rawWalk.files.map((f) => ({
        path: f.relPath,
        sourcePath: relative(root, f.absPath).split(sep).join('/'),
        sha256: f.sha256,
        bytes: f.bytes,
      }))
    }

    const status =
      exitCode === undefined
        ? undefined
        : exitCode === 0
          ? 'CompletedActionStatus'
          : 'FailedActionStatus'

    const warnings = []
    if (command && seed === undefined) warnings.push('有 command 但未记录 seed —— 涉及随机性的运行将无法精确复现（Sandve R6）')
    if (kind === 'figure' && !raw.length) warnings.push('kind=figure 但没有 raw —— 图的原始数据缺失（Sandve R7）')
    if (exitCode !== undefined && exitCode !== 0) warnings.push(`本次运行失败（exitCode=${exitCode}），工件已保留以免丢失失败信息`)

    const manifest = {
      name: displayName,
      slug,
      version,
      kind,
      createdAt: nowISO(),
      description: optStr(args, 'description'),
      activity: {
        command: command || undefined,
        exitCode,
        durationMs,
        actionStatus: status,
        seed,
        env,
        runtime,
        gitCommit,
        sessionLabel: exec?.sessionId ?? undefined,
      },
      inputs: stored,
      raw,
      links: {
        experiment: optStr(args, 'experiment') || undefined,
        hypothesis: optStr(args, 'hypothesis') || undefined,
        citekeys: Array.isArray(args.citekeys) ? args.citekeys.map(String) : [],
      },
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      notes: optStr(args, 'notes'),
      dedupe: { hardlinks: stored.filter((s) => s.stored === 'hardlink').length, copies: stored.filter((s) => s.stored === 'copy').length },
      deprecated: null,
    }

    await writeJsonAtomic(join(vdir, 'manifest.json'), manifest)
    await appendJsonl(join(artifactDir(root, slug), 'provenance.jsonl'), {
      event: 'save',
      version,
      files: stored.length,
      dedupe: manifest.dedupe,
      actionStatus: status,
      seed,
    })

    // 工件级清单（多版本索引）
    const artManifestPath = join(artifactDir(root, slug), 'artifact-manifest.json')
    const artManifest = (await readJson(artManifestPath, null)) ?? { name: displayName, slug, versions: [] }
    artManifest.versions = [...(artManifest.versions ?? []), { version, createdAt: manifest.createdAt, kind, files: stored.length }]
    artManifest.updatedAt = manifest.createdAt
    await writeJsonAtomic(artManifestPath, artManifest)
    await writeJsonAtomic(paths(root).byHash, byHash)

    // 全局索引
    const index = await readIndex(root)
    const existing = index.records.find((r) => r.slug === slug)
    const summary = {
      name: displayName,
      slug,
      kind,
      latest: version,
      versions: artManifest.versions.length,
      updatedAt: manifest.createdAt,
      description: manifest.description,
      tags: manifest.tags,
      deprecated: false,
    }
    if (existing) Object.assign(existing, summary)
    else index.records.push(summary)
    await writeJsonAtomic(paths(root).index, index)

    // 有研究清单就顺手刷新 INDEX.md，避免工件表停在旧状态
    const studyForIndex = await readJson(paths(root).study, null)
    if (studyForIndex) {
      try {
        await writeFile(join(root, 'research', 'INDEX.md'), renderIndex(studyForIndex, index), 'utf8')
      } catch {
        /* 索引刷新失败不影响保存本身 */
      }
    }

    // 与 study.json 联动（存在才更新）
    let linkedToExperiment = null
    if (manifest.links.hypothesis) {
      const study = await readJson(paths(root).study, null)
      if (study && !(study.hypotheses ?? []).some((h) => h.id === manifest.links.hypothesis)) {
        warnings.push(`study.json 里没有假设 ${manifest.links.hypothesis}，该关联无效`)
      }
    }
    if (manifest.links.experiment) {
      const study = await readJson(paths(root).study, null)
      if (study) {
        const experiment = (study.experiments ?? []).find((e) => e.id === manifest.links.experiment)
        if (experiment) {
          experiment.records = [...new Set([...(experiment.records ?? []), `${slug}@v${version}`])]
          await writeJsonAtomic(paths(root).study, study)
          linkedToExperiment = experiment.id
        } else {
          warnings.push(`study.json 里没有实验 ${manifest.links.experiment}，未建立关联`)
        }
      } else {
        warnings.push('study.json 不存在（未运行 study_init），记录已保存但未关联到实验')
      }
    }

    const lines = [
      `✓ 已保存 ${displayName} → v${version}`,
      `  文件 ${stored.length} 个 · ${humanBytes(stored.reduce((s, f) => s + f.bytes, 0))}` +
        `（硬链接去重 ${manifest.dedupe.hardlinks} / 复制 ${manifest.dedupe.copies}）`,
      `  存储 ${RECORDS}/${slug}/v${version}/files/`,
    ]
    if (status) lines.push(`  执行 ${status}${exitCode === undefined ? '' : ` · exitCode=${exitCode}`}${durationMs ? ` · ${durationMs}ms` : ''}`)
    if (seed !== undefined) lines.push(`  种子 ${seed}`)
    if (env) lines.push(`  环境 ${env.file} @ ${shortHash(env.sha256)}`)
    if (manifest.links.experiment) lines.push(`  关联实验 ${linkedToExperiment ?? manifest.links.experiment}（未生效）`)
    if (manifest.links.citekeys.length) lines.push(`  关联文献 ${manifest.links.citekeys.join(', ')}`)
    const renamed = stored.filter((f) => f.renamedFrom)
    if (renamed.length) {
      lines.push(`  同名冲突已消解 ${renamed.length} 个：` + renamed.slice(0, 3).map((f) => `${f.renamedFrom} → ${f.path}`).join('; '))
    }
    if (walk.skipped.length) {
      lines.push(`  跳过 ${walk.skipped.length} 项：` + walk.skipped.slice(0, 3).map((s) => `${s.path}(${s.reason})`).join('; '))
    }
    for (const warning of warnings) lines.push(`  ⚠ ${warning}`)
    lines.push('', `下一步：record_verify(name="${displayName}") 校验完整性；record_reproduce 拿复现指引。`)
    return lines.join('\n')
  })
}

// ── 工具 2：record_verify ───────────────────────────────────────────────────

async function cmdVerify(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const displayName = requireStr(args, 'name')
  const slug = slugify(displayName)
  const dir = artifactDir(root, slug)
  const artManifest = await readJson(join(dir, 'artifact-manifest.json'), null)
  if (!artManifest) throw vaultErr('ERR_NOT_FOUND', `工件不存在：${displayName}`)

  const versions = [...(artManifest.versions ?? [])].sort((a, b) => a.version - b.version)
  if (!versions.length) throw vaultErr('ERR_NOT_FOUND', `工件 ${displayName} 没有任何版本`)
  const version = optInt(args, 'version') ?? versions[versions.length - 1].version
  const entry = versions.find((v) => v.version === version)
  if (!entry) throw vaultErr('ERR_NOT_FOUND', `工件 ${displayName} 没有 v${version}`)

  const vdir = join(dir, `v${version}`)
  const manifest = await readJson(join(vdir, 'manifest.json'))
  const missing = []
  const mismatches = []
  const checked = []

  for (const file of manifest.inputs ?? []) {
    const abs = join(vdir, 'files', file.path)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) {
      missing.push(file.path)
      continue
    }
    const actual = await hashFileStreaming(abs)
    checked.push(file.path)
    if (actual !== file.sha256) mismatches.push({ path: file.path, recorded: file.sha256, actual })
  }

  // 多余文件：版本目录里存在但清单未记录（dsh-science 的 verify 漏掉的一点）
  const recorded = new Set((manifest.inputs ?? []).map((f) => f.path.split('/').join('/')))
  const extras = []
  const walkDir = async (abs, base) => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const child = join(abs, e.name)
      const rel = relative(base, child).split(sep).join('/')
      if (e.isDirectory()) {
        if (DEFAULT_IGNORE_NAMES.has(e.name)) continue
        await walkDir(child, base)
      } else if (e.isFile() && !recorded.has(rel)) {
        extras.push(rel)
      }
    }
  }
  await walkDir(join(vdir, 'files'), join(vdir, 'files'))

  // 环境漂移
  const warnings = []
  let env = null
  if (manifest.activity?.env?.file) {
    const envAbs = withinRoot(root, manifest.activity.env.file)
    const info = await stat(envAbs).catch(() => null)
    if (!info?.isFile()) {
      env = { file: manifest.activity.env.file, status: 'missing' }
      warnings.push(`环境文件已不存在：${manifest.activity.env.file}`)
    } else {
      const actual = await hashFileStreaming(envAbs)
      const same = actual === manifest.activity.env.sha256
      env = { file: manifest.activity.env.file, status: same ? 'same' : 'changed', recorded: manifest.activity.env.sha256, actual }
      if (!same) warnings.push(`环境文件已变更（与记录不一致）：${manifest.activity.env.file}`)
    }
  }

  // 种子
  if (manifest.activity?.command && manifest.activity?.seed === undefined) {
    warnings.push('该运行未记录随机种子，无法精确复现（Sandve R6）')
  }

  // 图的三向追溯：图工件 ↔ 原始数据 ↔ 出图脚本
  let figureTrace = null
  if (manifest.kind === 'figure') {
    const rawChecks = []
    for (const item of manifest.raw ?? []) {
      const shown = item.sourcePath ?? item.path
      const abs = withinRoot(root, shown)
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile()) {
        rawChecks.push({ path: shown, status: 'missing' })
        continue
      }
      const actual = await hashFileStreaming(abs)
      rawChecks.push({
        path: shown,
        status: actual === item.sha256 ? 'ok' : 'mismatch',
        recorded: item.sha256,
        actual,
      })
    }
    const scriptChecks = []
    for (const file of manifest.inputs ?? []) {
      if (!/\.(py|r|jl|m|sh)$/i.test(file.path)) continue
      const shown = file.sourcePath ?? file.path
      const abs = withinRoot(root, shown)
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile()) {
        scriptChecks.push({ path: shown, status: 'missing' })
        continue
      }
      const actual = await hashFileStreaming(abs)
      scriptChecks.push({
        path: shown,
        status: actual === file.sha256 ? 'ok' : 'mismatch',
        recorded: file.sha256,
        actual,
      })
    }
    figureTrace = {
      raw: rawChecks,
      scripts: scriptChecks,
      ok:
        rawChecks.length > 0 &&
        rawChecks.every((x) => x.status === 'ok') &&
        scriptChecks.length > 0 &&
        scriptChecks.every((x) => x.status === 'ok'),
    }
    if (!rawChecks.length) warnings.push('该工件是图但没有记录原始数据（Sandve R7）')
    for (const item of rawChecks) {
      if (item.status === 'missing') warnings.push(`图的原始数据缺失：${item.path}`)
      if (item.status === 'mismatch') warnings.push(`图的原始数据已变更：${item.path}`)
    }
    if (!scriptChecks.length) warnings.push('该图没有出图脚本（sources 里应包含 plot.py 等）')
    for (const item of scriptChecks) {
      if (item.status === 'missing') warnings.push(`出图脚本缺失：${item.path}`)
      if (item.status === 'mismatch') warnings.push(`出图脚本已变更：${item.path}`)
    }
  }

  const status =
    mismatches.length || missing.length
      ? 'mismatch'
      : extras.length
        ? 'extra'
        : figureTrace && !figureTrace.ok
          ? 'incomplete'
          : warnings.length
            ? 'ok-with-warnings'
            : 'ok'

  return {
    name: manifest.name,
    version,
    status,
    checked: checked.length,
    missing,
    mismatches,
    extras,
    env,
    figureTrace,
    warnings,
    activity: manifest.activity?.actionStatus,
  }
}

// ── 工具 3：record_reproduce ────────────────────────────────────────────────

async function cmdReproduce(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const displayName = requireStr(args, 'name')
  const slug = slugify(displayName)
  const dir = artifactDir(root, slug)
  const artManifest = await readJson(join(dir, 'artifact-manifest.json'), null)
  if (!artManifest) throw vaultErr('ERR_NOT_FOUND', `工件不存在：${displayName}`)
  const versions = [...(artManifest.versions ?? [])].sort((a, b) => a.version - b.version)
  const version = optInt(args, 'version') ?? versions[versions.length - 1]?.version
  const manifest = await readJson(join(dir, `v${version}`, 'manifest.json'), null)
  if (!manifest) throw vaultErr('ERR_NOT_FOUND', `工件 ${displayName} 没有 v${version}`)

  const { activity = {}, inputs = [], links = {}, raw = [] } = manifest
  const lines = [`# 复现指引：${manifest.name} v${version}`, '']

  lines.push('## 执行')
  if (activity.command) {
    lines.push('```bash', activity.command, '```')
    if (activity.actionStatus) lines.push(`- 当时状态：${activity.actionStatus}${activity.exitCode !== undefined ? `（exitCode ${activity.exitCode}）` : ''}`)
    if (activity.durationMs) lines.push(`- 当时耗时：${(activity.durationMs / 1000).toFixed(1)}s`)
    lines.push(`- 随机种子：${activity.seed ?? '**未记录**（涉及随机性则结果无法精确复现）'}`)
  } else {
    lines.push('- 该工件没有关联命令（可能是人工产出或从别处登记）')
  }

  lines.push('', '## 环境')
  if (activity.env) {
    lines.push(`- 环境文件：\`${activity.env.file}\` @ \`${shortHash(activity.env.sha256, 12)}\``)
    const envAbs = withinRoot(root, activity.env.file)
    const info = await stat(envAbs).catch(() => null)
    if (!info?.isFile()) lines.push('  - ⚠ 文件已不存在，需从版本库或备份恢复')
    else {
      const actual = await hashFileStreaming(envAbs)
      lines.push(actual === activity.env.sha256 ? '  - ✓ 与记录一致' : `  - ⚠ 已变更（当前 ${shortHash(actual, 12)}）`)
    }
  } else {
    lines.push('- 未记录环境文件')
  }
  if (activity.runtime) {
    const rt = Object.entries(activity.runtime).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' · ')
    if (rt) lines.push(`- 运行时：${rt}`)
  }
  if (activity.gitCommit) lines.push(`- 代码版本：git \`${activity.gitCommit}\``)

  lines.push('', '## 文件（回查原路径，确认磁盘上还是当初那份）')
  if (!inputs.length) lines.push('- 无记录')
  for (const file of inputs) {
    const shown = file.sourcePath ?? file.path
    const abs = withinRoot(root, shown)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) {
      lines.push(`- ✗ \`${shown}\` —— 当前不存在`)
      continue
    }
    const actual = await hashFileStreaming(abs)
    lines.push(
      actual === file.sha256
        ? `- ✓ \`${shown}\`（${humanBytes(file.bytes)}，哈希一致）`
        : `- ⚠ \`${shown}\` —— 内容已变更（当前 ${shortHash(actual, 12)}，记录 ${shortHash(file.sha256, 12)}）`,
    )
  }

  if (raw.length) {
    lines.push('', '## 图的原始数据（回查项目路径）')
    for (const file of raw) {
      const shown = file.sourcePath ?? file.path
      const abs = withinRoot(root, shown)
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile()) {
        lines.push(`- ✗ \`${shown}\` —— 当前不存在`)
        continue
      }
      const actual = await hashFileStreaming(abs)
      lines.push(
        actual === file.sha256
          ? `- ✓ \`${shown}\`（哈希一致）`
          : `- ⚠ \`${shown}\` —— 已变更（当前 ${shortHash(actual, 12)}，记录 ${shortHash(file.sha256, 12)}）`,
      )
    }
  }

  const scripts = (inputs ?? []).filter((file) => /\.(py|r|jl|m|sh)$/i.test(file.path))
  if (manifest.kind === 'figure' && scripts.length) {
    lines.push('', '## 出图脚本（回查项目路径）')
    for (const file of scripts) {
      const shown = file.sourcePath ?? file.path
      const abs = withinRoot(root, shown)
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile()) {
        lines.push(`- ✗ \`${shown}\` —— 当前不存在`)
        continue
      }
      const actual = await hashFileStreaming(abs)
      lines.push(
        actual === file.sha256
          ? `- ✓ \`${shown}\`（哈希一致）`
          : `- ⚠ \`${shown}\` —— 已变更（当前 ${shortHash(actual, 12)}，记录 ${shortHash(file.sha256, 12)}）`,
      )
    }
  }

  if (links.experiment || links.hypothesis || (links.citekeys ?? []).length) {
    lines.push('', '## 关联')
    if (links.experiment) lines.push(`- 实验：${links.experiment}`)
    if (links.hypothesis) lines.push(`- 假设：${links.hypothesis}`)
    if ((links.citekeys ?? []).length) lines.push(`- 文献：${links.citekeys.join(', ')}`)
  }

  lines.push('', '## 工件本体')
  lines.push(`- 快照目录：\`${RECORDS}/${slug}/v${version}/files/\``)
  lines.push('', `在项目根重跑上面的命令即可重建该工件；若输入哈希不一致，先恢复输入再重跑。`)
  return lines.join('\n')
}

// ── 注册 ────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.tools.register(
    tool({
      name: 'record_save',
      description:
        '保存工件并登记产生它的运行：逐文件哈希、命令、退出码、耗时、种子、环境、输入输出，以及到实验/假设/文献的关联。相同内容硬链接去重；失败运行也留档。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          description: { type: 'string', description: '一句话说明这是什么' },
          kind: { type: 'string', enum: ['data', 'figure', 'table', 'code', 'model', 'run', 'other'] },
          command: { type: 'string' },
          exitCode: { type: 'number' },
          durationMs: { type: 'number' },
          seed: { description: '随机种子（涉及随机性的运行务必记录）'  },
          env: { type: 'string', description: '环境文件路径（如 envs/exp.lock.yml），会记哈希' },
          raw: { type: 'array', items: { type: 'string' }, description: '图的原始数据文件（kind=figure 时强烈建议）' },
          experiment: { type: 'string' },
          hypothesis: { type: 'string' },
          citekeys: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['name', 'sources'],
      },
      presentTitle: '保存工件',
      execute: cmdSave,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'record_verify',
      description:
        '校验工件：重算哈希、报缺失与被改、检出目录里多余的文件、检查环境漂移与种子缺失。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'number' },
        },
        required: ['name'],
      },
      presentTitle: '校验工件',
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          name: { type: 'string'  },
          version: { type: 'number'  },
          status: { type: 'string'  },
          checked: { type: 'number' },
          missing: { type: 'array' },
          mismatches: { type: 'array' },
          extras: { type: 'array' },
          figureTrace: { type: 'object' },
          warnings: { type: 'array' },
        },
        required: ['name', 'version', 'status', 'checked'],
      },
      execute: cmdVerify,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'record_reproduce',
      description:
        '输出复现指引：命令、成败、耗时、种子、环境对比，并把输入逐个按项目根回查哈希。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'number' },
        },
        required: ['name'],
      },
      presentTitle: '复现指引',
      execute: cmdReproduce,
    }),
  )
}

// 供单测直接调用
export const __test__ = { cmdSave, cmdVerify, cmdReproduce, nextVersion, relToRecords }
