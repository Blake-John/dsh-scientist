#!/usr/bin/env node
/**
 * test-vault-study —— study_* 八个工具的测试（全离线）
 *
 * 覆盖：init 幂等 / 状态机约束 / citekey 软提醒 / 假设→实验→结论链路 /
 *       旧问题归档（F6）/ 历史溢出归档（F7）/ 决策日志 / 评审 / 阶段逐级回退（F10）/ 悬空引用
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vault-study.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const captured = []
apply({ tools: { register: (d) => (captured.push(d), () => {}) } })
const byName = Object.fromEntries(captured.map((d) => [d.name, d]))
const call = (n, a) => byName[n].execute(a, { signal: new AbortController().signal })
const expectErr = async (fn, re, label) => {
  const out = await fn().then(() => 'no-error', (e) => `${e.code ?? ''} ${e.message}`)
  ok(re.test(out), `${label}: ${out}`)
}

// ── 结构 ──
ok(captured.length === 9, `应注册 9 个工具，实际 ${captured.length}`)
for (const n of ['study_init','study_state','study_hypothesis','study_experiment','study_finding','study_decision','study_review','study_phase','study_claim']) {
  ok(byName[n], `缺少 ${n}`)
}

const root = await mkdtemp(join(tmpdir(), 'vault-study-'))
try {
  await mkdir(join(root, 'literature', 'notes'), { recursive: true })
  await writeFile(join(root, 'literature', 'notes', 'vaswani2017attention.md'), '---\ncitekey: vaswani2017attention\n---\n')

  // 未 init
  await expectErr(() => call('study_state', { root }), /ERR_NO_STUDY/, '未初始化应报错')

  // ── init ──
  const init1 = await call('study_init', { root, title: 'PINN 求解器', question: 'PINN 在小样本下能否达到 FEM 精度？' })
  ok(/已创建研究/.test(init1), `init 输出：${init1.slice(0,80)}`)
  const study0 = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study0.loop.phase === 'literature', '初始阶段 literature')
  ok(study0.loop.iteration === 1, '初始迭代 1')
  const init2 = await call('study_init', { root })
  ok(/已存在/.test(init2), 'init 幂等')

  // ── hypothesis ──
  const h1 = await call('study_hypothesis', { root, text: 'PINN 在 100 样本内误差 <5%', citekeys: ['vaswani2017attention'], rationale: '文献报告类似量级' })
  ok(/已登记假设 H1/.test(h1), `H1：${h1.slice(0,80)}`)
  const h2 = await call('study_hypothesis', { root, text: '种子会显著影响结果' })
  ok(/未给 citekeys/.test(h2), '缺 citekey 只警告')
  const h3 = await call('study_hypothesis', { root, text: 'x', citekeys: ['ghost2020nope'] })
  ok(/文献库里没有 ghost2020nope/.test(h3), '不存在的 citekey 只软提醒')

  let study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.hypotheses.length === 3, '3 条假设')
  ok(study.hypotheses[0].status === 'proposed', '初始 proposed')
  ok(study.loop.phase === 'hypothesis', '阶段推进到 hypothesis')

  // ── experiment ──
  const e1 = await call('study_experiment', { root, title: '正弦算例', hypothesis: 'H1', plan: ['生成数据', '训练', '评估'], seed: 42, expect: 'RMSE<0.05' })
  ok(/已登记实验 E01/.test(e1), `E01：${e1.slice(0,80)}`)
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.experiments[0].id === 'E01', '编号 E01')
  ok(study.hypotheses[0].status === 'testing', 'H1 自动转 testing')
  ok(study.hypotheses[0].experiments.includes('E01'), 'H1 记住实验')
  ok(study.loop.phase === 'experiment', '阶段推进到 experiment')
  await expectErr(() => call('study_experiment', { root, title: 'x', hypothesis: 'H9' }), /没有假设 H9/, '关联不存在的假设应报错')

  // ── finding ──
  await expectErr(() => call('study_finding', { root, experiment: 'E01' }), /至少给/, '空 finding 应报错')
  const f1 = await call('study_finding', { root, experiment: 'E01', finding: 'RMSE=0.03，好于预期', conclusion: 'supported' })
  ok(/H1 → supported/.test(f1), `结论：${f1.slice(0,120)}`)
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.hypotheses[0].status === 'supported', 'H1 → supported')
  ok(study.experiments[0].status === 'done', '实验 status=done')
  ok(Boolean(study.experiments[0].finishedAt), '实验有 finishedAt')
  ok(study.loop.phase === 'analysis', '阶段推进到 analysis')

  // 已 supported 的假设再给 conclusion 应被拒（只能 testing）
  await expectErr(() => call('study_finding', { root, experiment: 'E01', conclusion: 'refuted' }), /不能从 supported 变为 refuted/, '非法转移被拒')

  // ── F6：nextQuestion 归档旧问题 ──
  const before = study.question.text
  await call('study_finding', { root, experiment: 'E01', nextQuestion: '换到 2D 算例还成立吗？' })
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.question.text === '换到 2D 算例还成立吗？', '问题已更新')
  ok(study.question.history.length === 1, '旧问题被归档')
  ok(study.question.history[0].text === before, '归档的是旧问题原文')
  ok(study.loop.iteration === 2, '迭代 +1')

  // ── decision ──
  const d1 = await call('study_decision', { root, question: '用 PINN 还是 FEM？', chosen: 'PINN', alternatives: ['FEM'], rationale: '需要无网格反演', citekeys: ['vaswani2017attention'] })
  ok(/已登记决策 D1/.test(d1), 'D1 记录')
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.decisions[0].alternatives[0] === 'FEM', '决策记住备选')

  // ── review ──
  await call('study_hypothesis', { root, text: '待评审的假设' })   // H4 proposed
  const e2 = await call('study_experiment', { root, title: '评审用实验', hypothesis: 'H4', plan: ['训练'] })
  ok(/E02/.test(e2), 'E02 创建')
  const r1 = await call('study_review', { root, target: 'H4 的方法', verdict: 'refuted', hypothesis: 'H4', issues: ['基线太弱'] })
  ok(/已登记评审 R01/.test(r1), 'R01 记录')
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.hypotheses.find(h => h.id === 'H4').status === 'refuted', 'H4 → refuted')
  ok(study.hypotheses.find(h => h.id === 'H4').reviews.includes('R01'), '假设记住评审 id')

  // needs-work 不改状态
  await call('study_hypothesis', { root, text: '另一个假设' })
  const e3 = await call('study_experiment', { root, title: 'x', hypothesis: 'H5', plan: ['a'] })
  ok(/E03/.test(e3), 'E03')
  await call('study_review', { root, target: 'H5', verdict: 'needs-work', hypothesis: 'H5' })
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.hypotheses.find(h => h.id === 'H5').status === 'testing', 'needs-work 不改状态')

  await expectErr(() => call('study_review', { root, target: 'x', verdict: 'bogus' }), /verdict 必须是/, '非法 verdict 被拒')

  // ── phase 回退（F10）──
  // 此刻阶段应为 analysis
  await expectErr(() => call('study_phase', { root, phase: 'experiment' }), /必须给出 reason/, '回退必须给 reason')
  const back = await call('study_phase', { root, phase: 'experiment', reason: '发现实验设计有问题' })
  ok(/回退原因/.test(back), `逐级回退：${back}`)
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.loop.phase === 'experiment', '阶段已回退到 experiment')

  // 前进可以跳级
  const fwd = await call('study_phase', { root, phase: 'concluded' })
  ok(/concluded/.test(fwd), '可前跳多级')

  // 回退一次只能退一级
  await expectErr(() => call('study_phase', { root, phase: 'experiment', reason: '想退三步' }), /一次只能回退一个阶段/, '跨级回退被拒')
  const back2 = await call('study_phase', { root, phase: 'manuscript', reason: '还要补一章' })
  ok(/manuscript/.test(back2), '逐级回退到 manuscript')

  // ── claim（论断 ↔ 证据）──
  await expectErr(() => call('study_claim', { root, text: 'x', records: ['ghost@v1'] }), /工件不存在/, '指向不存在的工件应硬拒')
  const c1 = await call('study_claim', { root, text: 'PINN 在 100 样本内误差 <5%', citekeys: ['vaswani2017attention'], records: [] })
  ok(/已登记论断 C1/.test(c1), `C1：${c1.slice(0, 90)}`)
  ok(/文献证据：vaswani2017attention/.test(c1), '列出文献证据')
  const c2 = await call('study_claim', { root, text: '无证据的断言' })
  ok(/没有证据/.test(c2), '无证据论断给出警告')
  const c3 = await call('study_claim', { root, text: 'x', citekeys: ['ghost2020nope'] })
  ok(/文献库里没有 ghost2020nope/.test(c3), '论断的 citekey 也是软提醒')
  await expectErr(() => call('study_claim', { root, text: 'x', status: 'bogus' }), /status 必须是/, '非法状态被拒')

  // 更新已有论断
  const upd = await call('study_claim', { root, id: 'C2', text: '无证据的断言', status: 'supported' })
  ok(/已更新论断 C2 → supported/.test(upd), `更新：${upd.slice(0, 80)}`)
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  ok(study.claims.find(c => c.id === 'C2').status === 'supported', '论断状态已更新')
  ok(study.claims.find(c => c.id === 'C2').history.length === 2, '论断历史累积')
  await expectErr(() => call('study_claim', { root, id: 'C99', status: 'supported' }), /没有论断 C99/, '更新不存在的论断应报错')

  // ── INDEX.md（N6）──
  const idx = await readFile(join(root, 'research/INDEX.md'), 'utf8')
  ok(/# PINN 求解器/.test(idx), 'INDEX 含标题')
  ok(/## 假设/.test(idx) && /## 实验/.test(idx) && /## 决策/.test(idx), 'INDEX 含各分区')
  ok(/## 论断与证据/.test(idx), 'INDEX 含论断分区')
  ok(/R01/.test(idx), 'INDEX 含评审')
  ok(/⚠ 无/.test(idx), 'INDEX 标出无证据项')
  ok(/H1/.test(idx) && /E01/.test(idx), 'INDEX 含假设与实验编号')

  // ── state ──
  const st = await call('study_state', { root })
  ok(/PINN 求解器/.test(st), 'state 含标题')
  ok(/证据覆盖/.test(st), 'state 含证据覆盖')
  ok(/假设 5/.test(st), `state 假设计数：${st.match(/假设 \d+/)?.[0]}`)
  ok(/缺：H2, H3/.test(st) || /缺：/.test(st), 'state 列出无文献支撑的假设')
  const stDetail = await call('study_state', { root, detail: true })
  ok(/"schema": 1/.test(stDetail), 'detail 附 JSON')

  // 悬空引用：手工塞一个不存在的工件
  study = JSON.parse(await readFile(join(root, 'research/study.json'), 'utf8'))
  study.experiments[0].records.push('ghost-artifact@v9')
  await writeFile(join(root, 'research/study.json'), JSON.stringify(study, null, 2))
  const stDangling = await call('study_state', { root })
  ok(/指向不存在的工件 ghost-artifact@v9/.test(stDangling), '检出悬空工件引用')

  // ── F7：历史溢出归档 ──
  process.env.VAULT_HISTORY_CAP = '3'
  // 重新加载模块以读取新的 cap
  const mod2 = await import(`../vault-study.mjs?cap=3`)
  const cap2 = []
  mod2.apply({ tools: { register: (d) => (cap2.push(d), () => {}) } })
  const capped = Object.fromEntries(cap2.map((d) => [d.name, d]))
  const root2 = await mkdtemp(join(tmpdir(), 'vault-cap-'))
  try {
    await capped.study_init.execute({ root: root2, title: 'cap' }, {})
    for (let i = 0; i < 6; i += 1) {
      await capped.study_hypothesis.execute({ root: root2, text: `h${i}` }, {})
    }
    const s2 = JSON.parse(await readFile(join(root2, 'research/study.json'), 'utf8'))
    ok(s2.loop.history.length <= 3, `历史被裁剪到 ≤3，实际 ${s2.loop.history.length}`)
    const archived = await readFile(join(root2, 'research/loop-history.jsonl'), 'utf8').catch(() => '')
    ok(archived.split('\n').filter(Boolean).length > 0, '溢出历史写入 jsonl 归档')
  } finally {
    await rm(root2, { recursive: true, force: true })
    delete process.env.VAULT_HISTORY_CAP
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

if (problems.length) {
  console.error('✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✓ vault-study 测试通过（init/状态机/软提醒/归档/决策/评审/回退/悬空引用）')
