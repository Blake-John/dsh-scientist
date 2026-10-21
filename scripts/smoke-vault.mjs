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

if (problems.length) {
  console.error('\n✗ 失败项:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('\n✓ 挂载冒烟通过（4 个模块按包名解析、apply() 全部成功、18 个工具无重名）')
