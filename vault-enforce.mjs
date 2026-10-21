// vault-enforce —— 约定 loop 的强制执行层
//
// 只在**存在进行中 loop** 时生效；没有 loop 时三个钩子全部立即返回，零影响。
//
//   ① agent/pre-step      每步注入"还差什么"（读 loop.exit.lastFailure）
//   ② agent/turn-stopping 未完成不许收尾：塞一条 next-step 让循环继续
//                         （packages/core/agent-loop/src/agent.ts:361-365 会再查一次
//                          inbox.nextStep，非空则不 break）
//                         超过 maxNudges 次 → 置 stalled 并放行
//   ③ tools/guard         禁止直接改 research/loops/**（防作弊：必须走 `vault loop`）
//
// 重要：preset 行是"标准组合"只挂一次，多个 agent 共享同一实例
// （packages/preset/agent-preset-registry/src/mount.ts 的 standing scope），
// 因此所有状态都必须按 agent 寻址，不能用模块级变量记住"当前 agent"。
// 事件 payload 由 dispatch 的 fused() 自动注入 agent（packages/core/agent/src/dispatch.ts:113）。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resolveRoot } from './vault-core.mjs'
import { activeLoop, bumpNudge, stallLoop } from './vault-loop-core.mjs'

export const name = 'dsh-scientist-vault-enforce'
export const inject = ['tools']

const userMessage = (text) =>
  Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })

const WRITE_TOOLS = new Set(['write', 'edit', 'bash'])

/** 命中 research/loops/ 的写入意图（bash 只在出现写操作特征时判定） */
export function touchesLoopDir(toolName, args) {
  let text = ''
  try {
    text = JSON.stringify(args ?? {})
  } catch {
    return false
  }
  if (!text.includes('research/loops')) return false
  if (toolName === 'write' || toolName === 'edit') return true
  // bash：只拦写入类动作，读（cat/less/grep）不拦
  return /(^|[^0-9])>>?\s*\S|tee\s|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btruncate\b|\bpython3?\s+-c/.test(text)
}

export function nudgeText(loop) {
  const failures = loop.exit?.lastFailure?.failures ?? []
  const lines = [`（loop ${loop.id} 尚未完成，不能就此结束）`]
  if (failures.length) {
    lines.push('还差：')
    for (const item of failures) lines.push(`· ${item}`)
  } else {
    lines.push('还差：出口契约尚未校验通过（产物或 work 记录不足）')
  }
  lines.push('继续完成；判断做不成时调用 loop_close(failed=true, reason="…")')
  return lines.join('\n')
}

export function reminderText(loop) {
  const failures = loop.exit?.lastFailure?.failures ?? []
  if (!failures.length) return null
  return [
    `（loop ${loop.id} 出口契约未满足）`,
    ...failures.map((item) => `· ${item}`),
    '完成后调用 loop_close()',
  ].join('\n')
}

export function apply(ctx) {
  // 每个 agent 的工作目录缓存（sessions 服务按 agent.id 查）
  const rootCache = new Map()

  const rootFor = async (agent) => {
    const id = agent?.id
    if (!id) return null
    if (rootCache.has(id)) return rootCache.get(id)
    let cwd = process.cwd()
    try {
      cwd = ctx.get?.('sessions')?.get?.(id)?.cwd ?? cwd
    } catch {
      /* 没有 sessions 服务时退回进程 cwd */
    }
    const root = await resolveRoot(cwd).catch(() => null)
    if (root) rootCache.set(id, root)
    return root
  }

  // ① 每步注入"还差什么"
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const root = await rootFor(agent)
    if (!root) return decision
    const loop = await activeLoop(root).catch(() => null)
    if (!loop) return decision
    const reminder = reminderText(loop)
    if (!reminder) return decision
    return { kind: 'enter', messages: [...decision.messages, userMessage(reminder)] }
  })

  // ② 未完成不许收尾
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const root = await rootFor(agent)
    if (!root) return
    const loop = await activeLoop(root).catch(() => null)
    if (!loop) return
    if ((loop.nudges ?? 0) >= (loop.maxNudges ?? 3)) {
      await stallLoop(root, loop.id, `拦停 ${loop.nudges} 次仍未通过出口校验`).catch(() => {})
      return
    }
    const updated = await bumpNudge(root, loop.id).catch(() => null)
    if (!updated) return
    agent.send(userMessage(nudgeText(updated)), 'next-step', false)
  })

  // ③ 防作弊：禁止直接改 loop 文件
  ctx.tools.guard((exec) => {
    if (!WRITE_TOOLS.has(exec.name)) return undefined
    if (touchesLoopDir(exec.name, exec.arguments)) {
      return 'research/loops/** 只能通过 `vault loop` 子命令修改（防篡改 loop 状态）'
    }
    return undefined
  })
}

export const __test__ = { rootFor: null, nudgeText, reminderText, touchesLoopDir }
