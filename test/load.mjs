/**
 * 加载预演 —— 用假 ctx 模拟 cordis 加载本插件。
 *
 * 为什么必须有这一关（dsh-yiqi-memory 用三次崩溃换来的）：
 *  · 导出 `Config` → cordis 硬取 `Config['~standard'].validate` → TypeError
 *    → 被 `_reload` 的 catch 吞掉 → **apply 一次都不被调用**，不报错、不留痕。
 *  · apply 里抛异常 → 归类为 fatal load failure → **直接杀掉宿主进程**。
 *  · 少 export `inject` → apply 执行时服务没就绪 → 静默不注册。
 *
 * 跑：node test/load.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const failures = []

/**
 * 跑一条断言。
 * @param {string} name - 用例名。
 * @param {Function} fn - 断言体。
 */
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    process.stdout.write(`  ✅ ${name}\n`)
  } catch (error) {
    fail += 1
    failures.push(`${name}: ${error?.message ?? error}`)
    process.stdout.write(`  ❌ ${name}\n     ${error?.message ?? error}\n`)
  }
}

const mod = await import('../lib/index.js')

process.stdout.write('\n── ① 导出契约 ──\n')

await check('导出 name', () => {
  assert.equal(typeof mod.name, 'string')
  assert.ok(mod.name.length > 0)
})

await check('导出 inject（否则静默不注册）', () => {
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  assert.ok(mod.inject.includes('tools'), 'inject 应含 tools')
})

await check('🔴 inject 必须含 webServer（否则管理面 404）', () => {
  // 2026-10-22 真机踩到：只声明 ['tools'] 时，管理面
  // `/ext/fish-sync/` 一直 404，而插件看起来"加载正常"
  // （3098 在听、工具也注册了，就是管理页打不开）。
  // 对照：dsh-lan-connect 导出的就是 inject = ['webServer']。
  assert.ok(mod.inject.includes('webServer'),
    `inject 必须含 webServer，实际 ${JSON.stringify(mod.inject)}`)
})

await check('导出 apply 是函数', () => {
  assert.equal(typeof mod.apply, 'function')
})

await check('🔴 绝不导出 Config（会导致 apply 不被调用）', () => {
  assert.equal(mod.Config, undefined, '导出 Config 会让 cordis 崩在 resolveConfig')
})

process.stdout.write('\n── ② 假 ctx 跑 apply ──\n')

/** 造一个够用的假 ctx。 */
function makeCtx(logs) {
  const effects = []
  const tools = []
  const injected = []
  return {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
    },
    /**
     * cordis 的 inject(services, callback)：等服务就绪后回调。
     * 测试里没有 webServer / connection，所以只记录、不回调 ——
     * 这样 apply 不会因为缺服务而抛，正好验证「缺服务也不炸」。
     * @param {string[]} services - 依赖服务名。
     * @param {Function} [cb] - 回调。
     */
    inject(services, cb) {
      injected.push({ services, cb })
    },
    tools: {
      register(def) {
        tools.push(def)
        return () => {}
      },
    },
    _effects: effects,
    _tools: tools,
    _injected: injected,
  }
}

