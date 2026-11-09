/**
 * 管理面自检 —— 验证 http.js 的路由与认证逻辑。
 *
 * 为什么要有这一关（2026-10-22 连环踩坑后加的）：
 *   管理面出过两个静默故障，都只在真机上暴露：
 *   ① inject 少了 webServer → 路由 404（宿主侧，测不到）
 *   ② 桌面端跨源 → cookie 不带 → 401 → 前端白条
 *   ②这一条可以在本地测：造一个假 req（remoteAddress=127.0.0.1），
 *   看 createHandler 会不会正确放行。
 *
 * 跑：node test/http.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, ROUTE_PATH } from '../lib/http.js'
import { PairingService } from '../lib/pairing.js'

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

/**
 * 造一个假的 req。
 * @param {object} opts - 选项。
 * @returns {object} 假 req。
 */
function makeReq({ method = 'GET', url = '/', remote = '127.0.0.1', headers = {}, body = '' } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: remote },
    on(event, cb) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
      return req
    },
    destroy() {},
    /**
     * 触发 body 事件（模拟客户端发完）。
     */
    _flush() {
      if (body !== '') {
        for (const cb of listeners.data ?? []) cb(Buffer.from(body, 'utf8'))
      }
      for (const cb of listeners.end ?? []) cb()
    },
  }
  return req
}

/**
 * 造一个假的 res，收集响应。
 * @returns {object} 假 res。
 */
function makeRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(chunk) {
      out.body = chunk === undefined ? '' : String(chunk)
    },
    _out: out,
  }
}

/** 建 handler（带最小依赖）。 */
async function makeHandler() {
  const home = await mkdtemp(join(tmpdir(), 'fish-http-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  const pairing = new PairingService()
  const handler = createHandler({
    ctx: { connection: { requestRejection: () => 401 } }, // 模拟"未登录"
    cfg: { identity: 'big-fish', label: '大肥鱼', port: 3098, targets: [] },
    pairing,
    state: () => ({
      identity: 'big-fish',
      label: '大肥鱼',
      peer: '',
      pairedAt: null,
      serverPort: 3098,
      targets: '任务、今日记忆',
      autoSyncText: '开',
      lastSyncAt: null,
      lastResult: null,
      lastError: null,
      remainingMs: 0,
      pairCode: pairing.current()?.code ?? '',
      pairedCount: 0,
      discovered: [],
      qrSvg: null,
    }),
    qrText: () => null,
    syncNow: async () => ({ pushed: 0, pulled: 0, skipped: 0, conflicts: 0 }),
    joinPeer: async ({ code, host, port }) => {
      if (code === 'GOOD') return { ok: true, peer: `${host}:${port}` }
      return { ok: false, error: '配对码不对' }
    },
  })
  return { handler, pairing, home }
}

process.stdout.write('\n── ① 回环放行（桌面端跨源问题）──\n')

await check('回环请求免登录 → 200', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    await handler(makeReq({ url: `${ROUTE_PATH}/api/state`, remote: '127.0.0.1' }), res)
    assert.equal(res._out.status, 200, `回环应放行，实际 ${res._out.status}`)
    const body = JSON.parse(res._out.body)
    assert.equal(body.ok, true)
    assert.equal(body.label, '大肥鱼')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('::1 与 ::ffff:127.0.0.1 也算回环', async () => {
  const { handler, home } = await makeHandler()
  try {
    for (const remote of ['::1', '::ffff:127.0.0.1', '127.0.0.5']) {
      const res = makeRes()
      await handler(makeReq({ url: `${ROUTE_PATH}/api/state`, remote }), res)
      assert.equal(res._out.status, 200, `${remote} 应放行，实际 ${res._out.status}`)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('非回环 + 未登录 → 401', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    await handler(makeReq({ url: `${ROUTE_PATH}/api/state`, remote: '192.168.1.11' }), res)
    assert.equal(res._out.status, 401, `非回环应要求登录，实际 ${res._out.status}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ② 配对码 ──\n')

await check('生成配对码 → 返回 6 位码', async () => {
  const { handler, home, pairing } = await makeHandler()
  try {
    const res = makeRes()
    await handler(makeReq({
      method: 'POST',
      url: `${ROUTE_PATH}/api/pair`,
      remote: '127.0.0.1',
      headers: { 'x-dsh-fish-sync': '1' },
    }), res)
    assert.equal(res._out.status, 200, `应成功，实际 ${res._out.status}`)
    const cur = pairing.current()
    assert.ok(cur, '应有有效令牌')
    assert.equal(cur.code.length, 6, `短码应 6 位，实际 ${cur.code}`)
    assert.match(cur.code, /^[2-9A-HJKMNP-Z]{6}$/, `短码字符集不对：${cur.code}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('短码大小写不敏感', async () => {
  const p = new PairingService()
  const t = p.issue()
  const lower = t.code.toLowerCase()
  const secret = await p.accept(lower)
  assert.ok(secret !== null, '小写短码也应认')
})

await check('长 id 也能用（二维码路径）', async () => {
  const p = new PairingService()
  const t = p.issue()
  const secret = await p.accept(t.id)
  assert.ok(secret !== null, '完整 id 应有效')
})

process.stdout.write('\n── ③ join 端点 ──\n')

await check('输码配对成功', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    const req = makeReq({
      method: 'POST',
      url: `${ROUTE_PATH}/api/join`,
      remote: '127.0.0.1',
      headers: { 'x-dsh-fish-sync': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'GOOD', host: '192.168.1.10', port: 3098 }),
    })
    const p = handler(req, res)
    req._flush()
    await p
    assert.equal(res._out.status, 200, `应成功，实际 ${res._out.status} ${res._out.body}`)
    const body = JSON.parse(res._out.body)
    assert.equal(body.ok, true)
    assert.equal(body.peer, '192.168.1.10:3098')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('缺配对码 → 400', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    const req = makeReq({
      method: 'POST',
      url: `${ROUTE_PATH}/api/join`,
      remote: '127.0.0.1',
      headers: { 'x-dsh-fish-sync': '1' },
      body: JSON.stringify({ code: '', host: '192.168.1.10', port: 3098 }),
    })
    const p = handler(req, res)
    req._flush()
    await p
    assert.equal(res._out.status, 400)
    assert.ok(JSON.parse(res._out.body).error.includes('配对码'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('地址格式不对 → 400', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    const req = makeReq({
      method: 'POST',
      url: `${ROUTE_PATH}/api/join`,
      remote: '127.0.0.1',
      headers: { 'x-dsh-fish-sync': '1' },
      body: JSON.stringify({ code: 'GOOD', host: '', port: 0 }),
    })
    const p = handler(req, res)
    req._flush()
    await p
    assert.equal(res._out.status, 400)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ④ 写操作 CSRF 栅栏 ──\n')

await check('缺 X-DSH-Fish-Sync 头 → 403', async () => {
  const { handler, home } = await makeHandler()
  try {
    const res = makeRes()
    await handler(makeReq({
      method: 'POST',
      url: `${ROUTE_PATH}/api/pair`,
      remote: '127.0.0.1',
      headers: {}, // 故意不带
    }), res)
    assert.equal(res._out.status, 403, `应拒绝，实际 ${res._out.status}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
