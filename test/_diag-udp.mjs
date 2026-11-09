/**
 * 诊断：同机双实例的 UDP 广播到底有没有发出去、被谁收到。
 *
 * 目的：分清「代码 bug」和「同机双实例的 socket 限制」。
 * 判据：抓包 socket 收到了 = 包确实发出去了（代码没问题）；
 *       只有发现实例收不到 = reuseAddr 在同机的分配问题。
 */

import { createSocket } from 'node:dgram'
import { startDiscovery, DISCOVERY_PORT, MULTICAST_ADDR } from '../lib/discovery.js'
import { normalizeConfig } from '../lib/identity.js'

const received = []

// 独立抓包 socket：绑一个**别的**端口收不到，所以也绑 3097 并用 reuseAddr
const spy = createSocket({ type: 'udp4', reuseAddr: true })
spy.on('message', (buf, rinfo) => {
  received.push({ from: rinfo.address, port: rinfo.port, text: buf.toString('utf8').slice(0, 120) })
})
spy.bind(DISCOVERY_PORT, () => {
  try { spy.addMembership(MULTICAST_ADDR) } catch { /* 忽略 */ }
  process.stdout.write(`spy 已绑定 ${DISCOVERY_PORT}\n`)
})

const cfgA = normalizeConfig({ identity: 'big-fish', port: 19001 }, '/tmp')
const cfgB = normalizeConfig({ identity: 'small-fish', port: 19002 }, '/tmp')

const a = await startDiscovery(cfgA, { log: (l, m) => process.stdout.write(`[A ${l}] ${m}\n`) })
const b = await startDiscovery(cfgB, { log: (l, m) => process.stdout.write(`[B ${l}] ${m}\n`) })

await new Promise((r) => setTimeout(r, 12_000))

process.stdout.write(`\n=== 抓包 socket 收到 ${received.length} 包 ===\n`)
for (const r of received.slice(0, 8)) process.stdout.write(`  from ${r.from}:${r.port} → ${r.text}\n`)

process.stdout.write(`\n=== A 的 peers: ${JSON.stringify(a.status().peers)} ===\n`)
process.stdout.write(`=== B 的 peers: ${JSON.stringify(b.status().peers)} ===\n`)

await a.close()
await b.close()
try { spy.close() } catch { /* 忽略 */ }

process.exit(0)
