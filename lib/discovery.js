/**
 * discovery —— 两端自动找到对方，不用手写 IP。
 *
 * 主人 2026-10-21 定：方案 B，加自动发现。
 * 原因：`peer` 写死 IP 的话，换网络 / 路由器重分配 / 拔网线改 WiFi 都会静默失联。
 *
 * ⚠️ 为什么**不用**标准 mDNS（`bonjour-service` / `multicast-dns`）：
 *   ① 手机上装 npm 包会撞 EACCES（上游 issue #57 已确认，pnpm spawn EACCES）
 *   ② Android 的组播需要 `CHANGE_WIFI_MULTICAST_STATE` 权限，本 App 的 manifest 里没有
 *   ③ 我们不需要完整的 DNS-SD 协议栈，只需要「两端互相知道对方在哪」
 *   ⇒ 用内置 `dgram` 发 UDP，零依赖、零权限要求，效果等同。
 *
 * 双保险策略（任一条通就行）：
 *   · **组播** 239.255.42.98:3097 —— 局域网内标准做法，多数路由器放行
 *   · **广播** 255.255.255.255:3097 —— 组播被路由器拦时的兜底
 *
 * 报文是 JSON，带版本号，格式：
 *   { v: 1, fish: 'big-fish', label: '大肥鱼', port: 3098, host: '192.168.1.10' }
 *
 * 安全性：发现报文**只用来定位**，不带 token、不带任何内容。
 * 真正的文件传输仍然走 3098 并校验 token —— 发现协议被伪造也读不到数据。
 */

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/** 发现协议版本。改报文格式时 +1。 */
export const DISCOVERY_VERSION = 1

/** 发现端口。与同步口 3098 分开，避免互相干扰。 */
export const DISCOVERY_PORT = 3097

/** 组播地址（管理范围 239.x，不会被当成公网地址）。 */
export const MULTICAST_ADDR = '239.255.42.98'

/** 广播地址。 */
export const BROADCAST_ADDR = '255.255.255.255'

/** 广播间隔（毫秒）。10 秒足够快，也不至于刷爆网络。 */
const ANNOUNCE_INTERVAL_MS = 10_000

/** 多久没收到对方广播就算「失联」（毫秒）。3 个周期。 */
const PEER_STALE_MS = 35_000

/**
 * 枚举本机所有非回环 IPv4 地址。
 * @returns {Array<{iface: string, address: string, netmask: string}>} 地址表。
 */
export function listLocalAddresses() {
  const out = []
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal === true) continue
      if (item.address.startsWith('169.254.')) continue // 链路本地，没用
      out.push({ iface, address: item.address, netmask: item.netmask })
    }
  }
  return out
}

/**
 * 把 netmask 转成广播地址（如 192.168.1.10 / 255.255.255.0 → 192.168.1.1055）。
 * @param {string} address - 本机地址。
 * @param {string} netmask - 子网掩码。
 * @returns {string|null} 广播地址，算不出返回 null。
 */
export function subnetBroadcast(address, netmask) {
  try {
    const a = address.split('.').map(Number)
    const m = netmask.split('.').map(Number)
    if (a.length !== 4 || m.length !== 4) return null
    const b = a.map((octet, i) => (octet & m[i]) | (~m[i] & 255))
    return b.join('.')
  } catch {
    return null
  }
}

/**
 * 启动发现服务。
 *
 * @param {object} cfg - 配置（用 identity / label / port）。
 * @param {object} [deps] - 注入依赖。
 * @param {Function} [deps.log] - 日志函数 (level, msg)。
 * @returns {Promise<{peer: Function, status: Function, close: Function}>} 句柄。
 */
