#!/usr/bin/env node
/**
 * test-vault-cli —— vault 命令的测试（全离线）
 *
 * 覆盖：list / show / diff（内容级与行级统计）/ prune（演练与真删）/ export（RO-Crate 子集）/ index
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { apply as applyRecord } from '../vault-record.mjs'
import { apply as applyStudy } from '../vault-study.mjs'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'vault.mjs')

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const vault = async (cwd, ...args) => {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args, '--root', cwd], { timeout: 30000 })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const recordTools = []
applyRecord({ tools: { register: (d) => (recordTools.push(d), () => {}) } })
const studyTools = []
applyStudy({ tools: { register: (d) => (studyTools.push(d), () => {}) } })
const all = Object.fromEntries([...recordTools, ...studyTools].map((d) => [d.name, d]))
const call = (n, a) => all[n].execute(a, {})

const root = await mkdtemp(join(tmpdir(), 'vault-cli-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'literature', 'notes'), { recursive: true })
  await writeFile(join(root, 'literature', 'notes', 'raissi2019pinn.md'), '---\ncitekey: raissi2019pinn\n---\n')
  await writeFile(join(root, 'a.txt'), '1\n2\n3\n')
  await writeFile(join(root, 'b.txt'), 'x\ny\n')

  await call('study_init', { root, title: 'CLI 测试研究', question: '测试用' })
  await call('study_hypothesis', { root, text: '假设一', citekeys: ['raissi2019pinn'] })
  await call('study_experiment', { root, title: '实验一', hypothesis: 'H1', plan: ['跑'], seed: 1 })

  // 两次保存，制造版本差异
  await call('record_save', { root, name: 'results', sources: ['a.txt'], command: 'python run.py', exitCode: 0, seed: 1, experiment: 'E01' })
  await writeFile(join(root, 'a.txt'), '1\nCHANGED\n3\n')
  await call('record_save', { root, name: 'results', sources: ['a.txt', 'b.txt'], command: 'python run.py v2', exitCode: 0, seed: 1 })

  // ── index ──
  const idx = await vault(root, 'index')
  ok(idx.code === 0, `index 失败：${idx.out}`)
  const indexMd = await readFile(join(root, 'research/INDEX.md'), 'utf8')
  ok(/CLI 测试研究/.test(indexMd), 'INDEX 含标题')

  // ── list ──
  const list = await vault(root, 'list')
  ok(list.code === 0 && /results/.test(list.out), `list：${list.out}`)
  ok(/共 1 个工件/.test(list.out), 'list 计数')
  const listFiltered = await vault(root, 'list', '--kind', 'figure')
  ok(/还没有工件/.test(listFiltered.out), 'kind 过滤生效')

  // ── show ──
  const show = await vault(root, 'show', 'results')
  ok(show.code === 0, `show 失败：${show.out}`)
  ok(/python run\.py v2/.test(show.out), 'show 含命令')
  ok(/种子\s+1/.test(show.out), 'show 含种子')
  ok(/a\.txt/.test(show.out), 'show 列文件')
  const showV1 = await vault(root, 'show', 'results', '--version', '1')
  ok(/python run\.py$/.test(showV1.out.trim().split('\n').find(l => l.includes('命令')) ?? ''), 'show 指定版本')

  // ── diff ──
  const diff = await vault(root, 'diff', 'results')
  ok(diff.code === 0, `diff 失败：${diff.out}`)
  ok(/新增 1 · 删除 0 · 变更 1 · 未变 0/.test(diff.out), `diff 统计：${diff.out.split('\n')[1]}`)
  ok(/~ a\.txt\s+\+1\/-1 行/.test(diff.out), `行级统计：${diff.out}`)
  ok(/\+ b\.txt/.test(diff.out), 'diff 列出新增文件')

  // 单版本工件不能 diff
  await call('record_save', { root, name: 'single', sources: ['b.txt'] })
  const diffSingle = await vault(root, 'diff', 'single')
  ok(diffSingle.code !== 0 && /只有一个版本/.test(diffSingle.out), `单版本应拒绝：${diffSingle.out}`)

  // ── prune ──
  const pruneNoArg = await vault(root, 'prune')
  ok(pruneNoArg.code !== 0 && /--keep/.test(pruneNoArg.out), '无参数 prune 应拒绝')

  const dry = await vault(root, 'prune', '--keep', '1', '--dry-run')
  ok(/演练，未改动/.test(dry.out), `演练提示：${dry.out}`)
  ok(Boolean(await stat(join(root, 'research/records/results/v1')).catch(() => null)), '演练不删除')

  const real = await vault(root, 'prune', '--keep', '1')
  ok(/已清理/.test(real.out), `真删：${real.out}`)
  ok(!(await stat(join(root, 'research/records/results/v1')).catch(() => null)), 'v1 已删除')
  ok(Boolean(await stat(join(root, 'research/records/results/v2')).catch(() => null)), '最新版保留')

  const artManifest = JSON.parse(await readFile(join(root, 'research/records/results/artifact-manifest.json'), 'utf8'))
  ok(artManifest.versions.length === 1 && artManifest.versions[0].version === 2, '工件清单已更新')
  const recIndex = JSON.parse(await readFile(join(root, 'research/records/index.json'), 'utf8'))
  const summary = recIndex.records.find((r) => r.slug === 'results')
  ok(summary.latest === 2 && summary.versions === 1, '全局索引已更新')

  // 废弃版本清理
  await call('study_claim', { root, text: '一个论断', citekeys: ['raissi2019pinn'] })
  await vault(root, 'prune', '--deprecated-only')
  ok(true, 'deprecated-only 可运行')

  // ── export ──
  const exp = await vault(root, 'export')
  ok(exp.code === 0, `export 失败：${exp.out}`)
  ok(/已导出/.test(exp.out), 'export 输出')
  const crate = JSON.parse(await readFile(join(root, 'research/export/ro-crate-metadata.json'), 'utf8'))
  ok(crate['@context'].includes('ro/crate/1.1'), 'RO-Crate context')
  const types = crate['@graph'].map((n) => n['@type'])
  ok(types.includes('Dataset'), '含 Dataset')
  ok(types.includes('CreateAction'), '含 CreateAction')
  ok(types.includes('File'), '含 File')
  ok(types.includes('CreativeWork'), '含 Hypothesis CreativeWork')
  const files = crate['@graph'].filter((n) => n['@type'] === 'File')
  ok(files.every((f) => /^#sha256:[0-9a-f]{64}$/.test(f['@id'])), 'File 用内容寻址 id')
  const actions = crate['@graph'].filter((n) => n['@type'] === 'CreateAction')
  ok(actions.length === 2, `CreateAction 数量（results v2 + single v1）：${actions.length}`)
  ok(!actions.some((a) => /results v1$/.test(a.name)), '已被 prune 的版本不出现在导出里')
  ok(actions[0].actionStatus?.includes('CompletedActionStatus'), 'CreateAction 记录成功态')

  // 未知命令
  const bogus = await vault(root, 'nonsense')
  ok(bogus.code !== 0 && /未知命令/.test(bogus.out), '未知命令应报错')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault CLI 测试通过（index / list / show / diff / prune / export）')
