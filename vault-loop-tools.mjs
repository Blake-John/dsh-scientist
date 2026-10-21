// vault-loop-tools —— loop 记账工具（2 个）
//
// 为什么必须有工具而不是只靠 `vault` CLI：
//   loop 机制每一步都依赖"记账"和"关闭"，而 CLI 需要 PATH 安装、
//   模型也不一定知道该怎么调。工具带 schema，模型能直接看到。
//
//   loop_note   每完成一步记一笔（同时刷新 lastActivity、复活 stalled）
//   loop_close  跑出口校验；不合格会被拒绝并返回缺项；也可声明失败（须给原因）
//
// 查询类操作（list/show）不单独给工具：/status 命令与 pre-step 提醒已经覆盖。

import { optStr, resolveRoot, vaultErr } from './vault-core.mjs'
import { closeLoop, listLoops, noteLoop, readLoop, renderLoop, verifyExit } from './vault-loop-core.mjs'

export const name = 'dsh-scientist-vault-loop-tools'
export const inject = ['tools']

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

/**
 * 解析目标 loop：给了 id 用它；否则优先最近的 running，其次 stalled
 * （stalled 也要能被 loop_note 复活，否则卡住的 loop 就再也动不了）。
 */
async function resolveLoop(root, id) {
  if (id) return await readLoop(root, id)
  const all = await listLoops(root)
  const running = all.find((loop) => loop.status === 'running')
  if (running) return running
  const stalled = all.find((loop) => loop.status === 'stalled')
  if (stalled) return stalled
  throw vaultErr('ERR_NOT_FOUND', '当前没有进行中或卡住的 loop')
}

async function cmdNote(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const loop = await resolveLoop(root, optStr(args, 'loop_id'))
  const note = optStr(args, 'note')
  if (!note) throw vaultErr('ERR_BAD_ARGS', 'note 不能为空')
  const updated = await noteLoop(root, loop.id, note)
  const lines = [`✓ 已记账（${updated.id}）· work ${updated.work.length} 条`, `  ${note}`]
  if (updated.status === 'running' && loop.status === 'stalled') lines.push('  （已从 stalled 复活，拦停预算重置）')
  return lines.join('\n')
}

async function cmdClose(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const loop = await resolveLoop(root, optStr(args, 'loop_id'))
  const failed = args.failed === true
  const reason = optStr(args, 'reason')

  try {
    const closed = await closeLoop(root, loop.id, { failed, reason })
    if (closed.status === 'closed') {
      return [`✓ loop ${closed.id} 已关闭（完成）`, `  产物校验通过 · work ${closed.work.length} 条`].join('\n')
    }
    return [`✓ loop ${closed.id} 已标记为「未完成」`, `  原因：${closed.failReason}`].join('\n')
  } catch (error) {
    if (error.code === 'ERR_EXIT_UNMET') {
      const { failures } = await verifyExit(root, await readLoop(root, loop.id))
      return [
        `✗ 出口契约未满足（loop 保持 running）`,
        ...failures.map((item) => `  · ${item}`),
        `补完后重试；判断做不成：loop_close(failed=true, reason="…")`,
      ].join('\n')
    }
    throw error
  }
}

async function cmdStatus(args, exec) {
  const root = await resolveRoot(optStr(args, 'root', exec?.cwd))
  const id = optStr(args, 'loop_id')
  if (id) {
    const loop = await readLoop(root, id)
    const { ok, failures } = await verifyExit(root, loop)
    return `${renderLoop(loop)}\n\n出口契约：${ok ? '已满足（可 close）' : `未满足\n  · ${failures.join('\n  · ')}`}`
  }
  const loops = await listLoops(root)
  if (!loops.length) return '（没有 loop）'
  return loops.map((loop) => `${loop.id}  [${loop.status}]  work ${loop.work?.length ?? 0} 条`).join('\n')
}

export function apply(ctx) {
  ctx.tools.register(
    tool({
      name: 'loop_note',
      description:
        '为当前约定 loop 记一笔工作进展（每完成一步就记）。会刷新活动时间；若 loop 处于 stalled，记账会让它复活并重置拦停预算。' +
        'loop_id 可省略，默认取最近一个进行中的 loop。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loop_id: { type: 'string' },
          note: { type: 'string' },
          root: { type: 'string' },
        },
        required: ['note'],
      },
      presentTitle: 'Loop 记账',
      execute: cmdNote,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'loop_close',
      description:
        '关闭当前约定 loop：自动执行出口契约校验（产物、引用数、work 条数、cite-check 等），' +
        '不合格会被拒绝并列出缺项、loop 保持 running。判断确实做不成时用 failed=true 并给出 reason（诚实失败优于凑数）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loop_id: { type: 'string' },
          failed: { type: 'boolean' },
          reason: { type: 'string' },
          root: { type: 'string' },
        },
      },
      presentTitle: '关闭 Loop',
      execute: cmdClose,
    }),
  )

  ctx.tools.register(
    tool({
      name: 'loop_status',
      description: '查看 loop 进度与出口契约差距。给 loop_id 看单个，省略则列出全部。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { loop_id: { type: 'string' }, root: { type: 'string' } },
      },
      presentTitle: 'Loop 状态',
      execute: cmdStatus,
    }),
  )
}

export const __test__ = { cmdNote, cmdClose, cmdStatus, resolveLoop }
