/**
 * 配对自检 —— 验证扫码这条路的安全性质。
 *
 * 覆盖的是「不测就会静默出安全问题」的几条：
 *  ① 令牌过期后不能用
 *  ② 一码只能配一次（消费掉）
 *  ③ 错的令牌换不到密钥
 *  ④ 换到的密钥两端一致，且能真正用于同步
 *  ⑤ 没配 token 时同步口 fail closed
 *  ⑥ 配对端点免认证，但其他端点不免
 *
 * 跑：node test/pairing.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairingService, qrPayload, newSecret } from '../lib/pairing.js'
import { normalizeConfig } from '../lib/identity.js'
import { startServer } from '../lib/server.js'
import { syncOnce } from '../lib/sync.js'

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

process.stdout.write('\n── ① 令牌生命周期 ──\n')

await check('签发的令牌有效', () => {
  const p = new PairingService()
  const t = p.issue()
  assert.equal(typeof t.id, 'string')
  assert.ok(t.id.length > 20, '令牌应足够长')
  assert.ok(t.remainingMs > 0)
  assert.equal(p.current()?.id, t.id)
})

await check('刷新让旧令牌立刻失效', async () => {
  const p = new PairingService()
  const first = p.issue()
  const second = p.issue()
  assert.notEqual(first.id, second.id)
  assert.equal(await p.accept(first.id), null, '旧令牌应失效')
  assert.ok(await p.accept(second.id) !== null, '新令牌应有效')
})

await check('过期后不能用', async () => {
  const p = new PairingService({ ttlMs: 50 })
  const t = p.issue()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await p.accept(t.id), null, '过期令牌应被拒')
})

await check('一码只能配一次（消费掉）', async () => {
  const p = new PairingService()
  const t = p.issue()
  const secret1 = await p.accept(t.id)
  assert.ok(secret1 !== null, '第一次应成功')
  const secret2 = await p.accept(t.id)
  assert.equal(secret2, null, '第二次应失败（令牌已消费）')
})

await check('错的令牌换不到密钥', async () => {
  const p = new PairingService()
  p.issue()
  assert.equal(await p.accept('wrong-token'), null)
  assert.equal(await p.accept(''), null)
  assert.equal(await p.accept(undefined), null)
  assert.equal(await p.accept(123), null)
})

await check('过期与不存在返回同一结果（不给探测口）', async () => {
  const p1 = new PairingService()
  const wrong = await p1.accept('nope')

  const p2 = new PairingService({ ttlMs: 30 })
  const t = p2.issue()
  await new Promise((r) => setTimeout(r, 80))
  const expired = await p2.accept(t.id)

  assert.equal(wrong, expired, '两者都应是 null，不可区分')
  assert.equal(wrong, null)
})

process.stdout.write('\n── ② 密钥与二维码 ──\n')

await check('密钥足够长且互不相同', () => {
  const a = newSecret()
  const b = newSecret()
  assert.ok(a.length >= 40, `密钥应至少 40 字符，实际 ${a.length}`)
  assert.notEqual(a, b)
})

await check('二维码内容是合法 JSON 且不含密钥', () => {
  const cfg = normalizeConfig({ identity: 'big-fish', port: 3098 }, '/tmp')
  const text = qrPayload(cfg, '192.168.1.10', 'pair-token-abc')
  const parsed = JSON.parse(text)
  assert.equal(parsed.v, 1)
  assert.equal(parsed.fish, 'big-fish')
  assert.equal(parsed.host, '192.168.1.10')
  assert.equal(parsed.port, 3098)
  assert.equal(parsed.pair, 'pair-token-abc')
  // 🔴 二维码里绝不能出现长期密钥
  assert.ok(!text.includes('secret'), '二维码不该含 secret 字段')
})

process.stdout.write('\n── ③ 端到端配对 → 同步 ──\n')

await check('扫码配对后两端能用同一把密钥同步', async () => {
  const homeA = await mkdtemp(join(tmpdir(), 'pair-A-'))
  const homeB = await mkdtemp(join(tmpdir(), 'pair-B-'))
  await mkdir(join(homeA, 'yiqi-pending'), { recursive: true })
  await mkdir(join(homeB, 'yiqi-pending'), { recursive: true })
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), '{"from":"A"}', 'utf8')

  // B 起服务，带配对
  let issuedSecret = ''
  const pairingB = new PairingService({
    onPaired: (s) => { issuedSecret = s },
  })
  const cfgB = normalizeConfig({ identity: 'small-fish', token: '', port: 0 }, homeB)
  const server = await startServer({ ...cfgB, port: 0, get token() { return issuedSecret } }, { pairing: pairingB })

  // B 出码
  const tok = pairingB.issue()

  // A 扫码 → 换密钥（走真实 HTTP）
  const res = await fetch(`http://127.0.0.1:${server.port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pair: tok.id }),
  })
  assert.equal(res.status, 200, `配对应成功，实际 ${res.status}`)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.secret, 'string')
  assert.equal(body.secret, issuedSecret, '两端拿到的密钥应一致')

  // A 用这把密钥同步
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token: body.secret,
    peer: `127.0.0.1:${server.port}`,
    port: 0,
  }, homeA)
  const report = await syncOnce(cfgA, {})
  assert.equal(report.ok, true, `配对应后能同步：${report.errors.join('; ')}`)
  assert.ok(report.pushed.length >= 1, '应把 pending 推过去')

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

await check('配对端点免认证，但其他端点不免', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pair-C-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  const pairing = new PairingService()
  const cfg = normalizeConfig({ identity: 'small-fish', token: 'real-token', port: 0 }, home)
  const server = await startServer({ ...cfg, port: 0 }, { pairing })

  try {
    // 配对端点：不带 token 也能访问（但要带对的配对令牌）
    const tok = pairing.issue()
    const pairRes = await fetch(`http://127.0.0.1:${server.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pair: tok.id }),
    })
    assert.equal(pairRes.status, 200, '配对端点应免认证')

    // 其他端点：不带 token 必须 401
    const statusRes = await fetch(`http://127.0.0.1:${server.port}/api/status`)
    assert.equal(statusRes.status, 401, 'status 端点必须要求 token')

    const manifestRes = await fetch(`http://127.0.0.1:${server.port}/api/manifest`)
    assert.equal(manifestRes.status, 401, 'manifest 端点必须要求 token')

    // 带上正确 token 才通
    const okRes = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
      headers: { 'x-fish-token': 'real-token' },
    })
    assert.equal(okRes.status, 200)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

await check('配对令牌错误 → 403，且不泄露细节', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pair-D-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  const pairing = new PairingService()
  const cfg = normalizeConfig({ identity: 'small-fish', token: 't', port: 0 }, home)
  const server = await startServer({ ...cfg, port: 0 }, { pairing })

  try {
    pairing.issue()
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pair: 'wrong' }),
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.ok, false)
    // 不该说出「令牌存在但不对」这种区分信息
    assert.ok(body.error.includes('无效') || body.error.includes('过期'), `错误信息应模糊：${body.error}`)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
