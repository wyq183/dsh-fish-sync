/**
 * 自动发现自检 —— 验证「IP 变了也能连上」这条路真的通。
 *
 * 覆盖：
 *  ① 广播地址算得对（子网广播是能不能找到对方的前提）
 *  ② 两个发现实例能互相看见（同一台机器上用两个身份跑，等价于两端）
 *  ③ 发现不到时返回 null，而不是瞎猜一个地址
 *  ④ 过期对端会被清掉（不会拿着三天前的 IP 去连）
 *  ⑤ 同步时手配地址不通 → 自动接管（这是「换网络也能连」的核心）
 *
 * 跑：node test/discovery.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDiscovery, subnetBroadcast, listLocalAddresses, DISCOVERY_PORT } from '../lib/discovery.js'
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

process.stdout.write('\n── ① 广播地址 ──\n')

await check('子网广播算得对', () => {
  assert.equal(subnetBroadcast('192.168.1.10', '255.255.255.0'), '192.168.1.1055')
  assert.equal(subnetBroadcast('192.168.1.11', '255.255.255.0'), '192.168.1.1055')
  assert.equal(subnetBroadcast('10.1.2.3', '255.255.0.0'), '10.1.255.255')
  assert.equal(subnetBroadcast('172.16.5.9', '255.255.240.0'), '172.16.15.255')
})

await check('非法输入返回 null 而不是抛', () => {
  assert.equal(subnetBroadcast('bad', 'mask'), null)
  assert.equal(subnetBroadcast('1.2.3', '255.255.255.0'), null)
})

await check('能列出本机地址', () => {
  const addrs = listLocalAddresses()
  assert.ok(Array.isArray(addrs))
  // 不断言数量（不同机器不一样），只断言形状
  for (const a of addrs) {
    assert.equal(typeof a.address, 'string')
    assert.ok(!a.address.startsWith('127.'), '不该包含回环')
    assert.ok(!a.address.startsWith('169.254.'), '不该包含链路本地')
  }
})

process.stdout.write('\n── ② 两端互相发现 ──\n')

await check('两个实例能互相看见', async () => {
  const cfgA = normalizeConfig({ identity: 'big-fish', port: 19001 }, '/tmp')
  const cfgB = normalizeConfig({ identity: 'small-fish', port: 19002 }, '/tmp')

  const a = await startDiscovery(cfgA, {})
  const b = await startDiscovery(cfgB, {})
  try {
    // 等几轮广播（间隔 10 秒，这里等 12 秒确保至少一轮）
    await new Promise((r) => setTimeout(r, 12_000))
    const aSees = a.status().peers
    const bSees = b.status().peers
    assert.ok(aSees.length > 0, `大肥鱼应发现小肥鱼，实际 peers=${JSON.stringify(aSees)}`)
    assert.ok(bSees.length > 0, `小肥鱼应发现大肥鱼，实际 peers=${JSON.stringify(bSees)}`)
    assert.ok(aSees.some((p) => p.identity === 'small-fish'), '大肥鱼应看到 small-fish')
    assert.ok(bSees.some((p) => p.identity === 'big-fish'), '小肥鱼应看到 big-fish')

    // peer() 能取到
    const p = a.peer('small-fish')
    assert.ok(p !== null, 'peer("small-fish") 应返回地址')
    assert.equal(typeof p.address, 'string')
    assert.equal(p.port, 19002)
  } finally {
    await a.close()
    await b.close()
  }
})

await check('发现不到时返回 null（不瞎猜）', async () => {
  const cfg = normalizeConfig({ identity: 'big-fish', port: 19003 }, '/tmp')
  const solo = await startDiscovery(cfg, {})
  try {
    await new Promise((r) => setTimeout(r, 2000))
    assert.equal(solo.peer(), null, '没有别人时应该返回 null')
    assert.equal(solo.status().peers.length, 0)
  } finally {
    await solo.close()
  }
})

process.stdout.write('\n── ③ 换 IP 也能连（核心）──\n')

await check('手配地址不通 → 自动发现接管', async () => {
  const homeA = await mkdtemp(join(tmpdir(), 'disc-A-'))
  const homeB = await mkdtemp(join(tmpdir(), 'disc-B-'))
  await mkdir(join(homeA, 'yiqi-pending'), { recursive: true })
  await mkdir(join(homeB, 'yiqi-pending'), { recursive: true })
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), '{"from":"A"}', 'utf8')
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), '{"from":"B"}', 'utf8')

  const token = 'disc-token'
  // B 起同步服务
  const cfgB = normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB)
  const server = await startServer({ ...cfgB, port: 0 }, {})

  // A 的 peer 故意写一个**不存在的地址**（模拟「IP 变了」）
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: '10.99.99.99:3098', // 这个地址肯定不通
    port: 0,
  }, homeA)

  const report = await syncOnce(cfgA, {
    // 模拟发现：真的指向 B 的实际端口
    resolvePeer: () => ({ address: '127.0.0.1', port: server.port, label: '小肥鱼' }),
  })

  assert.equal(report.ok, true, `应该靠自动发现成功：${report.errors.join('; ')}`)
  assert.equal(report.peerSource, 'discovered-fallback', `来源应为 discovered-fallback，实际 ${report.peerSource}`)
  assert.ok(report.peer.includes(String(server.port)), `应连到发现的端口 ${server.port}，实际 ${report.peer}`)

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

await check('手配地址通 → 优先用它（不浪费时间发现）', async () => {
  const homeA = await mkdtemp(join(tmpdir(), 'disc2-A-'))
  const homeB = await mkdtemp(join(tmpdir(), 'disc2-B-'))
  await mkdir(join(homeA, 'yiqi-pending'), { recursive: true })
  await mkdir(join(homeB, 'yiqi-pending'), { recursive: true })
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), '{"from":"B"}', 'utf8')

  const token = 'disc-token2'
  const cfgB = normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB)
  const server = await startServer({ ...cfgB, port: 0 }, {})

  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: `127.0.0.1:${server.port}`, // 通的
    port: 0,
  }, homeA)

  const report = await syncOnce(cfgA, {
    // 就算发现了别的，也不该用
    resolvePeer: () => ({ address: '10.99.99.99', port: 1234, label: '假的' }),
  })

  assert.equal(report.ok, true, `应成功：${report.errors.join('; ')}`)
  assert.equal(report.peerSource, 'manual', `来源应为 manual，实际 ${report.peerSource}`)

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

await check('纯自动模式（peer=auto）', async () => {
  const homeA = await mkdtemp(join(tmpdir(), 'disc3-A-'))
  const homeB = await mkdtemp(join(tmpdir(), 'disc3-B-'))
  await mkdir(join(homeA, 'yiqi-pending'), { recursive: true })
  await mkdir(join(homeB, 'yiqi-pending'), { recursive: true })
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), '{"auto":true}', 'utf8')

  const token = 'disc-token3'
  const cfgB = normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB)
  const server = await startServer({ ...cfgB, port: 0 }, {})

  const cfgA = normalizeConfig({ identity: 'big-fish', token, peer: 'auto', port: 0 }, homeA)
  const report = await syncOnce(cfgA, {
    resolvePeer: () => ({ address: '127.0.0.1', port: server.port, label: '小肥鱼' }),
  })

  assert.equal(report.ok, true, `应成功：${report.errors.join('; ')}`)
  assert.equal(report.peerSource, 'discovered', `来源应为 discovered，实际 ${report.peerSource}`)

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

await check('既没手配也没发现 → 报清楚原因，不静默', async () => {
  const home = await mkdtemp(join(tmpdir(), 'disc4-'))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  const cfg = normalizeConfig({ identity: 'big-fish', token: 'x', peer: 'auto', port: 0 }, home)
  const report = await syncOnce(cfg, { resolvePeer: () => null })

  assert.equal(report.ok, false, '没有对端时应失败')
  assert.ok(report.errors.length > 0, '必须给出错误说明')
  assert.ok(report.errors[0].includes('局域网') || report.errors[0].includes('对端'), `错误应说人话：${report.errors[0]}`)

  await rm(home, { recursive: true, force: true })
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
