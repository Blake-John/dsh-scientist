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
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
  const walk = await walkSources(absSources, {
    maxFileBytes: optInt(args, 'maxFileBytes') ?? MAX_FILE_BYTES,
    excludes: Array.isArray(args.exclude) ? args.exclude : [],
  })
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
      const dest = join(filesDir, file.relPath)
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
        path: file.relPath, // 版本目录内的相对路径
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
      raw = rawWalk.files.map((f) => ({ path: f.relPath, sha256: f.sha256, bytes: f.bytes }))
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

    // 与 study.json 联动（存在才更新）
    let linkedToExperiment = null
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
  if (manifest.kind === 'figure' && !(manifest.raw ?? []).length) {
    warnings.push('该工件是图但没有记录原始数据（Sandve R7）')
  }

  const status =
    mismatches.length || missing.length ? 'mismatch' : extras.length ? 'extra' : warnings.length ? 'ok-with-warnings' : 'ok'

  return {
    name: manifest.name,
    version,
    status,
    checked: checked.length,
    missing,
    mismatches,
    extras,
    env,
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

  lines.push('', '## 输入（校验当前磁盘上的文件是否仍是当初那份）')
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
    lines.push('', '## 图的原始数据')
    for (const file of raw) lines.push(`- \`${file.path}\` @ ${shortHash(file.sha256, 12)}`)
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
        '把分析结果/图/数据保存为版本化工件，并登记产生它的运行：逐文件 SHA-256、命令、退出码、耗时、随机种子、环境文件、' +
        '输入输出哈希，以及到实验/假设/文献 citekey 的关联。内容相同的文件在库内部硬链接去重。' +
        '失败运行同样保存（保留失败信息）。这是可复现链条的落点。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', description: '项目根（默认自动探测）' },
          name: { type: 'string', description: '工件名（人类可读，会 slugify 成目录）' },
          sources: { type: 'array', items: { type: 'string' }, description: '要保存的文件或目录（相对项目根）' },
          description: { type: 'string', description: '一句话说明这是什么' },
          kind: { type: 'string', enum: ['data', 'figure', 'table', 'code', 'model', 'run', 'other'], description: '工件类型，默认 data' },
          command: { type: 'string', description: '产生它的命令（原样粘贴，用于复现）' },
          exitCode: { type: 'number', description: '命令退出码；0 记为成功，非 0 记为失败' },
          durationMs: { type: 'number', description: '耗时（毫秒）' },
          seed: { description: '随机种子（涉及随机性的运行务必记录）' },
          env: { type: 'string', description: '环境文件路径（如 envs/exp.lock.yml），会记哈希' },
          raw: { type: 'array', items: { type: 'string' }, description: '图的原始数据文件（kind=figure 时强烈建议）' },
          experiment: { type: 'string', description: '关联的实验编号（如 E01），会回写 study.json' },
          hypothesis: { type: 'string', description: '关联的假设编号（如 H1）' },
          citekeys: { type: 'array', items: { type: 'string' }, description: '关联的文献 citekey' },
          tags: { type: 'array', items: { type: 'string' }, description: '自由标签' },
          notes: { type: 'string', description: '备注' },
          exclude: { type: 'array', items: { type: 'string' }, description: '额外忽略规则（目录名或 *.通配）' },
          maxFileBytes: { type: 'number', description: '单文件上限，默认 8 GiB' },
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
        '校验工件版本：重算每个文件的 SHA-256、报告缺失与被改、**检出目录里多出来的文件**、' +
        '检查环境文件是否漂移、提示未记录随机种子或图的原始数据。status=ok 表示完全一致。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', description: '项目根（默认自动探测）' },
          name: { type: 'string', description: '工件名' },
          version: { type: 'number', description: '版本号，默认最新' },
        },
        required: ['name'],
      },
      presentTitle: '校验工件',
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          name: { type: 'string' },
          version: { type: 'number' },
          status: { type: 'string' },
          checked: { type: 'number' },
          missing: { type: 'array' },
          mismatches: { type: 'array' },
          extras: { type: 'array' },
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
        '输出工件的复现指引：当时的命令、退出状态、耗时、随机种子、环境文件（及其是否漂移）、' +
        '输入文件清单并逐个校验当前磁盘上的哈希是否仍是当初那份。用于回答「这个结果还能不能重跑出来」。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', description: '项目根（默认自动探测）' },
          name: { type: 'string', description: '工件名' },
          version: { type: 'number', description: '版本号，默认最新' },
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
