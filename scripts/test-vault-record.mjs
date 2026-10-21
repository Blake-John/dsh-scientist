#!/usr/bin/env node
/**
 * test-vault-record —— record_* 三个工具的测试（全离线）
 *
 * 覆盖：工件保存/版本递增/硬链接去重/失败运行留痕/种子与原始数据告警/
 *       env 记录、verify（缺失/被改/多余文件/漂移/警告）、reproduce（命令与输入预检）
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vault-record.mjs'

const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const captured = []
apply({ tools: { register: (d) => (captured.push(d), () => {}) } })
const byName = Object.fromEntries(captured.map((d) => [d.name, d]))
const call = (name, args) => byName[name].execute(args, { signal: new AbortController().signal })

// ── 结构 ────────────────────────────────────────────────────────────────────
ok(captured.length === 3, `应注册 3 个工具，实际 ${captured.length}`)
for (const expected of ['record_save', 'record_verify', 'record_reproduce']) {
  ok(byName[expected], `缺少工具 ${expected}`)
}
for (const def of captured) {
  ok(typeof def.description === 'string' && def.description.length >= 30, `${def.name}: description 过短（${def.description?.length}）`)
  ok(def.parameters?.type === 'object', `${def.name}: parameters 非 object`)
  ok(typeof def.output?.render === 'function', `${def.name}: 缺 output.render`)
  ok(typeof def.presentCall === 'function', `${def.name}: 缺 presentCall`)
}

const root = await mkdtemp(join(tmpdir(), 'vault-record-'))
try {
  await mkdir(join(root, 'research'), { recursive: true })
  await mkdir(join(root, 'data', 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(root, 'data', 'a.csv'), 'x,y\n1,2\n')
  await writeFile(join(root, 'data', 'b.csv'), 'x,y\n3,4\n')
  await writeFile(join(root, 'data', 'plot.py'), '# plot.py\n')
  await writeFile(join(root, 'data', 'node_modules', 'junk', 'i.js'), 'ignored')
  await writeFile(join(root, 'envs.lock.yml'), 'python: 3.11.9\n')

  // ── 首次保存 ──────────────────────────────────────────────────────────────
  const out1 = await call('record_save', {
    root,
    name: 'Loss Curve',
    sources: ['data'],
    description: '训练损失曲线',
    kind: 'figure',
    command: 'python train.py --seed 42',
    exitCode: 0,
    durationMs: 8412,
    seed: 42,
    env: 'envs.lock.yml',
    raw: ['data/a.csv'],
    citekeys: ['vaswani2017attention'],
    tags: ['ch2'],
  })
  ok(/已保存 Loss Curve → v1/.test(out1), `保存输出异常：${out1.slice(0, 120)}`)
  ok(/硬链接去重/.test(out1), '输出含去重统计')
  ok(/种子 42/.test(out1), '输出含种子')

  const manifest1 = JSON.parse(await readFile(join(root, 'research/records/loss-curve/v1/manifest.json'), 'utf8'))
  ok(manifest1.version === 1, '版本号 1')
  ok(manifest1.activity.actionStatus === 'CompletedActionStatus', `成功态：${manifest1.activity.actionStatus}`)
  ok(manifest1.activity.seed === 42, '种子落库')
  ok(manifest1.activity.durationMs === 8412, '耗时落库')
  ok(typeof manifest1.activity.runtime?.node === 'string', '运行时快照')
  ok(manifest1.activity.env?.sha256?.length === 64, 'env 哈希')
  ok(manifest1.inputs.length === 3, `只保存 3 个文件（node_modules 被忽略），实际 ${manifest1.inputs.length}`)
  ok(manifest1.raw.length === 1, 'raw 记录')
  ok(manifest1.links.citekeys[0] === 'vaswani2017attention', 'citekey 关联')

  // 失败运行也要留痕
  await call('record_save', {
    root, name: 'failing run', sources: ['data/a.csv'],
    command: 'python boom.py', exitCode: 1, seed: 1,
  })
  const failed = JSON.parse(await readFile(join(root, 'research/records/failing-run/v1/manifest.json'), 'utf8'))
  ok(failed.activity.actionStatus === 'FailedActionStatus', '非零退出码记为失败态')
  ok(failed.activity.exitCode === 1, '退出码落库')

  // ── 同内容再存一版 → 硬链接去重 ───────────────────────────────────────────
  await call('record_save', { root, name: 'Loss Curve', sources: ['data'], kind: 'figure', raw: ['data/a.csv'], seed: 7 })
  const inoV1 = (await stat(join(root, 'research/records/loss-curve/v1/files/a.csv'))).ino
  const inoV2 = (await stat(join(root, 'research/records/loss-curve/v2/files/a.csv'))).ino
  ok(inoV1 === inoV2, '相同内容跨版本硬链接（inode 相同）')
  const manifest2 = JSON.parse(await readFile(join(root, 'research/records/loss-curve/v2/manifest.json'), 'utf8'))
  ok(manifest2.version === 2, '版本递增')

  // ── verify（干净版本，必须在改 raw/脚本之前）────────────────────────────
  const v1 = await call('record_verify', { root, name: 'Loss Curve', version: 1 })
  ok(v1.status === 'ok', `干净版本应 ok，实际 ${v1.status}（warnings=${JSON.stringify(v1.warnings)}）`)
  ok(v1.checked === 3, `校验 3 个文件，实际 ${v1.checked}`)
  ok(v1.figureTrace?.ok === true, `图三向追溯应通过：${JSON.stringify(v1.figureTrace)}`)
  ok(v1.figureTrace.raw.every((x) => x.status === 'ok'), `raw 应全部一致：${JSON.stringify(v1.figureTrace.raw)}`)
  ok(v1.figureTrace.scripts.some((x) => x.status === 'ok'), `出图脚本应一致：${JSON.stringify(v1.figureTrace.scripts)}`)

  // 内容变了 → 不硬链接
  await writeFile(join(root, 'data', 'a.csv'), 'x,y\n9,9\n')
  await call('record_save', { root, name: 'Loss Curve', sources: ['data'], seed: 7 })
  const inoV3 = (await stat(join(root, 'research/records/loss-curve/v3/files/a.csv'))).ino
  ok(inoV3 !== inoV1, '内容变化时不复用硬链接')

  // ── 图三向追溯：raw 变更 / 出图脚本变更 → incomplete ─────────────────────
  const rawTamper = await call('record_verify', { root, name: 'Loss Curve', version: 1 })
  ok(rawTamper.figureTrace.raw.some((x) => x.status === 'mismatch'), `raw 变更应检出：${JSON.stringify(rawTamper.figureTrace)}`)
  ok(rawTamper.status === 'incomplete', `raw 变更应 incomplete：${rawTamper.status}`)
  await writeFile(join(root, 'data', 'plot.py'), '# changed\n')
  const scriptTamper = await call('record_verify', { root, name: 'Loss Curve', version: 1 })
  ok(scriptTamper.figureTrace.scripts.some((x) => x.status === 'mismatch'), `脚本变更应检出：${JSON.stringify(scriptTamper.figureTrace)}`)
  ok(scriptTamper.status === 'incomplete', `脚本变更应 incomplete：${scriptTamper.status}`)

  // ── 不同源含同名文件：不得静默覆盖 ──
  await mkdir(join(root, 'data2'), { recursive: true })
  await writeFile(join(root, 'data2', 'a.csv'), 'x,y\n8,8\n')   // 与 data/a.csv 同名且内容不同
  const outCollide = await call('record_save', { root, name: 'collide demo', sources: ['data', 'data2'], seed: 3 })
  ok(/同名冲突已消解/.test(outCollide), `应提示冲突消解：${outCollide.slice(0, 200)}`)
  const collide = JSON.parse(await readFile(join(root, 'research/records/collide-demo/v1/manifest.json'), 'utf8'))
  const paths = collide.inputs.map((f) => f.path)
  ok(new Set(paths).size === paths.length, `清单路径必须唯一：${JSON.stringify(paths)}`)
  const shas = new Set(collide.inputs.map((f) => f.sha256))
  ok(shas.size === collide.inputs.length, '两个同名不同内容的文件都要保住（哈希各不相同）')
  for (const f of collide.inputs) {
    const disk = await readFile(join(root, 'research/records/collide-demo/v1/files', f.path))
    const { createHash } = await import('node:crypto')
    ok(createHash('sha256').update(disk).digest('hex') === f.sha256, `${f.path} 落盘内容与清单哈希一致`)
  }
  const collideVerify = await call('record_verify', { root, name: 'collide demo' })
  ok(collideVerify.status === 'ok', `冲突消解后校验应 ok，实际 ${collideVerify.status}：${JSON.stringify(collideVerify.issues ?? collideVerify.mismatches)}`)

  // ── verify（破坏性用例另起工件，避免污染 v1）────────────────────────────
  await call('record_save', {
    root, name: 'tamper demo', sources: ['data'],
    command: 'python demo.py', exitCode: 0, seed: 7, env: 'envs.lock.yml',
  })

  // 多余文件
  await writeFile(join(root, 'research/records/tamper-demo/v1/files/extra.txt'), 'sneaky')
  const withExtra = await call('record_verify', { root, name: 'tamper demo' })
  ok(withExtra.status === 'extra', `多余文件应 status=extra，实际 ${withExtra.status}`)
  ok(withExtra.extras.includes('extra.txt'), `extras 含 extra.txt：${JSON.stringify(withExtra.extras)}`)
  await rm(join(root, 'research/records/tamper-demo/v1/files/extra.txt'))

  // 被篡改
  const originalA = await readFile(join(root, 'research/records/tamper-demo/v1/files/a.csv'), 'utf8')
  await writeFile(join(root, 'research/records/tamper-demo/v1/files/a.csv'), 'tampered')
  const tamp = await call('record_verify', { root, name: 'tamper demo' })
  ok(tamp.status === 'mismatch', `篡改应 mismatch，实际 ${tamp.status}`)
  ok(tamp.mismatches[0]?.path === 'a.csv', 'mismatches 指向 a.csv')
  await writeFile(join(root, 'research/records/tamper-demo/v1/files/a.csv'), originalA)

  // 缺失
  const bPath = join(root, 'research/records/tamper-demo/v1/files/b.csv')
  const bBackup = await readFile(bPath)
  await rm(bPath)
  const miss = await call('record_verify', { root, name: 'tamper demo' })
  ok(miss.missing.includes('b.csv'), `missing 含 b.csv：${JSON.stringify(miss.missing)}`)
  await writeFile(bPath, bBackup)

  // env 漂移
  await writeFile(join(root, 'envs.lock.yml'), 'python: 3.12.0\n')
  const drift = await call('record_verify', { root, name: 'tamper demo' })
  ok(drift.env?.status === 'changed', `env 漂移应 changed，实际 ${JSON.stringify(drift.env)}`)
  ok(drift.warnings.some((w) => w.includes('环境')), 'env 漂移进 warnings')

  // 无种子的运行 → 警告
  await call('record_save', { root, name: 'no seed', sources: ['data/b.csv'], command: 'python x.py', exitCode: 0 })
  const noSeed = await call('record_verify', { root, name: 'no seed' })
  ok(noSeed.warnings.some((w) => w.includes('随机种子')), `应提示缺种子：${JSON.stringify(noSeed.warnings)}`)

  // figure 无 raw → 警告
  await call('record_save', { root, name: 'bare figure', sources: ['data/b.csv'], kind: 'figure', seed: 1 })
  const bareFig = await call('record_verify', { root, name: 'bare figure' })
  ok(bareFig.warnings.some((w) => w.includes('原始数据')), `应提示缺 raw：${JSON.stringify(bareFig.warnings)}`)

  // ── reproduce（v1 有完整元数据）──────────────────────────────────────────
  const guide = await call('record_reproduce', { root, name: 'Loss Curve', version: 1 })
  ok(/python train\.py --seed 42/.test(guide), `复现指引含命令：${guide.slice(0, 160)}`)
  ok(/随机种子：42/.test(guide), '复现指引含种子值')
  ok(/## 环境/.test(guide), '复现指引含环境段')
  ok(/## 文件（回查原路径/.test(guide), '复现指引含文件回查段')
  ok(/哈希一致/.test(guide), '输入哈希一致时应标注')

  // 输入被改动 → 指引应标出
  await writeFile(join(root, 'data', 'a.csv'), 'x,y\n777,777\n')
  const guide2 = await call('record_reproduce', { root, name: 'Loss Curve', version: 1 })
  ok(/内容已变更/.test(guide2), '输入变动应在指引中标出')

  // ── 错误路径 ──────────────────────────────────────────────────────────────
  const notFound = await call('record_verify', { root, name: '不存在的工件' }).then(
    () => 'no-error',
    (e) => e.message,
  )
  ok(/工件不存在/.test(notFound), `不存在的工件应报错：${notFound}`)

  const noSources = await call('record_save', { root, name: 'x' }).then(
    () => 'no-error',
    (e) => e.message,
  )
  ok(/sources/.test(noSources), `缺 sources 应报错：${noSources}`)

  // 目录穿越
  const escape = await call('record_save', { root, name: 'esc', sources: ['../etc'] }).then(
    () => 'no-error',
    (e) => e.message,
  )
  ok(/越出项目根/.test(escape), `应拒绝目录穿越：${escape}`)
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-record 测试通过（保存/去重/失败留痕/校验/复现指引）')
