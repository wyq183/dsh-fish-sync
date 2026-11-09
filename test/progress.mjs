/**
 * 进度与反馈 —— 2026-10-23 主人报的那批问题的回归测试。
 *
 * 主人原话：「同步插件好像你还没做好哦，一直有问题，而且点按钮同步成功
 * 没有也不会弹提示也没有进度提示，只有连接失败会有提示」
 *
 * 拆成四条真问题，一条一个用例，**每条都必须在旧代码上失败、新代码上通过**：
 *  ① 自动同步从没被注册过 —— 守卫只看 cfg.peer，而配对地址在 runtime.peer
 *  ② 同步成功前端不提示 —— client.js 成功分支只 refresh()，没有可见反馈
 *  ③ 同步没有进度 —— 中间几秒完全静默，看不出在动
 *  ④ 没对端时 syncNow 返回旧报告 —— 可能「明明失败却显示成功」
 *
 * 跑：node test/progress.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/identity.js'
import { startServer } from '../lib/server.js'

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

/**
 * 造一个够用的假 ctx（照 load.mjs，但 webServer 可用，好捕获管理面 handler）。
 * @param {object[]} logs - 日志收集。
 * @returns {object} 假 ctx。
 */
function makeCtx(logs) {
  const effects = []
  const tools = []
  const injected = []
  const routes = []
  return {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
    },
    /**
     * cordis 的 inject(services, callback)：测试里立刻回调，
     * 并把一个假的 webServer 塞进 context，好让管理面挂上来。
     *
     * ⚠️ 假 connectionCtx **必须带 effect**（2026-10-23 踩到）：
     *   index.js 里挂路由走的是 `connectionCtx.effect(() => webServer.register(...))`，
     *   缺了 effect 会 throw，被外层 catch 吞掉 → 测试里「handler 没挂上」，
     *   看起来像插件坏了，其实是假 ctx 不全。
     * @param {string[]} services - 依赖服务名。
     * @param {Function} [cb] - 回调。
     */
    inject(services, cb) {
      injected.push({ services })
      if (typeof cb === 'function') {
        const connEffects = []
        try {
          cb({
            webServer: {
              register(route) {
                routes.push(route)
                return () => {}
              },
            },
            connection: { requestRejection: () => undefined },
            effect(fn, label) {
              connEffects.push({ label, dispose: fn() })
            },
            _effects: connEffects,
          })
        } catch { /* 忽略 */ }
      }
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
    _routes: routes,
  }
}

/**
 * 造一个带白名单目录的临时 dsh home。
 * @param {string} tag - 名字后缀。
 * @returns {Promise<string>} home 路径。
 */
