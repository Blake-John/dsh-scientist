// vault-commands —— 7 个斜杠命令（约定 loop 的入口）
//
// 设计见 docs/command-loops-plan.md：
//   · 命令用代码钉死入口契约与出口契约，中段交给 AI
//   · 每个命令创建 research/loops/<id>.json，并把固定 prompt 注入 agent
//   · 不用命令时本模块完全不参与（没有 loop 就没有任何强制）
//
// 不依赖宿主包：UserMessage 直接按 MessageBase 契约构造
// （id + role + content + source），与 createUserMessage 等价。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { nowISO, readJson, resolveRoot, slugify, withinRoot } from './vault-core.mjs'
import { closeLoop, createLoop, listLoops, LOOP_STATE_LABEL, readLoop } from './vault-loop-core.mjs'
import { ensureStudy } from './vault-study.mjs'

export const name = 'dsh-scientist-vault-commands'
export const inject = ['commands']

// ── 工具函数 ────────────────────────────────────────────────────────────────

const userMessage = (text) =>
  Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })

/** 解析 `arg1 arg2 --flag --key=value --key value` */
export function parseInput(raw) {
  const tokens = String(raw ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const words = []
  const flags = {}
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token.startsWith('--')) {
      words.push(token.replace(/^["']|["']$/g, ''))
      continue
    }
    const body = token.slice(2)
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=')
      flags[key] = rest.join('=')
    } else if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('--')) {
      flags[body] = tokens[i + 1].replace(/^["']|["']$/g, '')
      i += 1
    } else {
      flags[body] = true
    }
  }
  return { words, flags }
}

/** 会话的工作目录（命令没有 exec，只能从 session header 拿） */
export function sessionCwd(ctx, agent) {
  try {
    const sessions = ctx?.get?.('sessions')
    return sessions?.get?.(agent?.id)?.cwd ?? process.cwd()
  } catch {
    return process.cwd()
  }
}

const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// ── 命令定义 ────────────────────────────────────────────────────────────────

/**
 * 每个 loop 命令声明：
 *   plan(arg) → { requires[], checks[], workMin, maxNudges, artifacts[], mustContain[], steps[], skill }
 * requires/checks 使用 vault-loop-core 的校验 DSL。
 */
const LOOP_COMMANDS = [
  {
    name: 'survey',
    description: '领域调研闭环：边界→流派→时间线→对比→gap→切入点，产出 landscape 报告',
    usage: '<方向> [--no-init] [--dry-run]',
    skill: 'domain-survey',
    maxNudges: 3,
    plan(arg) {
      const slug = slugify(arg, 'topic')
      const artifact = `reports/landscape-${slug}.md`
      return {
        requires: [`file:${artifact}`, `min-citations:${artifact}:5`],
        checks: [`contains:${artifact}:gap`],
        workMin: 3,
        artifacts: [artifact],
        mustContain: ['≥5 条编号引用（[@key] 或 \\cite{key}）', '方法对比表', 'gap 清单'],
        steps: [
          '界定方向边界与子问题',
          '梳理流派与代表工作（每条带引用）',
          '时间线与方法/指标对比',
          '开放问题与 gap 清单',
          '最小切入点建议',
        ],
      }
    },
  },
  {
    name: 'paper',
    description: '精读一篇目标论文：取全文→画像→分节读→方法与结果→局限→笔记与 bib',
    usage: '<DOI|arXiv id|标题> [--no-init] [--dry-run]',
    skill: 'literature-retrieval',
    maxNudges: 3,
    plan(arg) {
      const key = slugify(arg, 'paper')
      const note = `literature/notes/${key}.md`
      return {
        requires: [`file:${note}`, `contains:${note}:方法|结果|局限`, `bib-entry:${key}`],
        checks: [],
        workMin: 2,
        artifacts: [note, 'literature/references.bib'],
        mustContain: ['方法', '结果', '局限 三节', `citekey = ${key}（笔记文件名与 bib 条目名一致）`],
        steps: [
          '取全文（lit_pdf）并先用 pdf_outline 画像',
          '分节精读：方法 / 结果 / 局限',
          '提炼可复用的方法与可质疑之处',
          '写笔记 literature/notes/<citekey>.md，并用 lit_bib 落 bib',
        ],
      }
    },
  },
  {
    name: 'derive',
    description: '推导/论证验证：形式化命题→可重跑脚本→量纲/数值/反例→文献对照→验证记录',
    usage: '<命题|流程|逻辑待推敲点> [--no-init] [--dry-run]',
    skill: 'derivation-lab',
    maxNudges: 5,
    plan(arg) {
      const id = slugify(arg, 'derivation')
      const dir = `derivations/${id}`
      return {
        requires: [`file:${dir}/derive.py`, `executable:${dir}/derive.py`, `file:${dir}/validation.md`],
        checks: [],
        workMin: 3,
        artifacts: [`${dir}/derive.py`, `${dir}/validation.md`],
        mustContain: ['至少一条可执行的验证记录（数值/量纲/反例）'],
        steps: [
          '把命题形式化（符号、假设、边界条件）',
          '写成可重跑脚本 derive.py',
          '多路验证：数值代入 / 量纲 / 极限 / 反例 / 文献对照',
          '把验证结果与不确定处写入 validation.md',
        ],
      }
    },
  },
  {
    name: 'write',
    description: '根据当前工作撰写报告/日志：读已有产物，成文并校验引用',
    usage: '[目标文件] [--no-init] [--dry-run]',
    argOptional: true,
    skill: null,
    maxNudges: 3,
    plan(arg) {
      const target = arg ? (arg.includes('/') ? arg : `reports/${slugify(arg, 'report')}.md`) : `reports/progress-${today()}.md`
      return {
        requires: [`file:${target}`],
        checks: ['cite-check-deep'],
        workMin: 0,
        artifacts: [target],
        mustContain: ['引用与论断一致', 'cite-check --deep 无错误'],
        steps: [
          '读 study.json 与 records 索引，确认要写什么',
          '引用已有产物时写明工件名与版本',
          '成文后跑 cite-check --deep 自查',
        ],
      }
    },
  },
  {
    name: 'review',
    description: '评审对象：提取论断→收集证据→核查→写评审记录',
    usage: '[对象] [--no-init] [--dry-run]',
    argOptional: true,
    skill: 'scientific-reviewer',
    maxNudges: 3,
    plan() {
      return {
        requires: ['reviews-since-open'],
        checks: [],
        workMin: 0,
        artifacts: ['research/study.json（reviews[]）'],
        mustContain: ['评审结论写入 study_review'],
        steps: [
          '确定评审对象（默认：所有未验证论断 + 无文献支撑的假设）',
          '收集证据：citekey + 工件 + 执行记录',
          '逐条核查，指出问题',
          '用 study_review 归档结论',
        ],
      }
    },
  },
]

// ── prompt 构造（C 方案：契约自包含 + 方法引用技能）────────────────────────

export function buildPrompt(spec, plan, loopId, arg) {
  const lines = [`/${spec.name} 已启动 · loop ${loopId}`, '']
  if (arg) lines.push(`目标：${arg}`, '')
  lines.push('## 出口契约（不满足不能关闭）')
  lines.push(`- 产物：${plan.artifacts.join('、')}`)
  if (plan.mustContain?.length) lines.push(`- 必须含：${plan.mustContain.join('；')}`)
  lines.push(`- 校验：vault loop close ${loopId} 会自动执行${plan.requires.length || plan.checks.length ? '' : '（无自动校验项）'}`)
  if (plan.workMin > 0) lines.push(`- 过程留痕：work ≥${plan.workMin} 条`)
  lines.push('')
  lines.push('## 步骤骨架（怎么做由你决定）')
  plan.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
  if (spec.skill) {
    lines.push('')
    lines.push(`方法细节：先加载 \`${spec.skill}\` 技能。`)
  }
  lines.push('')
  lines.push('## 记账')
  lines.push(`- 每完成一步：\`vault loop note ${loopId} "…"\``)
  lines.push(`- 全部完成：\`vault loop close ${loopId}\`（自动校验；不合格会被拒绝并列出缺项）`)
  lines.push(`- 判断做不成：\`vault loop close ${loopId} --failed --reason "…"\`（诚实失败优于凑数）`)
  return lines.join('\n')
}

// ── 状态渲染（/status）────────────────────────────────────────────────────

async function renderStatus(root) {
  const study = await readJson(join(root, 'research', 'study.json'), null)
  const loops = await listLoops(root)
  const records = await readJson(join(root, 'research', 'records', 'index.json'), { records: [] })
  const lines = []

  if (!study) {
    lines.push('（没有研究项目：research/study.json 不存在）')
  } else {
    const hyps = study.hypotheses ?? []
    const exps = study.experiments ?? []
    const claims = study.claims ?? []
    const noCite = hyps.filter((h) => !(h.citekeys ?? []).length)
    const noEvidence = claims.filter((c) => !(c.evidence?.citekeys ?? []).length && !(c.evidence?.records ?? []).length)
    lines.push(`${study.title || '未命名研究'}${study.autoCreated ? '（自动创建）' : ''}  阶段 ${study.loop?.phase ?? '?'} · 第 ${study.loop?.iteration ?? 0} 轮`)
    if (study.question?.text) lines.push(`问题：${study.question.text}`)
    lines.push(`假设 ${hyps.length} · 实验 ${exps.length} · 决策 ${(study.decisions ?? []).length} · 论断 ${claims.length} · 工件 ${(records.records ?? []).length}`)
  }

  const running = loops.filter((l) => l.status === 'running')
  if (running.length) {
    lines.push('', '进行中')
    for (const loop of running) {
      const failure = loop.exit?.lastFailure?.failures ?? []
      lines.push(`  ${loop.id}   work ${loop.work?.length ?? 0} 条${failure.length ? ` · 待补 ${failure.length} 项` : ''}`)
      for (const item of failure.slice(0, 3)) lines.push(`    · ${item}`)
    }
  }
  const stalled = loops.filter((l) => l.status === 'stalled')
  if (stalled.length) {
    lines.push('', '卡住（需你决定）')
    for (const loop of stalled) lines.push(`  ${loop.id}  → /status --abort ${loop.id} 或继续 note`)
  }

  if (study) {
    const todos = []
    const noCite = (study.hypotheses ?? []).filter((h) => !(h.citekeys ?? []).length)
    const noEvidence = (study.claims ?? []).filter((c) => !(c.evidence?.citekeys ?? []).length && !(c.evidence?.records ?? []).length)
    const noRecord = (study.experiments ?? []).filter((e) => !(e.records ?? []).length)
    if (noCite.length) todos.push(`假设无文献支撑：${noCite.map((h) => h.id).join(', ')}`)
    if (noEvidence.length) todos.push(`论断无证据：${noEvidence.map((c) => c.id).join(', ')}`)
    if (noRecord.length) todos.push(`实验无工件：${noRecord.map((e) => e.id).join(', ')}`)
    if (todos.length) {
      lines.push('', '待办（可校验）')
      for (const item of todos) lines.push(`  · ${item}`)
    }
  }

  const recent = (study?.loop?.history ?? []).slice(-3).reverse()
  if (recent.length) {
    lines.push('', '最近')
    for (const item of recent) lines.push(`  ${String(item.at ?? '').slice(11, 16)} ${item.detail ?? item.action ?? ''}`)
  }
  return lines.join('\n')
}

// ── 注册 ────────────────────────────────────────────────────────────────────

function makeLoopHandler(ctx, spec) {
  return async (invocation) => {
    const { words, flags } = parseInput(invocation.rawInput)
    const arg = words.join(' ').trim()
    if (!arg && !spec.argOptional) return { kind: 'error', text: `用法：/${spec.name} ${spec.usage}` }

    const cwd = sessionCwd(ctx, invocation.agent)
    const root = await resolveRoot(typeof flags.root === 'string' ? flags.root : cwd)

    // 入口：项目（可自动创建）
    let created = false
    if (!flags['no-init']) {
      const ensured = await ensureStudy(root, {
        title: arg || `${spec.name} 会话`,
        question: arg,
        autoCreated: true,
        origin: `/${spec.name} ${arg}`,
      })
      created = ensured.created
    } else {
      const existing = await readJson(join(root, 'research', 'study.json'), null)
      if (!existing) return { kind: 'error', text: '没有研究项目，且指定了 --no-init；先 /study-init' }
    }

    // 同类 loop 互斥
    const sameKind = (await listLoops(root, { status: 'running' })).filter((l) => l.kind === spec.name)
    if (sameKind.length) {
      return {
        kind: 'error',
        text: `已有 ${spec.name} loop 在跑（${sameKind[0].id}）；先 \`vault loop close\` 或 \`/status --abort\``,
      }
    }

    const plan = spec.plan(arg)
    if (flags['dry-run']) {
      return { kind: 'success', text: buildPrompt(spec, plan, '(dry-run)', arg) }
    }

    const loop = await createLoop(root, {
      kind: spec.name,
      arg,
      requires: plan.requires,
      checks: plan.checks,
      workMin: plan.workMin,
      maxNudges: spec.maxNudges,
      skill: spec.skill,
    })

    invocation.agent.followup(userMessage(buildPrompt(spec, plan, loop.id, arg)))

    const head = created ? `已自动创建研究项目「${arg}」\n` : ''
    return {
      kind: 'success',
      text: `${head}已启动 /${spec.name}（loop ${loop.id}）\n出口契约：${plan.artifacts.join('、')}${plan.workMin ? ` + work ≥${plan.workMin} 条` : ''}`,
    }
  }
}

export function apply(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    for (const spec of LOOP_COMMANDS) {
      commandCtx.commands.register({
        name: spec.name,
        description: spec.description,
        input: { hint: spec.usage },
        handler: makeLoopHandler(ctx, spec),
      })
    }

    // /study-init：不创建 loop，只建/更新项目
    commandCtx.commands.register({
      name: 'study-init',
      description: '初始化（或更新）科研项目：标题与核心问题',
      input: { hint: '[标题] [--question "…"]' },
      handler: async (invocation) => {
        const { words, flags } = parseInput(invocation.rawInput)
        const cwd = sessionCwd(ctx, invocation.agent)
        const root = await resolveRoot(typeof flags.root === 'string' ? flags.root : cwd)
        const title = words.join(' ').trim() || undefined
        const question = typeof flags.question === 'string' ? flags.question : undefined
        const { study, created } = await ensureStudy(root, {
          title,
          question,
          update: true,
          autoCreated: false,
          origin: '/study-init',
        })
        return {
          kind: 'success',
          text: created
            ? `✓ 已创建研究「${study.title}」\n  清单 research/study.json · 下一步 /survey 或 study_hypothesis`
            : `✓ 已更新研究「${study.title}」\n  核心问题：${study.question?.text || '（未设）'}`,
        }
      },
    })

    // /status：确定性渲染 + 可选 LLM 轻量复看
    commandCtx.commands.register({
      name: 'status',
      description: '查看当前进度；新会话可据此快速接手项目',
      input: { hint: '[loop-id] [--brief] [--abort <id>] [--json]' },
      handler: async (invocation) => {
        const { words, flags } = parseInput(invocation.rawInput)
        const cwd = sessionCwd(ctx, invocation.agent)
        const root = await resolveRoot(typeof flags.root === 'string' ? flags.root : cwd)

        // 逃生舱：/status --abort <id>
        if (typeof flags.abort === 'string') {
          const loop = await readLoop(root, flags.abort)
          const { abortLoop } = await import('./vault-loop-core.mjs')
          await abortLoop(root, loop.id, '用户通过 /status --abort 中止')
          return { kind: 'success', text: `✓ 已中止 ${loop.id}` }
        }

        const digest = await renderStatus(root)
        if (flags.json) {
          const loops = await listLoops(root)
          const study = await readJson(join(root, 'research', 'study.json'), null)
          return { kind: 'success', text: JSON.stringify({ study, loops }, null, 2) }
        }

        if (!flags.brief) {
          invocation.agent.followup(
            userMessage(
              [
                '（/status 复看）读 research/study.json 与 research/loops/*.json，用不超过 5 行回答：',
                '1) 当前最该做的一件事（一句话，可执行）',
                '2) 风险或异常（最多 2 条）',
                '不要复述状态表格，不要重复已知数字，不要罗列文件。',
              ].join('\n'),
            ),
          )
        }
        return { kind: 'success', text: digest }
      },
    })
  }, 'vault-commands')
}

export const __test__ = { LOOP_COMMANDS, buildPrompt, parseInput, renderStatus, makeLoopHandler }