export async function startDiscovery(cfg, deps = {}) {
  const log = deps.log ?? (() => {})

  /** 已发现的对方：identity → { address, port, label, lastSeen } */
  const peers = new Map()

  /** 本端要广播的内容（host 会在每次发送时按接口填）。 */
  const basePayload = {
    v: DISCOVERY_VERSION,
    fish: cfg.identity,
    label: cfg.label,
    port: cfg.port,
  }

  const sockets = []
  let timer
  let closed = false

  /**
   * 处理收到的一包数据。
   * @param {Buffer} buf - 数据。
   * @param {string} rinfoAddress - 来源地址。
   */
  function onMessage(buf, rinfoAddress) {
    try {
      if (buf.length > 1024) return // 发现报文不该这么大，防滥用
      const msg = JSON.parse(buf.toString('utf8'))
      if (msg?.v !== DISCOVERY_VERSION) return
      if (typeof msg.fish !== 'string' || msg.fish === cfg.identity) return // 自己的回声，忽略
      if (!Number.isFinite(Number(msg.port))) return

      const prev = peers.get(msg.fish)
      const now = Date.now()
      peers.set(msg.fish, {
        identity: msg.fish,
        label: typeof msg.label === 'string' ? msg.label : msg.fish,
        // ⚠️ 用**收到包的来源地址**，不用报文里的 host ——
        //    报文里的 host 可能是对方另一块网卡的地址（连不上），
        //    rinfo 是实际通了的那个地址，可信度高得多。
        address: rinfoAddress,
        port: Number(msg.port),
        lastSeen: now,
      })
      if (prev === undefined) {
        log('info', `发现对端 ${peers.get(msg.fish).label} @ ${rinfoAddress}:${msg.port}`)
      }
    } catch {
      // 收到垃圾包，忽略，绝不抛
    }
  }

  /**
   * 建一个 UDP socket 并绑定。
   *
   * @param {object} options - 选项。
   * @param {boolean} options.reuse - 允许地址复用（**监听**组播必须 true）。
   * @param {number} options.port - 绑哪个端口。**发送 socket 必须用 0**（系统随机分配），
   *        否则会和监听 socket 抢同一个端口 → `bind EADDRINUSE` → 广播发不出去。
   *        （2026-10-22 实测踩到：同机双实例时两个发送 socket 全绑失败。）
   * @returns {Promise<import('node:dgram').Socket>} socket。
   */
  function bindSocket({ reuse, port }) {
    return new Promise((resolve, reject) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: reuse })
      let settled = false
      sock.on('error', (error) => {
        log('warn', `发现 socket 出错：${String(error?.message ?? error)}`)
        try { sock.close() } catch { /* 忽略 */ }
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      sock.on('message', (buf, rinfo) => onMessage(buf, rinfo.address))
      sock.bind(port, () => {
        settled = true
        resolve(sock)
      })
    })
  }

  // ── ① 监听 socket（收广播/组播）───────────────────────────
  try {
    const listenSock = await bindSocket({ reuse: true, port: DISCOVERY_PORT })
    sockets.push(listenSock)
    // 加入组播组（可能失败：路由器/系统不支持，忽略）
    try {
      listenSock.addMembership(MULTICAST_ADDR)
      log('info', `发现服务已监听 ${DISCOVERY_PORT}（组播 ${MULTICAST_ADDR}）`)
    } catch (error) {
      log('warn', `加入组播组失败（${String(error?.message ?? error)}），只用广播兜底`)
    }
    listenSock.setMulticastTTL(2)
    listenSock.setMulticastLoopback(true)
  } catch (error) {
    log('warn', `发现服务监听失败：${String(error?.message ?? error)}（自动发现不可用，需手配 peer）`)
  }

  // ── ② 发送 socket（广播自己的存在）─────────────────────────
  // ⚠️ 必须绑端口 0（系统随机）：绑 3097 会和监听 socket 抢 → EADDRINUSE → 广播发不出去。
  /** @type {import('node:dgram').Socket | null} */
  let sendSock = null
  try {
    sendSock = await bindSocket({ reuse: false, port: 0 })
    sockets.push(sendSock)
    sendSock.setBroadcast(true)
    sendSock.setMulticastTTL(2)
    sendSock.setMulticastLoopback(true)
  } catch (error) {
    log('warn', `发现服务发送端启动失败：${String(error?.message ?? error)}`)
    sendSock = null
  }

  /**
   * 广播一次自己的存在。
   */
  function announce() {
    if (closed || sendSock === null) return
    const addrs = listLocalAddresses()
    // 每个接口都报一遍（多网卡时对方总有一条能通）
    for (const { address, netmask } of addrs) {
      const payload = Buffer.from(JSON.stringify({ ...basePayload, host: address }), 'utf8')
      // 组播
      sendSock.send(payload, DISCOVERY_PORT, MULTICAST_ADDR, () => { /* 发不出去就算了 */ })
      // 广播（子网广播 + 全局广播，两条都试）
      const subnetBc = subnetBroadcast(address, netmask)
      if (subnetBc !== null) {
        sendSock.send(payload, DISCOVERY_PORT, subnetBc, () => { /* 忽略 */ })
      }
      sendSock.send(payload, DISCOVERY_PORT, BROADCAST_ADDR, () => { /* 忽略 */ })
    }
  }

  // 立刻广播一次，然后定时
  announce()
  timer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  log('info', `自动发现已启动（本端 ${cfg.label}，每 ${ANNOUNCE_INTERVAL_MS / 1000} 秒广播一次）`)

  return {
    /**
     * 取当前可用的对端地址。
     *
     * @param {string} [preferred] - 优先匹配的 identity（配置里指定了 peer 时用）。
     * @returns {{address: string, port: number, label: string} | null} 对端，或 null = 没发现。
     */
    peer(preferred) {
      const now = Date.now()
      // 清掉过期的
      for (const [id, p] of peers) {
        if (now - p.lastSeen > PEER_STALE_MS) peers.delete(id)
      }
      if (peers.size === 0) return null
      if (typeof preferred === 'string' && peers.has(preferred)) {
        const p = peers.get(preferred)
        return { address: p.address, port: p.port, label: p.label }
      }
      // 没指定就取最近见过的
      let best = null
      for (const p of peers.values()) {
        if (best === null || p.lastSeen > best.lastSeen) best = p
      }
      return best === null ? null : { address: best.address, port: best.port, label: best.label }
    },

    /**
     * 发现状态（工具/日志用）。
     * @returns {object} 状态快照。
     */
    status() {
      const now = Date.now()
      return {
        listening: sockets.length > 0,
        port: DISCOVERY_PORT,
        peers: [...peers.values()].map((p) => ({
          identity: p.identity,
          label: p.label,
          address: p.address,
          port: p.port,
          ageMs: now - p.lastSeen,
          stale: now - p.lastSeen > PEER_STALE_MS,
        })),
      }
    },

    /**
     * 关闭发现服务。
     * @returns {Promise<void>} 关闭完成。
     */
    async close() {
      closed = true
      if (timer !== undefined) clearInterval(timer)
      for (const sock of sockets) {
        try { sock.close() } catch { /* 忽略 */ }
      }
    },
  }
}
