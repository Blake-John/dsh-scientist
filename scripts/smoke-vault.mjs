#!/usr/bin/env node
/**
 * smoke-vault —— 挂载冒烟（不启动服务，但走真实注册路径）
 *
 * 1) 用包名自引用解析（与 profile loader 同一条 exports 路径）导入三个模块
 * 2) 对每个模块真跑 apply(ctx)，用一个会校验工具契约的注册表
 * 3) 检查工具名唯一、描述非空、参数是 object、output.render 可调用
 * 4) 统计工具定义体量（上下文成本）
 */
const problems = []
const ok = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const ROWS = [
  ['dsh-scientist/vault-record.mjs', 'vault-record'],
  ['dsh-scientist/vault-study.mjs', 'vault-study'],
  ['dsh-scientist/lit-tools.mjs', 'lit-tools'],
  ['dsh-scientist/pdf-tools.mjs', 'pdf-tools'],
]

const registered = []
const makeCtx = () => {
  const tools = {
    register(definition) {
      // 模拟真实注册表的校验
      if (!definition?.name || typeof definition.name !== 'string') throw new Error('工具缺少 name')
      if (!definition.description || definition.description.length < 20) throw new Error(`${definition.name}: description 过短`)
      if (definition.parameters?.type !== 'object') throw new Error(`${definition.name}: parameters 必须是 object`)
      if (typeof definition.output?.render !== 'function') throw new Error(`${definition.name}: 缺少 output.render`)
      if (registered.some((t) => t.name === definition.name)) throw new Error(`工具重名: ${definition.name}`)
      registered.push(definition)
      return () => {}
    },
  }
  const noop = () => () => {}
  return {
    tools,
    on: noop,
    effect: noop,
    inject: () => {},
    provide: () => {},
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: () => undefined,
    set: () => {},
    root: { tools },
  }
}

const byRow = {}
for (const [specifier, label] of ROWS) {
  let mod
  try {
    // 包名自引用：与 loader 的解析路径一致（走 package.json exports）
    mod = await import(specifier)
  } catch (error) {
    problems.push(`${label}: 无法按包名解析（${error.code ?? error.message}）`)
    continue
  }
  ok(typeof mod.apply === 'function', `${label}: 没有导出 apply`)
  const before = registered.length
  try {
    mod.apply(makeCtx())
  } catch (error) {
    problems.push(`${label}: apply() 抛错 —— ${error.message}`)
    continue
  }
  byRow[label] = registered.length - before
}

const total = registered.length
const EXPECTED = { 'vault-record': 3, 'vault-study': 9, 'lit-tools': 4, 'pdf-tools': 2 }
ok(total === 18, `应注册 18 个工具（3+9+4+2），实际 ${total}`)
for (const [label, want] of Object.entries(EXPECTED)) {
  ok(byRow[label] === want, `${label} 应注册 ${want} 个，实际 ${byRow[label]}`)
}

// 描述体量（上下文成本）
const bytes = registered.reduce((sum, t) => sum + Buffer.byteLength(t.description, 'utf8'), 0)
const paramBytes = registered.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t.parameters), 'utf8'), 0)
const tokens = Math.round((bytes + paramBytes) / 3.5)

console.log('工具注册冒烟：')
for (const [label, count] of Object.entries(byRow)) console.log(`  ${label.padEnd(14)} ${count} 个`)
console.log(`  合计 ${total} 个`)
console.log('')
console.log('工具清单：')
for (const t of registered) console.log(`  ${t.name.padEnd(18)} ${t.description.slice(0, 46)}…`)
console.log('')
console.log(`定义体量：描述 ${bytes} 字符 + 参数 ${paramBytes} 字符 ≈ ${tokens} tokens/请求常驻`)
console.log(`对照：dsh-science 31 个工具 ≈ 1941 tokens（本包 12 个）`)

// ── 命令与强制层：同样按包名解析并真跑 apply() ──
const commands = []
const hooks = {}
const guards = []
const fakeCtx = {
  inject: (_deps, cb) => cb({ commands: { register: (def) => { commands.push(def); return () => {} } } }),
  on: (event, handler) => { hooks[event] = handler; return () => {} },
  tools: { guard: (fn) => { guards.push(fn); return () => {} }, register: () => () => {} },
  get: (name) => (name === 'sessions' ? { get: () => ({ cwd: process.cwd() }) } : undefined),
}

for (const [specifier, label] of [
  ['dsh-scientist/vault-commands.mjs', 'vault-commands'],
  ['dsh-scientist/vault-enforce.mjs', 'vault-enforce'],
]) {
  let mod
  try {
    mod = await import(specifier)
  } catch (error) {
    problems.push(`${label}: 无法按包名解析（${error.code ?? error.message}）`)
    continue
  }
  ok(typeof mod.apply === 'function', `${label}: 没有导出 apply`)
  try {
    mod.apply(fakeCtx)
  } catch (error) {
    problems.push(`${label}: apply() 抛错 —— ${error.message}`)
  }
}

const commandNames = commands.map((d) => d.name).sort()
ok(commands.length === 7, `应注册 7 个斜杠命令，实际 ${commands.length}：${commandNames.join(', ')}`)
for (const expected of ['derive', 'paper', 'review', 'status', 'study-init', 'survey', 'write']) {
  ok(commandNames.includes(expected), `缺少 /${expected}`)
}
ok(typeof hooks['agent/pre-step'] === 'function', '强制层缺 pre-step')
ok(typeof hooks['agent/turn-stopping'] === 'function', '强制层缺 turn-stopping')
ok(guards.length === 1, `强制层应有 1 个 guard，实际 ${guards.length}`)

console.log('')
console.log('斜杠命令：')
console.log('  ' + commandNames.map((n) => `/${n}`).join('  '))
console.log('强制钩子：agent/pre-step · agent/turn-stopping · tools/guard')

if (problems.length) {
  console.error('\n✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('\n✓ 挂载冒烟通过（6 个模块按包名解析、apply() 全部成功、18 工具 + 7 命令 + 3 钩子）')
