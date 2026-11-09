/**
 * 主动敲门自检（`POST /api/wake`）—— 2026-10-25 加。
 *
 * ## 为什么要有这一关
 *
 * 主人原话：
 * > 「不是说改成主动触发而不是定时检查吗？」
 *
 * 第一版把 `checkWake` 挂在「同步完成」之后 —— 那本质还是**定时检查**，
 * 延迟等于同步周期（白天 2 小时）。
 *
 * 这个测试验的是真·主动触发：
 *   对端 POST /api/wake → 本端当场处理 → 返回结果
 *
 * 跑：node test/wake.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../lib/server.js'

let pass = 0
let fail = 0
const failures = []

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

console.log('\n=== 主动敲门自检 ===\n')

/**
 * 起一个测试服务器，返回句柄与端口。
 *
 * @param {object} opts
 * @param {Function} [opts.onWakeKnock] - 敲门处理函数。
 * @param {string} [opts.token] - 期望的 token。
 * @returns {Promise<{handle: object, port: number, base: string}>}
 */
async function boot({ onWakeKnock, token = 'test-token' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const cfg = {
    home,
    identity: 'big-fish',
    label: '测试',
    port: 0,
    token,
    peer: '',
    targets: [],
  }
  const deps = { log: () => {} }
  if (onWakeKnock !== undefined) {
    // 用 getter 模拟 index.js 里的转发（那边也是 getter）
    Object.defineProperty(deps, 'onWakeKnock', {
      get() { return onWakeKnock },
      configurable: true,
    })
  }
  const handle = await startServer(cfg, deps)
  return { handle, port: handle.port, base: `http://127.0.0.1:${handle.port}`, home }
}

/** 发一个敲门请求。 */
async function knock(base, token, body = { from: 'small-fish', kind: 'letter' }) {
  const res = await fetch(`${base}/api/wake`, {
    method: 'POST',
    headers: {
      'x-fish-token': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

console.log('① 正常敲门')

await check('🔴 对端敲门 → 处理函数被调用，返回 handled:true', async () => {
  let called = 0
  const { handle, base, home } = await boot({
    onWakeKnock: async () => {
      called += 1
      return { synced: true }
    },
  })
  try {
    const r = await knock(base, 'test-token')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.handled, true, 'handled 必须是 true')
    assert.equal(called, 1, '处理函数必须被调用一次')
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('处理函数返回的信息会回传给对端', async () => {
  const { handle, base, home } = await boot({
    onWakeKnock: async () => ({ synced: true, extra: 'hello' }),
  })
  try {
    const r = await knock(base, 'test-token')
    assert.equal(r.json.synced, true)
    assert.equal(r.json.extra, 'hello')
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

console.log('\n② 阴性对照')

await check('🔴 没有 token → 401（不能裸奔）', async () => {
  const { handle, base, home } = await boot({
    onWakeKnock: async () => ({ synced: true }),
  })
  try {
    const res = await fetch(`${base}/api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 401, `没 token 必须 401，实际 ${res.status}`)
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('🔴 错误 token → 401', async () => {
  const { handle, base, home } = await boot({
    onWakeKnock: async () => ({ synced: true }),
  })
  try {
    const r = await knock(base, 'wrong-token')
    assert.equal(r.status, 401)
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('本端没启用唤醒 → 200 但 handled:false（不报错，说明原因）', async () => {
  // 故意不传 onWakeKnock
  const { handle, base, home } = await boot({})
  try {
    const r = await knock(base, 'test-token')
    assert.equal(r.status, 200, '不能报错 —— 对端只是敲了下门')
    assert.equal(r.json.handled, false)
    assert.equal(r.json.reason, 'wakeup-disabled')
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('处理函数抛错 → 200 但 ok:false（不能让对端以为成功了）', async () => {
  const { handle, base, home } = await boot({
    onWakeKnock: async () => {
      throw new Error('同步失败')
    },
  })
  try {
    const r = await knock(base, 'test-token')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false, '处理失败必须 ok:false')
    assert.match(r.json.error, /同步失败/)
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('GET /api/wake → 不被当成敲门（方法不对）', async () => {
  const { handle, base, home } = await boot({
    onWakeKnock: async () => ({ synced: true }),
  })
  try {
    const res = await fetch(`${base}/api/wake`, {
      method: 'GET',
      headers: { 'x-fish-token': 'test-token' },
    })
    // GET 不匹配 POST 分支 → 落到 404
    assert.equal(res.status, 404, `GET 应该 404，实际 ${res.status}`)
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

console.log('\n③ getter 转发（这是 index.js 里的写法，不能传值）')

await check('🔴 onWakeKnock 用 getter → 后赋值的函数也能被调用', async () => {
  // 模拟 index.js 的真实情况：
  //   startServer 在前，wakeKnockHandler 在后才赋值。
  //   如果用 `{ ...deps }` 或直接传值，这里永远是 undefined。
  const home = await mkdtemp(join(tmpdir(), 'fish-wake2-'))
  let handler = null
  const cfg = {
    home, identity: 'big-fish', label: '测试', port: 0, token: 'test-token',
    peer: '', targets: [],
  }
  const deps = { log: () => {} }
  Object.defineProperty(deps, 'onWakeKnock', {
    get() { return handler },
    configurable: true,
  })

  const handle = await startServer(cfg, deps)
  const base = `http://127.0.0.1:${handle.port}`
  try {
    // 先敲门（handler 还是 null）
    const r1 = await knock(base, 'test-token')
    assert.equal(r1.json.handled, false, 'handler 还没赋值 → 不该处理')

    // 再赋值（模拟 apply 后面的段落执行）
    let called = 0
    handler = async () => { called += 1; return { synced: true } }

    // 再敲门 → 应该能处理
    const r2 = await knock(base, 'test-token')
    assert.equal(r2.json.handled, true, '🔴 赋值后必须能处理（getter 才做得到）')
    assert.equal(called, 1)
  } finally {
    await handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