async function makeHome(tag) {
  const home = await mkdtemp(join(tmpdir(), `fish-progress-${tag}-`))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  await mkdir(join(home, 'yiqishard', 'memory'), { recursive: true })
  await mkdir(join(home, 'yiqishard', '交接'), { recursive: true })
  await mkdir(join(home, 'fish-sync'), { recursive: true })
  await writeFile(join(home, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[]}', 'utf8')
  return home
}

/**
 * 走假 webServer 捕获的 handler 发一个请求，拿 JSON。
 * @param {object[]} routes - 捕获到的路由。
 * @param {string} urlPath - 路径（含 /ext/fish-sync 前缀）。
 * @param {object} [opts] - { method, headers }。
 * @returns {Promise<object>} 解析后的 JSON。
 */
async function callRoute(routes, urlPath, opts = {}) {
  const handler = routes.find((r) => r.kind === 'prefix' && r.path === '/ext/fish-sync')?.handler
  assert.ok(typeof handler === 'function', '管理面 handler 没挂上（inject webServer 失败？）')

  const headers = { 'x-dsh-fish-sync': '1', ...(opts.headers ?? {}) }
  /** 收集响应。 */
  const res = {
    _status: 0,
    _headers: {},
    _body: '',
    writeHead(status, h) { this._status = status; this._headers = h ?? {} },
    end(text) { this._body = text ?? '' },
  }
  const req = {
    method: opts.method ?? 'GET',
    url: urlPath,
    headers: { host: '127.0.0.1:1', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { /* 无请求体 */ },
  }
  await handler(req, res)
  try {
    return JSON.parse(res._body)
  } catch {
    throw new Error(`响应不是 JSON（status ${res._status}）：${res._body.slice(0, 200)}`)
  }
}

process.stdout.write('\n── ① 自动同步必须真的被注册（守卫回归）──\n')

await check('🔴 配对地址在 runtime.peer、cfg.peer 为空时，自动同步也要注册', async () => {
  // 这就是「同步一直没生效」的根因：
  // 守卫写的是 `cfg.autoSync && (cfg.peer !== '' || cfg.discovery)`，
  // 而扫码配对得来的地址存在 runtime.peer，cfg.peer 永远是空串、discovery 默认 false
  // → 条件恒假 → 定时器从来没被注册过。实证：/api/state 的 lastSyncAt 一直是 null。
  const home = await makeHome('guard')
  const logs = []
  const ctx = makeCtx(logs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 模拟「已经配对过」：地址落在 paired.json 里，配置里 peer 是空
    await writeFile(join(home, 'fish-sync', 'paired.json'), JSON.stringify({
      secret: 'test-secret-abcdefghijklmnop',
      peer: '127.0.0.1:9',
      pairedAt: new Date().toISOString(),
    }), 'utf8')

    mod.apply(ctx, { port: 0, autoSync: true, peer: '' })
    await new Promise((r) => setTimeout(r, 400))

    const labels = ctx._effects.map((e) => e.label)
    assert.ok(
      labels.includes('fish-sync: auto sync timer'),
      `自动同步定时器必须被注册，实际注册的 effect：${labels.join(' | ') || '（无）'}`,
    )
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

await check('autoSync: false 时不注册定时器（别过度修正）', async () => {
  const home = await makeHome('noguard')
  const ctx = makeCtx([])
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mod.apply(ctx, { port: 0, autoSync: false, peer: '' })
    await new Promise((r) => setTimeout(r, 300))
    const labels = ctx._effects.map((e) => e.label)
    assert.ok(
      !labels.includes('fish-sync: auto sync timer'),
      `关掉自动同步就不该注册定时器，实际：${labels.join(' | ')}`,
    )
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ② 没对端时要明确报错，不许拿旧报告冒充 ──\n')

await check('🔴 没对端时 /api/sync 返回 ok:false 且说清原因', async () => {
  const home = await makeHome('nopeer')
  const ctx = makeCtx([])
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mod.apply(ctx, { port: 0, autoSync: false, peer: '' })
    await new Promise((r) => setTimeout(r, 350))

    const j = await callRoute(ctx._routes, '/ext/fish-sync/api/sync', { method: 'POST' })
    assert.equal(j.ok, false, `没对端时必须 ok:false，实际 ${JSON.stringify(j)}`)
    assert.equal(typeof j.error, 'string')
    assert.ok(j.error.length > 0, '必须给原因，不能空')
    // 原因要能指导下一步动作，不是「未知」
    assert.ok(/配对|对端|地址/.test(j.error), `原因应说清怎么修，实际：${j.error}`)
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ③ 进度：state.syncing 要能从「进行中」走到「完成」──\n')

await check('🔴 同步跑完后 state 里有 syncing 终态 + 上次时间 + 明细', async () => {
  const homeA = await makeHome('pA')
  const homeB = await makeHome('pB')
  const token = 'progress-token-123456'

  // A 有内容可推
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'),
    JSON.stringify({ version: 1, items: [{ id: 'a', title: '进度测试' }] }), 'utf8')

  // ⚠️ 必须把对端那份的时间调早（2026-10-23 踩到）：
  //   两端临时目录里的文件在同一毫秒写完，mtimeMs **完全相同**（NTFS 精度），
  //   而同步的判定是「mtime 大的赢」，相等就判成「对端较新」→ 变成拉而不是推。
  //   这是测试环境的假象，不是插件 bug —— 但测试要能稳定跑，就得把时间差造出来。
  const past = new Date(Date.now() - 60_000)
  await utimes(join(homeB, 'yiqi-pending', 'pending.json'), past, past)

  // B 起真服务当对端
  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB), port: 0 }, {})
  const realPort = server.port

  const logs = []
  const ctx = makeCtx(logs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = homeA
  try {
    // A 已配对到 B
    await writeFile(join(homeA, 'fish-sync', 'paired.json'), JSON.stringify({
      secret: token,
      peer: `127.0.0.1:${realPort}`,
      pairedAt: new Date().toISOString(),
    }), 'utf8')

    mod.apply(ctx, { port: 0, autoSync: false, peer: '', protectMs: 0 })
    await new Promise((r) => setTimeout(r, 350))

    const j = await callRoute(ctx._routes, '/ext/fish-sync/api/sync', { method: 'POST' })
    assert.equal(j.ok, true, `同步应成功，实际：${JSON.stringify(j)}`)

    // 响应要带明细（前端弹提示要用）
    assert.ok(typeof j.pushed === 'number', '响应要有 pushed 数量')
    assert.ok(typeof j.pulled === 'number', '响应要有 pulled 数量')
    assert.ok(Array.isArray(j.pushedKeys), '响应要有 pushedKeys 明细')
    assert.ok(j.pushedKeys.includes('yiqi-pending/pending.json'),
      `应推了 pending.json，实际：${j.pushedKeys.join(', ') || '（空）'}`)

    // state 要能读到终态
    const s = await callRoute(ctx._routes, '/ext/fish-sync/api/state')
    assert.ok(s.syncing !== null && s.syncing !== undefined, 'state.syncing 不该是 null（同步过就留下痕迹）')
    assert.equal(s.syncing.active, false, '同步结束后 active 必须是 false')
    assert.equal(s.syncing.stage, '完成', `终态阶段应为「完成」，实际「${s.syncing.stage}」`)
    assert.ok(typeof s.syncing.elapsedMs === 'number' && s.syncing.elapsedMs >= 0, '要有耗时')
    assert.ok(typeof s.lastSyncAt === 'string' && s.lastSyncAt.length > 0, 'lastSyncAt 必须有值')
    assert.ok(Array.isArray(s.lastPushed), 'state 要有 lastPushed 明细')
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    try { await server.close() } catch { /* 忽略 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

await check('🔴 失败时终态是「失败」而不是「完成」', async () => {
  const home = await makeHome('pFail')
  const ctx = makeCtx([])
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 指向一个必定连不上的端口（1 号口，非特权进程连不上/无服务）
    await writeFile(join(home, 'fish-sync', 'paired.json'), JSON.stringify({
      secret: 'x'.repeat(32),
      peer: '127.0.0.1:1',
      pairedAt: new Date().toISOString(),
    }), 'utf8')

    mod.apply(ctx, { port: 0, autoSync: false, peer: '' })
    await new Promise((r) => setTimeout(r, 350))

    const j = await callRoute(ctx._routes, '/ext/fish-sync/api/sync', { method: 'POST' })
    assert.equal(j.ok, false, `连不上对端必须 ok:false，实际：${JSON.stringify(j)}`)

    const s = await callRoute(ctx._routes, '/ext/fish-sync/api/state')
    assert.equal(s.syncing.active, false, '结束后 active 必须是 false')
    assert.equal(s.syncing.stage, '失败', `终态阶段应为「失败」，实际「${s.syncing.stage}」`)
    assert.ok(typeof s.lastError === 'string' && s.lastError.length > 0, '要留下错误原因')
  } finally {
    for (const e of ctx._effects) {
      try { await e.dispose?.() } catch { /* 忽略 */ }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ④ 前端反馈（静态契约，防回退）──\n')

await check('🔴 client.js 有状态条 + 进度轮询 + 成功也提示', async () => {
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 状态条节点
  assert.ok(src.includes('id="dfs-status"'), '浮层里必须有 #dfs-status 状态条')
  // 进度轮询
  assert.ok(src.includes('startPoll'), '必须有进度轮询（否则同步中一片死寂）')
  assert.ok(src.includes('state.syncing') || src.includes('sy.active'), '轮询必须读后端的 syncing 阶段')
  // 成功也要提示 —— 这是主人报的核心问题
  assert.ok(src.includes('finishSync'), '必须有一个统一的收尾函数')
  assert.ok(src.includes('同步完成'), '成功分支必须写出「同步完成」文案')

  // 旧代码的病：成功只 refresh()，没有任何可见反馈
  const successSilent = /if\s*\(\s*j\s*&&\s*j\.ok\s*\)\s*refresh\(\)/.test(src)
  assert.equal(successSilent, false, '成功分支不能只是静默 refresh()，必须给可见反馈')
})

await check('🔴 管理页（http.js）也有状态条 + 进度', async () => {
  const src = await readFile(new URL('../lib/http.js', import.meta.url), 'utf8')
  assert.ok(src.includes('id="sync-msg"'), '管理页要有 #sync-msg 状态条')
  assert.ok(src.includes('startPoll'), '管理页也要轮询进度')
  assert.ok(src.includes('同步完成'), '管理页成功也要有文案')
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