await check('apply 不抛异常，注册两个工具', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-load-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  await mkdir(join(home, 'yiqishard', 'memory'), { recursive: true })
  await writeFile(join(home, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[]}', 'utf8')

  const logs = []
  const ctx = makeCtx(logs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mod.apply(ctx, { port: 0, token: 'x', peer: '', autoSync: false })
    // 给异步的 server 启动一点时间
    await new Promise((r) => setTimeout(r, 300))

    const names = ctx._tools.map((t) => t.name)
    assert.ok(names.includes('fish_sync_now'), `应注册 fish_sync_now，实际 ${names.join(',')}`)
    assert.ok(names.includes('fish_sync_status'), `应注册 fish_sync_status，实际 ${names.join(',')}`)

    // 每个工具都要有 description 与 execute
    for (const t of ctx._tools) {
      assert.equal(typeof t.description, 'string')
      assert.equal(typeof t.execute, 'function')
    }

    // 🔴 宿主要求 output { schema, render }，缺了会 throw TypeError
    //    （2026-10-22 在手机上真踩过：tool "fish_sync_now" must declare output）
    for (const t of ctx._tools) {
      assert.ok(t.output && typeof t.output === 'object', `${t.name} 缺少 output`)
      assert.ok(t.output.schema, `${t.name} 的 output 缺少 schema`)
      assert.equal(typeof t.output.render, 'function', `${t.name} 的 output.render 必须是函数`)
      // render 要能把 { text } 渲染出来
      const rendered = t.output.render({}, { text: 'hello' })
      assert.ok(Array.isArray(rendered) && rendered[0]?.type === 'text', `${t.name} 的 render 返回形状不对`)
      assert.equal(rendered[0].text, 'hello')
    }

    // parameters 必须是合法 JSON Schema 对象（不是 {}）
    for (const t of ctx._tools) {
      assert.equal(typeof t.parameters, 'object', `${t.name} 缺少 parameters`)
      assert.equal(t.parameters.type, 'object', `${t.name} 的 parameters.type 应为 object`)
    }
  } finally {
    // 清理 effect（关服务器）
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

await check('工具能跑出可读文本（不抛）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-load2-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  const logs = []
  const ctx = makeCtx(logs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mod.apply(ctx, { port: 0, token: 'x', peer: '', autoSync: false })
    await new Promise((r) => setTimeout(r, 300))
    const status = ctx._tools.find((t) => t.name === 'fish_sync_status')
    // execute 返回 { text } 对象（宿主契约），不是字符串
    const out1 = await status.execute()
    assert.equal(typeof out1, 'object', 'execute 应返回对象')
    const text = out1.text
    assert.equal(typeof text, 'string')
    assert.ok(text.includes('大肥鱼'), `状态里应含身份名，实际：${text}`)
    assert.ok(text.includes('任务'), '状态里应含同步范围')

    const now = ctx._tools.find((t) => t.name === 'fish_sync_now')
    const out2 = await now.execute()
    assert.equal(typeof out2, 'object', 'execute 应返回对象')
    const text2 = out2.text
    assert.equal(typeof text2, 'string')
    assert.ok(text2.includes('peer') || text2.includes('对端'), `未配对端应说明，实际：${text2}`)
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

await check('配置非法也不抛（防御）', async () => {
  const logs = []
  const ctx = makeCtx(logs)
  mod.apply(ctx, { port: -1, token: 123, peer: null, intervalMs: 'abc' })
  await new Promise((r) => setTimeout(r, 200))
  for (const e of ctx._effects) {
    try { await e.dispose?.() } catch { /* 忽略 */ }
  }
})

// ── ③ 唤醒路径（2026-10-25 加）────────────────────────────────
//
// 🔴 这一节的来历：2026-10-25 我加了信箱唤醒，126 项测试全绿，
//    但部署后重启 —— **3098 不监听、工具一个都没注册、管理页 404**。
//
//    根因：我在唤醒段里写了 `dshHomePath(...)`，而这个项目里只有 `dshHome()`。
//    `dshHomePath` 没 import → 调用时 ReferenceError → apply 抛错 →
//    cordis 把已注册的 effect 全部回滚 → server 关掉、工具没了。
//
//    为什么测试没抓住：上面那条用例传的是 `{ autoSync: false }`，
//    **没有 wakeupEnabled** → 默认 false → 唤醒段整个被跳过，那行代码从没执行过。
//
//    → 教训：**「某条分支没被测到」和「那条分支是对的」是两件事。**
//      新加一个 if 分支，就得有一条用例真的走进去。
process.stdout.write('\n── ③ 唤醒路径（开启后必须不抛）──\n')

await check('🔴 wakeupEnabled=true 时 apply 不抛（抓未定义标识符）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  await mkdir(join(home, 'yiqishard', 'memory'), { recursive: true })
  await writeFile(join(home, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[]}', 'utf8')

  const logs = []
  const ctx = makeCtx(logs)
  // 这条用例的关键：**真的把唤醒打开**，让那段代码执行
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.doesNotThrow(() => {
      mod.apply(ctx, {
        port: 0,
        token: 'x',
        peer: '',
        autoSync: false,
        wakeupEnabled: true,
        wakeupSessionId: 'session-test-123',
      })
    }, '唤醒开启时 apply 不能抛 —— 抛了会让宿主回滚所有已注册的 effect')

    await new Promise((r) => setTimeout(r, 300))

    const names = ctx._tools.map((t) => t.name)
    assert.ok(
      names.includes('fish_sync_notify'),
      `唤醒开启时应注册 fish_sync_notify，实际 ${names.join(',')}`,
    )
    assert.ok(names.includes('fish_sync_now'), 'fish_sync_now 不能被挤掉')
    assert.ok(names.includes('fish_sync_status'), 'fish_sync_status 不能被挤掉')
    assert.ok(names.includes('fish_sync_targets'), 'fish_sync_targets 不能被挤掉')
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

await check('唤醒没配 sessionId 时不抛（只记 warn）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-wake2-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  await mkdir(join(home, 'yiqishard', 'memory'), { recursive: true })
  await writeFile(join(home, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[]}', 'utf8')

  const logs = []
  const ctx = makeCtx(logs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.doesNotThrow(() => {
      mod.apply(ctx, {
        port: 0,
        token: 'x',
        peer: '',
        autoSync: false,
        wakeupEnabled: true,
        wakeupSessionId: '',
      })
    })
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(ctx._tools.some((t) => t.name === 'fish_sync_notify'))
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

await check('inject 必须含 sessionController（否则唤醒静默失效）', () => {
  assert.ok(
    Array.isArray(mod.inject) && mod.inject.includes('sessionController'),
    `inject 应含 sessionController，实际 ${JSON.stringify(mod.inject)}`,
  )
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
