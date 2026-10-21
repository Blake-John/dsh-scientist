#!/usr/bin/env node
/**
 * vault —— 科研记录的运维命令（不占模型上下文，供人和脚本用）
 *
 *   vault index                 重新生成 research/INDEX.md
 *   vault list [--kind K] [--tag T]
 *   vault show <name> [--version N]
 *   vault diff <name> [--from N] [--to N]
 *   vault deprecate <name> [--version N] [--reason 文本]
  vault prune [--keep N | --deprecated-only] [--dry-run]
 *   vault loop <子命令>                 约定 loop 的记账与关闭（见下）
  vault export [--out DIR]    导出 RO-Crate 子集（可交给审稿人/存档）
 *
 * 设计依据：Sandve 2013 R9（文字连到结果）、RO-Crate 1.1（内容寻址与 CreateAction）。
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  humanBytes,
  nowISO,
  readJson,
  resolveRoot,
  shortHash,
  slugify,
  vaultErr,
  withFileLock,
  withinRoot,
  writeJsonAtomic,
} from '../vault-core.mjs'
import { scaffoldProject, writeIndex, writeRootReadme } from '../vault-study.mjs'
import { projectLayout } from '../project-layout.mjs'
import {
  abortLoop,
  activeLoop,
  closeLoop,
  createLoop,
  listLoops,
  LOOP_STATE_LABEL,
  noteLoop,
  readLoop,
  renderLoop,
  verifyExit,
} from '../vault-loop-core.mjs'

const run = promisify(execFile)
const RECORDS = 'research/records'

const paths = (root) => ({
  recordsDir: join(root, RECORDS),
  index: join(root, RECORDS, 'index.json'),
  lock: join(root, 'research', '.lock'),
  study: join(root, 'research', 'study.json'),
  artifactIndex: join(root, 'research', 'INDEX.md'),
})

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parse(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i += 1
      }
    } else positional.push(token)
  }
  return { positional, flags }
}

const readIndex = async (root) => {
  const index = await readJson(paths(root).index, { records: [] })
  index.records = Array.isArray(index.records) ? index.records : []
  return index
}

const artifactDir = (root, name) => withinRoot(root, join(RECORDS, slugify(name)))

async function loadArtifact(root, name) {
  const dir = artifactDir(root, name)
  const art = await readJson(join(dir, 'artifact-manifest.json'), null)
  if (!art) throw vaultErr('ERR_NOT_FOUND', `工件不存在：${name}`)
  art.versions = [...(art.versions ?? [])].sort((a, b) => a.version - b.version)
  return { dir, art }
}

const loadVersion = async (root, name, version) => {
  const { dir, art } = await loadArtifact(root, name)
  const v = version ?? art.versions[art.versions.length - 1]?.version
  const manifest = await readJson(join(dir, `v${v}`, 'manifest.json'), null)
  if (!manifest) throw vaultErr('ERR_NOT_FOUND', `${name} 没有 v${v}`)
  return { dir, art, version: v, manifest, vdir: join(dir, `v${v}`) }
}

// ── index ───────────────────────────────────────────────────────────────────

async function cmdIndex(root) {
  const study = await readJson(paths(root).study, null)
  if (!study) throw vaultErr('ERR_NO_STUDY', 'research/study.json 不存在，先运行 study_init')
  study.hypotheses ??= []
  study.experiments ??= []
  study.decisions ??= []
  study.reviews ??= []
  study.claims ??= []
  study.question ??= { text: '', history: [] }
  study.loop ??= { phase: '?', iteration: 0 }
  await writeIndex(root, study)
  console.log('✓ 已生成 research/INDEX.md')
}

// ── list ────────────────────────────────────────────────────────────────────

async function cmdList(root, flags) {
  const index = await readIndex(root)
  let rows = index.records
  if (flags.kind) rows = rows.filter((r) => r.kind === flags.kind)
  if (flags.tag) rows = rows.filter((r) => (r.tags ?? []).includes(flags.tag))
  if (!rows.length) {
    console.log('（还没有工件）')
    return
  }
  const width = Math.min(28, Math.max(...rows.map((r) => String(r.name).length)) + 2)
  console.log(`${'名称'.padEnd(width)}  ${'类型'.padEnd(6)}  ${'版本'.padEnd(4)}  更新时间`)
  console.log('-'.repeat(width + 30))
  for (const r of rows) {
    console.log(
      `${String(r.name).padEnd(width)}  ${String(r.kind ?? '').padEnd(6)}  ${`v${r.latest ?? '?'}`.padEnd(4)}  ${r.updatedAt ?? ''}${r.deprecated ? '  [已废弃]' : ''}`,
    )
  }
  console.log(`\n共 ${rows.length} 个工件`)
}

// ── show ────────────────────────────────────────────────────────────────────

async function cmdShow(root, name, flags) {
  const version = flags.version ? Number(flags.version) : undefined
  const { art, version: v, manifest, vdir } = await loadVersion(root, name, version)
  const a = manifest.activity ?? {}
  console.log(`# ${manifest.name} v${v}（${art.versions.length} 个版本）`)
  if (manifest.description) console.log(`  ${manifest.description}`)
  console.log('')
  console.log(`类型      ${manifest.kind}`)
  console.log(`创建时间  ${manifest.createdAt}`)
  if (a.actionStatus) console.log(`执行      ${a.actionStatus}${a.exitCode !== undefined ? ` · exitCode=${a.exitCode}` : ''}${a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)}s` : ''}`)
  if (a.command) console.log(`命令      ${a.command}`)
  console.log(`种子      ${a.seed ?? '**未记录**'}`)
  if (a.env) console.log(`环境      ${a.env.file} @ ${shortHash(a.env.sha256)}`)
  if (a.gitCommit) console.log(`代码      git ${a.gitCommit}`)
  const links = manifest.links ?? {}
  if (links.experiment || links.hypothesis || (links.citekeys ?? []).length) {
    console.log(`关联      ${[links.experiment && `实验 ${links.experiment}`, links.hypothesis && `假设 ${links.hypothesis}`, (links.citekeys ?? []).length && `文献 ${links.citekeys.join(',')}`].filter(Boolean).join(' · ')}`)
  }
  console.log('')
  console.log(`文件 ${(manifest.inputs ?? []).length} 个：`)
  for (const f of manifest.inputs ?? []) {
    console.log(`  ${f.path}  ${humanBytes(f.bytes)}  ${shortHash(f.sha256, 12)}  ${f.stored === 'hardlink' ? '(链接)' : ''}`)
  }
  console.log(`\n目录 ${relative(root, vdir)}`)
}

// ── diff ────────────────────────────────────────────────────────────────────

const TEXT_LIMIT = 256 * 1024

async function lineStats(aText, bText) {
  const count = (text) => {
    const map = new Map()
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const a = count(aText)
  const b = count(bText)
  let added = 0
  let removed = 0
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0))
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0))
  return { added, removed }
}

async function unifiedDiff(aPath, bPath) {
  try {
    const { stdout } = await run('diff', ['-u', '--label', 'old', '--label', 'new', aPath, bPath], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // diff 退出码 1 = 有差异，stdout 仍可用
    if (error.code === 1 && error.stdout) return error.stdout
    return null
  }
}

async function cmdDiff(root, name, flags) {
  const { art } = await loadArtifact(root, name)
  if (art.versions.length < 2) throw vaultErr('ERR_BAD_ARGS', `${name} 只有一个版本，无法对比`)
  const to = flags.to ? Number(flags.to) : art.versions[art.versions.length - 1].version
  // 版本数组升序：必须从后往前找，才拿到「上一版」而不是最旧版
  const from = flags.from
    ? Number(flags.from)
    : ([...art.versions].reverse().find((v) => v.version < to)?.version ?? art.versions[0].version)
  const a = await loadVersion(root, name, from)
  const b = await loadVersion(root, name, to)
  const mapA = new Map((a.manifest.inputs ?? []).map((f) => [f.path, f]))
  const mapB = new Map((b.manifest.inputs ?? []).map((f) => [f.path, f]))

  const added = []
  const removed = []
  const changed = []
  const unchanged = []
  for (const [p, f] of mapB) {
    if (!mapA.has(p)) added.push({ path: p, sha256: f.sha256 })
    else if (mapA.get(p).sha256 !== f.sha256) changed.push({ path: p, from: mapA.get(p).sha256, to: f.sha256, bytes: f.bytes })
    else unchanged.push({ path: p })
  }
  for (const [p, f] of mapA) if (!mapB.has(p)) removed.push({ path: p, sha256: f.sha256 })

  console.log(`# ${name}  v${from} → v${to}`)
  console.log(`  新增 ${added.length} · 删除 ${removed.length} · 变更 ${changed.length} · 未变 ${unchanged.length}`)
  for (const f of added) console.log(`  + ${f.path}`)
  for (const f of removed) console.log(`  - ${f.path}`)
  for (const f of changed) {
    let detail = ''
    if (f.bytes <= TEXT_LIMIT) {
      try {
        const aText = await readFile(join(a.vdir, 'files', f.path), 'utf8')
        const bText = await readFile(join(b.vdir, 'files', f.path), 'utf8')
        const stats = await lineStats(aText, bText)
        detail = `  +${stats.added}/-${stats.removed} 行`
        console.log(`  ~ ${f.path}${detail}`)
        if (flags.patch) {
          const patch = await unifiedDiff(join(a.vdir, 'files', f.path), join(b.vdir, 'files', f.path))
          if (patch) {
            const lines = patch.split('\n')
            console.log(lines.slice(0, 60).join('\n'))
            if (lines.length > 60) console.log(`  …（还有 ${lines.length - 60} 行，用 --patch 已截断）`)
          }
        }
      } catch {
        console.log(`  ~ ${f.path}（二进制或无法作为文本读取）`)
      }
    } else {
      console.log(`  ~ ${f.path}（超过 ${humanBytes(TEXT_LIMIT)}，只比哈希）`)
    }
  }
}

// ── prune ───────────────────────────────────────────────────────────────────

async function cmdPrune(root, flags) {
  const keep = flags.keep === undefined ? undefined : Number(flags.keep)
  const deprecatedOnly = flags['deprecated-only'] === true
  const dryRun = flags['dry-run'] === true
  if (keep === undefined && !deprecatedOnly) {
    throw vaultErr('ERR_BAD_ARGS', '必须指定 --keep N 或 --deprecated-only（避免误删）')
  }
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    throw vaultErr('ERR_BAD_ARGS', '--keep 必须是 ≥1 的整数')
  }

  return await withFileLock(paths(root).lock, {}, async () => {
    const index = await readIndex(root)
    let removedVersions = 0
    let freedBytes = 0
    const report = []

    for (const entry of index.records) {
      const { art } = await loadArtifact(root, entry.name)
      const latest = art.versions[art.versions.length - 1]?.version
      const doomed = []
      for (const v of art.versions) {
        // 双保险：beyondKeep 本身已排除最新版，这里再挡一次（防止将来改 keep 语义时误删）
        if (v.version === latest) continue
        const manifest = await readJson(join(artifactDir(root, entry.name), `v${v.version}`, 'manifest.json'), null)
        const isDeprecated = Boolean(manifest?.deprecated)
        const beyondKeep = keep !== undefined && art.versions.filter((x) => x.version >= v.version).length > keep
        if ((deprecatedOnly && isDeprecated) || (keep !== undefined && beyondKeep)) doomed.push({ v, manifest })
      }
      if (!doomed.length) continue
      for (const { v, manifest } of doomed) {
        const bytes = (manifest?.inputs ?? []).reduce((s, f) => s + (f.bytes ?? 0), 0)
        freedBytes += bytes
        removedVersions += 1
        report.push(`  ${entry.name} v${v.version}  ${humanBytes(bytes)}${manifest?.deprecated ? '  [已废弃]' : ''}`)
        if (!dryRun) {
          await rm(join(artifactDir(root, entry.name), `v${v.version}`), { recursive: true, force: true })
        }
      }
      if (!dryRun) {
        art.versions = art.versions.filter((v) => !doomed.some((d) => d.v.version === v.version))
        art.updatedAt = nowISO()
        await writeJsonAtomic(join(artifactDir(root, entry.name), 'artifact-manifest.json'), art)
        const summary = index.records.find((r) => r.slug === entry.slug)
        if (summary) {
          summary.versions = art.versions.length
          summary.latest = art.versions[art.versions.length - 1]?.version
        }
      }
    }

    if (!dryRun && removedVersions) {
      await writeJsonAtomic(paths(root).index, index)
      // 清掉 by-hash 里指向已删除文件的死条目（否则去重表只增不减）
      const byHashPath = join(root, 'research', 'records', 'by-hash.json')
      const byHash = await readJson(byHashPath, null)
      if (byHash && typeof byHash === 'object') {
        let dropped = 0
        for (const [sha, rel] of Object.entries(byHash)) {
          const exists = await stat(join(root, 'research', 'records', rel)).then((i) => i.isFile()).catch(() => false)
          if (!exists) {
            delete byHash[sha]
            dropped += 1
          }
        }
        if (dropped) await writeJsonAtomic(byHashPath, byHash)
      }
    }

    if (!removedVersions) {
      console.log('没有需要清理的版本')
      return
    }
    console.log(`${dryRun ? '（演练，未改动）' : '✓ 已清理'} 共 ${removedVersions} 个版本，约 ${humanBytes(freedBytes)}`)
    console.log('  注：硬链接去重过的文件实际释放量可能更少')
    for (const line of report) console.log(line)
  })
}

// ── deprecate ───────────────────────────────────────────────────────────────

async function cmdDeprecate(root, name, flags) {
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  return await withFileLock(paths(root).lock, {}, async () => {
    const { dir, art } = await loadArtifact(root, name)
    const versions = flags.version ? [Number(flags.version)] : art.versions.map((v) => v.version)
    const mark = { at: nowISO(), reason }
    for (const v of versions) {
      const manifestPath = join(dir, `v${v}`, 'manifest.json')
      const manifest = await readJson(manifestPath, null)
      if (!manifest) throw vaultErr('ERR_NOT_FOUND', `${name} 没有 v${v}`)
      manifest.deprecated = mark
      await writeJsonAtomic(manifestPath, manifest)
      const entry = art.versions.find((x) => x.version === v)
      if (entry) entry.deprecated = true
    }
    if (!flags.version) art.deprecated = mark
    art.updatedAt = nowISO()
    await writeJsonAtomic(join(dir, 'artifact-manifest.json'), art)
    const index = await readIndex(root)
    const summary = index.records.find((r) => r.slug === art.slug)
    if (summary) summary.deprecated = Boolean(art.deprecated ?? art.versions.every((v) => v.deprecated))
    await writeJsonAtomic(paths(root).index, index)
    console.log(`✓ 已标记废弃 ${name} ${flags.version ? `v${flags.version}` : '全部版本'}${reason ? `：${reason}` : ''}`)
    console.log('  废弃不等于删除：内容仍在，vault list/show 会显示标记；需要回收用 vault prune --deprecated-only')
  })
}

// ── export（RO-Crate 子集）─────────────────────────────────────────────────

async function cmdExport(root, flags) {
  const study = await readJson(paths(root).study, null)
  const index = await readIndex(root)
  const layout = await projectLayout(root)
  const outDir = withinRoot(root, flags.out ?? layout.exports)
  await mkdir(outDir, { recursive: true })

  const graph = []
  const shaId = (sha) => `#sha256:${sha}`

  graph.push({
    '@id': 'ro-crate-metadata.json',
    '@type': 'CreativeWork',
    about: { '@id': './' },
    conformsTo: [{ '@id': 'https://w3id.org/ro/crate/1.1' }],
  })
  graph.push({
    '@id': './',
    '@type': 'Dataset',
    name: study?.title ?? '研究项目',
    description: study?.question?.text ?? '',
    datePublished: nowISO(),
    conformsTo: [{ '@id': 'https://w3id.org/ro/crate/1.1' }],
    // 说明这是子集：只导出工件与其执行，不含原始数据
    comment: 'vault export 生成的 RO-Crate 子集：含工件文件、执行（CreateAction）与关联；不区分输入/输出，也不含原始数据本体',
  })

  for (const entry of index.records) {
    const { art } = await loadArtifact(root, entry.name)
    for (const v of art.versions) {
      const manifest = await readJson(join(artifactDir(root, entry.name), `v${v.version}`, 'manifest.json'), null)
      if (!manifest) continue
      const actionId = `#record:${art.slug}:v${v.version}`
      const a = manifest.activity ?? {}
      // 结束时间 = 开始 + 耗时（旧实现写反了：有耗时反而给 undefined）
      const startMs = Date.parse(manifest.createdAt)
      const endTime = Number.isFinite(startMs) && a.durationMs
        ? new Date(startMs + a.durationMs).toISOString()
        : manifest.createdAt
      graph.push({
        '@id': actionId,
        '@type': 'CreateAction',
        name: `${manifest.name} v${v.version}`,
        description: manifest.description ?? '',
        startTime: manifest.createdAt,
        endTime,
        actionStatus: a.actionStatus ? `http://schema.org/${a.actionStatus}` : undefined,
        instrument: a.command ? { '@id': `#command:${art.slug}:v${v.version}` } : undefined,
        // 存储的是产出快照（result）；本记录不区分「输入」与「输出」，故不虚构 object
        result: (manifest.inputs ?? []).map((f) => ({ '@id': shaId(f.sha256) })),
        mention: (manifest.links?.experiment ? [{ '@id': `#experiment:${manifest.links.experiment}` }] : []).concat(
          (manifest.links?.citekeys ?? []).map((k) => ({ '@id': `#citekey:${k}` })),
        ),
      })
      if (a.command) {
        graph.push({ '@id': `#command:${art.slug}:v${v.version}`, '@type': 'SoftwareApplication', command: a.command, seed: a.seed })
      }
      const seen = new Set()
      for (const f of manifest.inputs ?? []) {
        if (seen.has(f.sha256)) continue
        seen.add(f.sha256)
        graph.push({
          '@id': shaId(f.sha256),
          '@type': 'File',
          name: f.path,
          contentSize: f.bytes,
          sha256: f.sha256,
          encodingFormat: f.path.endsWith('.json') ? 'application/json' : undefined,
        })
      }
    }
  }

  for (const h of study?.hypotheses ?? []) {
    graph.push({
      '@id': `#hypothesis:${h.id}`,
      '@type': 'CreativeWork',
      name: `${h.id}（${h.status}）`,
      text: h.text,
      citation: (h.citekeys ?? []).map((k) => ({ '@id': `#citekey:${k}` })),
    })
  }
  for (const e of study?.experiments ?? []) {
    graph.push({
      '@id': `#experiment:${e.id}`,
      '@type': 'Action',
      name: `${e.id} ${e.title}`,
      actionStatus: `http://schema.org/${e.status === 'done' ? 'CompletedActionStatus' : 'PotentialActionStatus'}`,
      subjectOf: (e.records ?? []).map((r) => ({ '@id': `#record:${String(r).split('@')[0]}:v${String(r).split('@')[1]?.replace('v', '') ?? '1'}` })),
    })
  }
  for (const c of study?.claims ?? []) {
    graph.push({
      '@id': `#claim:${c.id}`,
      '@type': 'Claim',
      text: c.text,
      citation: (c.evidence?.citekeys ?? []).map((k) => ({ '@id': `#citekey:${k}` })),
    })
  }
  const citekeys = new Set([
    ...(study?.hypotheses ?? []).flatMap((h) => h.citekeys ?? []),
    ...(study?.decisions ?? []).flatMap((d) => d.citekeys ?? []),
    ...(study?.claims ?? []).flatMap((c) => c.evidence?.citekeys ?? []),
  ])
  for (const key of citekeys) graph.push({ '@id': `#citekey:${key}`, '@type': 'ScholarlyArticle', identifier: key })

  const crate = {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': graph.filter(Boolean),
  }
  const target = join(outDir, 'ro-crate-metadata.json')
  await writeJsonAtomic(target, crate)
  console.log(`✓ 已导出 ${relative(root, target)}`)
  console.log(`  实体 ${graph.length} 个 · 工件 ${index.records.length} 个 · 文献引用 ${citekeys.size} 条`)
  console.log('  说明：这是 RO-Crate 子集（工件与执行），不含原始数据本体')
}

// ── layout / migrate ───────────────────────────────────────────────────────

const MIGRATE_MOVES = [
  ['literature', 'knowledge/literature'],
  ['data/papers', 'knowledge/literature/pdfs'],
  ['derivations', 'experiments/derivations'],
  ['figures', 'outputs/figures'],
  ['manuscript', 'outputs/manuscript'],
  ['reviews', 'research/reviews'],
  ['analyses', 'experiments/analyses'],
  ['research/export', 'outputs/exports'],
  ['reports', 'knowledge/reports'],
]

const MANIFEST_PREFIXES = [
  ['literature/', 'knowledge/literature/'],
  ['data/papers/', 'knowledge/literature/pdfs/'],
  ['derivations/', 'experiments/derivations/'],
  ['figures/', 'outputs/figures/'],
  ['manuscript/', 'outputs/manuscript/'],
  ['reviews/', 'research/reviews/'],
  ['analyses/', 'experiments/analyses/'],
  ['research/export/', 'outputs/exports/'],
  ['reports/', 'knowledge/reports/'],
]

const exists = async (p) => Boolean(await stat(p).catch(() => null))

async function moveIfAbsent(src, dest, dry) {
  if (!(await exists(src))) return false
  if (await exists(dest)) {
    console.log(`  · 跳过 ${src}（目标已存在）`)
    return false
  }
  console.log(`  ${dry ? 'would move' : 'move'} ${src} → ${dest}`)
  if (!dry) {
    await mkdir(dirname(dest), { recursive: true })
    await rename(src, dest)
  }
  return true
}

async function migrateSurveys(root, dry) {
  const reports = join(root, 'reports')
  if (!(await exists(reports))) return
  for (const entry of await readdir(reports, { withFileTypes: true }).catch(() => [])) {
    const fileMatch = entry.isFile() && entry.name.match(/^landscape-(.+)\.md$/)
    const dirMatch = entry.isDirectory() && entry.name.match(/^landscape-(.+)$/)
    if (!fileMatch && !dirMatch) continue
    const slug = (fileMatch ?? dirMatch)[1]
    const dest = join(root, 'knowledge', 'surveys', slug)
    if (await exists(dest)) continue
    console.log(`  ${dry ? 'would move' : 'move'} reports/${entry.name} → knowledge/surveys/${slug}/`)
    if (!dry) {
      await mkdir(dirname(dest), { recursive: true })
      if (fileMatch) {
        await mkdir(dest, { recursive: true })
        await rename(join(reports, entry.name), join(dest, 'report.md'))
      } else {
        await rename(join(reports, entry.name), dest)
      }
    }
  }
}

async function rewriteManifests(root) {
  const recDir = join(root, 'research', 'records')
  const dirs = await readdir(recDir, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const versions = await readdir(join(recDir, dir.name)).catch(() => [])
    for (const version of versions) {
      if (!/^v\d+$/.test(version)) continue
      for (const file of ['manifest.json', 'provenance.jsonl']) {
        const target = join(recDir, dir.name, version, file)
        const text = await readFile(target, 'utf8').catch(() => null)
        if (text === null) continue
        let next = text
        for (const [from, to] of MANIFEST_PREFIXES) next = next.split(from).join(to)
        if (next !== text) await writeFile(target, next, 'utf8')
      }
    }
  }
}

async function cmdLayout(root) {
  const layout = await projectLayout(root)
  console.log(`layout: ${layout.version}`)
  for (const key of [
    'codes', 'knowledge', 'surveys', 'literature', 'notes', 'pdfs', 'bib', 'reports', 'logs', 'findings',
    'research', 'study', 'index', 'loops', 'records', 'reviews', 'decisions',
    'data', 'experiments', 'derivations', 'outputs', 'manuscript', 'figures', 'tables', 'submission', 'exports',
    'envs', 'scratch',
  ]) {
    console.log(`  ${key.padEnd(12)} ${layout[key]}`)
  }
}

async function cmdMigrate(root, flags) {
  const layout = await projectLayout(root)
  const dry = Boolean(flags['dry-run'])
  if (layout.version === 'v2') {
    console.log('· 已是 v2 布局，无需迁移')
    return
  }
  console.log(`迁移 v1 → v2：${root}${dry ? '（dry-run）' : ''}`)
  await migrateSurveys(root, dry)
  for (const [from, to] of MIGRATE_MOVES) await moveIfAbsent(join(root, from), join(root, to), dry)
  if (dry) return
  await scaffoldProject(root)
  const study = await readJson(join(root, 'research', 'study.json'), null)
  if (study) {
    study.layout = 'v2'
    await writeJsonAtomic(join(root, 'research', 'study.json'), study)
    await writeRootReadme(root, study)
    await writeIndex(root, study)
  }
  await rewriteManifests(root)
  console.log('✓ 已迁移到 v2；建议 git diff 检查后提交')
}

// ── loop 子命令组 ───────────────────────────────────────────────────────────

const splitList = (value) =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []

async function cmdLoop(root, positional, flags) {
  const sub = positional[1]
  const rest = positional.slice(2)
  switch (sub) {
    case 'new': {
      const [kind, ...argParts] = rest
      if (!kind) throw vaultErr('ERR_BAD_ARGS', '用法：vault loop new <kind> <arg> [--requires …] [--checks …]')
      const loop = await createLoop(root, {
        kind,
        arg: argParts.join(' '),
        requires: splitList(flags.requires),
        checks: splitList(flags.checks),
        workMin: flags['work-min'] === undefined ? 0 : Number(flags['work-min']),
        maxNudges: flags['max-nudges'] === undefined ? undefined : Number(flags['max-nudges']),
        skill: typeof flags.skill === 'string' ? flags.skill : null,
      })
      console.log(loop.id)
      return
    }
    case 'list': {
      const loops = await listLoops(root, typeof flags.status === 'string' ? { status: flags.status } : {})
      if (flags.json) {
        console.log(JSON.stringify(loops, null, 2))
        return
      }
      if (!loops.length) {
        console.log('（没有 loop）')
        return
      }
      for (const loop of loops) {
        console.log(`${loop.id.padEnd(42)} ${(LOOP_STATE_LABEL[loop.status] ?? loop.status).padEnd(5)} ${loop.work?.length ?? 0} 条记录`)
      }
      const running = loops.filter((l) => l.status === 'running').length
      console.log(`\n共 ${loops.length} 个${running ? `，其中 ${running} 个进行中` : ''}`)
      return
    }
    case 'show': {
      if (!rest[0]) throw vaultErr('ERR_BAD_ARGS', '用法：vault loop show <id>')
      const loop = await readLoop(root, rest[0])
      if (flags.json) {
        console.log(JSON.stringify(loop, null, 2))
        return
      }
      console.log(renderLoop(loop))
      const { ok, failures } = await verifyExit(root, loop)
      console.log(ok ? '\n出口契约：已满足（可 close）' : `\n出口契约：未满足\n  · ${failures.join('\n  · ')}`)
      return
    }
    case 'note': {
      if (!rest[0]) throw vaultErr('ERR_BAD_ARGS', '用法：vault loop note <id> "内容"')
      const text = rest.slice(1).join(' ')
      const loop = await noteLoop(root, rest[0], text)
      console.log(`✓ 已记账（${loop.work.length} 条）`)
      return
    }
    case 'close': {
      if (!rest[0]) throw vaultErr('ERR_BAD_ARGS', '用法：vault loop close <id> [--failed --reason "…"]')
      const failed = flags.failed === true
      const reason = typeof flags.reason === 'string' ? flags.reason : ''
      try {
        const loop = await closeLoop(root, rest[0], { failed, reason })
        console.log(`✓ loop ${loop.id} 已关闭（${LOOP_STATE_LABEL[loop.status]}）`)
        if (loop.status === 'closed') {
          console.log(`  产物校验通过 · work ${loop.work.length} 条`)
        } else {
          console.log(`  原因：${loop.failReason}`)
        }
        return
      } catch (error) {
        if (error.code === 'ERR_EXIT_UNMET') {
          console.error(`✗ ${error.message}`)
          console.error('  补完后重试，或声明失败：vault loop close <id> --failed --reason "…"')
          process.exitCode = 1
          return
        }
        throw error
      }
    }
    case 'abort': {
      if (!rest[0]) throw vaultErr('ERR_BAD_ARGS', '用法：vault loop abort <id> [--reason "…"]')
      const loop = await abortLoop(root, rest[0], typeof flags.reason === 'string' ? flags.reason : '')
      console.log(`✓ loop ${loop.id} 已中止`)
      return
    }
    case 'active': {
      const loop = await activeLoop(root)
      console.log(loop ? renderLoop(loop) : '（没有进行中的 loop）')
      return
    }
    default:
      throw vaultErr('ERR_BAD_ARGS', `未知子命令 loop ${sub ?? ''}\n${LOOP_USAGE}`)
  }
}

const LOOP_USAGE = `  vault loop new <kind> <arg> [--requires a,b] [--checks c,d] [--work-min N] [--max-nudges N]
  vault loop list [--status running] [--json]
  vault loop show <id> [--json]
  vault loop note <id> "内容"
  vault loop close <id> [--failed --reason "…"]
  vault loop abort <id> [--reason "…"]
  vault loop active`

// ── main ────────────────────────────────────────────────────────────────────

const USAGE = `vault —— 科研记录运维
  vault index                          重新生成 research/INDEX.md
  vault list [--kind K] [--tag T]
  vault show <name> [--version N]
  vault diff <name> [--from N] [--to N] [--patch]
  vault deprecate <name> [--version N] [--reason 文本]
  vault prune [--keep N | --deprecated-only] [--dry-run]
  vault loop <子命令>                 约定 loop 的记账与关闭（见下）
  vault export [--out DIR]
  vault layout                        查看当前项目布局（v1/v2）与各层路径
  vault migrate --to v2 [--dry-run]   把 v1 项目迁移到 v2 布局
公共参数：--root PATH`

async function main() {
  const { positional, flags } = parse(process.argv.slice(2))
  const command = positional[0]
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE)
    return
  }
  const root = await resolveRoot(typeof flags.root === 'string' ? flags.root : undefined)
  switch (command) {
    case 'index':
      return await cmdIndex(root)
    case 'list':
      return await cmdList(root, flags)
    case 'show':
      if (!positional[1]) throw vaultErr('ERR_BAD_ARGS', '用法：vault show <name>')
      return await cmdShow(root, positional[1], flags)
    case 'diff':
      if (!positional[1]) throw vaultErr('ERR_BAD_ARGS', '用法：vault diff <name>')
      return await cmdDiff(root, positional[1], flags)
    case 'prune':
      return await cmdPrune(root, flags)
    case 'deprecate':
      if (!positional[1]) throw vaultErr('ERR_BAD_ARGS', '用法：vault deprecate <name> [--version N] [--reason 文本]')
      return await cmdDeprecate(root, positional[1], flags)
    case 'loop':
      return await cmdLoop(root, positional, flags)
    case 'export':
      return await cmdExport(root, flags)
    case 'layout':
      return await cmdLayout(root)
    case 'migrate':
      if (flags.to && flags.to !== 'v2') throw vaultErr('ERR_BAD_ARGS', '只支持 --to v2')
      return await cmdMigrate(root, flags)
    default:
      throw vaultErr('ERR_BAD_ARGS', `未知命令 ${command}\n${USAGE}`)
  }
}

// 只在作为入口直接运行时执行。
// 经 npm bin / ~/.local/bin 符号链接调用时 argv[1] 是链接路径，import.meta.url 是真实路径
// —— 必须比对 realpath，否则装好之后命令会静默什么都不做（与 lit-lib 同一处坑）。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  })
}

export { cmdIndex, cmdList, cmdShow, cmdDiff, cmdPrune, cmdDeprecate, cmdExport, lineStats, main }
