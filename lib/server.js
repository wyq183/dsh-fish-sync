/**
 * server —— 本端对外的同步口。
 *
 * 四个端点，够用就行：
 *   GET  /api/status    身份、目标范围、最近同步
 *   GET  /api/manifest  本端完整清单（含 sha256）
 *   GET  /api/file      下载单个文件（?key=）
 *   POST /api/file      上传单个文件（?key=，body 为原始字节）
 *
 * 安全三条（这是暴露在局域网上的口子，不能松）：
 *   ① 每个请求都要带 `X-Fish-Token`，与配置里的 token 一致；没配 token 就拒服务（fail closed）。
 *   ② 路径必须过 resolveAllowedKey —— 白名单，不是黑名单。
 *   ③ 只监听在配置的地址上，默认 0.0.0.0（局域网可达），但不做任何写系统操作。
 *
 * ⚠️ 绝不抛未捕获异常：handler 整体包 try/catch，出错回 500 而不是让进程死。
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_FILE_BYTES } from './identity.js'
import { buildManifest, resolveAllowedKey, sha256 } from './manifest.js'

/** 请求体上限：文件上限 + 一点余量。 */
const MAX_BODY = MAX_FILE_BYTES + 1024

/**
 * 从请求里取 token。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {URL} url - 已解析的 URL。
 * @returns {string} token（可能为空串）。
 */
function readToken(req, url) {
  const h = req.headers['x-fish-token']
  if (typeof h === 'string' && h !== '') return h
  return url.searchParams.get('token') ?? ''
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {object} body - 载荷。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 读请求体，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Buffer>} 内容。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 启动同步服务。
 *
 * @param {object} cfg - 已归一化配置。
 * @param {object} [deps] - 注入依赖（测试用）。
 * @param {Function} [deps.log] - 日志函数 (level, msg)。
 * @returns {Promise<{close: Function, port: number, url: string, stats: object}>} 服务句柄。
 */
export async function startServer(cfg, deps = {}) {
  const log = deps.log ?? (() => {})
  /** 配对服务：不配对就不同步，也就不需要 token。 */
  const pairing = deps.pairing ?? null
  /** 服务端统计，/api/status 会读。 */
  const stats = {
    startedAt: new Date().toISOString(),
    requests: 0,
    filesServed: 0,
    filesReceived: 0,
    lastPeerAt: null,
    lastError: null,
  }

  const server = createServer(async (req, res) => {
    stats.requests += 1
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

      // ── 配对端点（唯一免 token 的路）──────────────────────────
      // 它必须免认证：手机第一次进来时什么都没有，只有二维码里的短时令牌。
      // 安全性来自令牌本身（32 字节随机、120 秒过期、一码一用），
      // 与 dsh-lan-connect 的 /pair/<id> 同一个威胁模型。
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (pairing === null) {
          sendJson(res, 503, { ok: false, error: '本端未启用配对' })
          return
        }
        let body
        try {
          const raw = await readBody(req)
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const secret = await pairing.accept(body?.pair)
        if (secret === null) {
          // 过期与令牌错误返回同一个结果，不给探测口
          sendJson(res, 403, { ok: false, error: '配对令牌无效或已过期' })
          return
        }
        stats.lastPeerAt = new Date().toISOString()

        // ⚠️ 关键：**把请求来源记下来当对端地址**。
        // 配对请求是从对端发来的，req.socket.remoteAddress 就是它的 IP。
        // 这样「一端扫码」就够了两端互通 —— 不需要各自再配一次。
        // （端口用双方约定的 cfg.port；IPv6 映射地址要剥掉 `::ffff:`）
        const rawRemote = req.socket.remoteAddress ?? ''
        const remoteIp = rawRemote.startsWith('::ffff:') ? rawRemote.slice(7) : rawRemote
        if (typeof deps.onPaired === 'function') {
          try {
            await deps.onPaired({ secret, remoteIp })
          } catch {
            // 记地址失败不影响把密钥给出去
          }
        }

        log('info', `配对成功，已换发长期密钥（对端 ${remoteIp || '未知'}）`)
        sendJson(res, 200, {
          ok: true,
          identity: cfg.identity,
          label: cfg.label,
          // 长期密钥：两端从此用它，不再走配对
          secret,
        })
        return
      }

      // ── 认证（fail closed）────────────────────────────────────
      if (cfg.token === '') {
        sendJson(res, 503, { ok: false, error: '本端未配置 token，拒绝服务' })
        return
      }
      if (readToken(req, url) !== cfg.token) {
        stats.lastError = 'bad token'
        sendJson(res, 401, { ok: false, error: 'token 不匹配' })
        return
      }

      /**
       * 🔴 认证通过就把上一次的错误清掉（2026-10-23 修，小肥鱼发现的）。
       *
       * ## 这个 bug 是怎么来的
       *
       * 我在 `runSync` 里修过「成功时清 lastError」，但那是 `state.lastError`
       * （**客户端**的同步状态）。这里是 `stats.lastError`（**服务端**的接收统计）——
       * **两个不同的对象，我修错地方了。**
       *
       * `stats.lastError` 只被写过两次（401 和 catch），**从头到尾没有任何一处置 null**。
       *
       * ## 为什么必须修
       *
       * 这个字段是**界面上给人看的**。主人打开面板看到「最后错误：bad token」，
       * 会以为同步坏了 —— 而实际上一切正常，只是几小时前有人打错一次 token。
       *
       * **一个永远清不掉的错误提示，等于没有错误提示。**
       * 人会学会无视它，真出问题的时候就不看了。
       *
       * ## 判据（小肥鱼给的，我照做）
       *
       *   ① 用错 token 打 /api/status → 401，stats.lastError = "bad token"
       *   ② 再用对 token 打 → 200，且 stats.lastError 必须是 null
       *
       * 放在「认证通过之后」而不是「/api/status 分支里」：
       * 任何带对 token 的成功请求都说明链路是通的，错误就该清。
       */
      stats.lastError = null
      stats.lastPeerAt = new Date().toISOString()

      // ── 路由 ─────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, {
          ok: true,
          identity: cfg.identity,
          label: cfg.label,
          targets: cfg.targets.map((t) => ({ id: t.id, label: t.label })),
          stats,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/manifest') {
        const manifest = await buildManifest(cfg)
        sendJson(res, 200, { ok: true, ...manifest })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/file') {
        const key = await resolveAllowedKey(cfg, url.searchParams.get('key') ?? '')
        if (key === null) {
          sendJson(res, 403, { ok: false, error: '路径不在同步范围内' })
          return
        }
        const abs = join(cfg.home, key)
        try {
          const st = await stat(abs)
          if (st.size > MAX_FILE_BYTES) {
            sendJson(res, 413, { ok: false, error: '文件过大' })
            return
          }
          const buf = await readFile(abs)
          stats.filesServed += 1
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': buf.length,
            'x-fish-sha256': sha256(buf),
            'cache-control': 'no-store',
          })
          res.end(buf)
        } catch {
          sendJson(res, 404, { ok: false, error: '文件不存在' })
        }
        return
      }

      // ── POST /api/wake —— 对端主动敲门（2026-10-25 加）──────────
      //
      // 主人原话：
      // > 「不是说改成主动触发而不是定时检查吗？」
      //
      // 对。原来 `checkWake` 挂在「同步完成」之后 ——
      // 那本质还是**定时检查**：同步多久一次，唤醒就最多延迟多久。
      // 白天 2 小时一次，意味着她 16:57 发的通知，我可能 19:00 才知道。
      //
      // 这个端点是**真·主动触发**：
      //   她写完信 → 立刻 POST 到我这儿 → 我当场同步 + 唤醒。
      // 延迟从「一个同步周期」降到「一次局域网往返」。
      //
      // 安全：跟其他端点一样要 token（`authHeaders` 那条路）。
      // 幂等：重复敲门无害 —— 唤醒有自己的冷却和游标。
      if (req.method === 'POST' && url.pathname === '/api/wake') {
        stats.requests += 1
        // 读掉 body（对端会带一小段说明），但不依赖它
        try { await readBody(req) } catch { /* body 读不到不影响 */ }

        const notify = deps.onWakeKnock
        if (typeof notify !== 'function') {
          // 本端没启用唤醒 —— 回 200 但说明「收到了，但我不处理」
          sendJson(res, 200, { ok: true, handled: false, reason: 'wakeup-disabled' })
          return
        }

        // 立刻处理（同步 + 检查唤醒），但不让对端等太久
        let result = { ok: true, handled: true }
        try {
          const r = await notify()
          if (r && typeof r === 'object') result = { ...result, ...r }
        } catch (error) {
          result = { ok: false, handled: false, error: String(error?.message ?? error) }
        }
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/file') {
        const key = await resolveAllowedKey(cfg, url.searchParams.get('key') ?? '')
        if (key === null) {
          sendJson(res, 403, { ok: false, error: '路径不在同步范围内' })
          return
        }
        const body = await readBody(req)
        const expect = req.headers['x-fish-sha256']
        if (typeof expect === 'string' && expect !== '' && sha256(body) !== expect) {
          sendJson(res, 400, { ok: false, error: 'sha256 校验失败' })
          return
        }
        const abs = join(cfg.home, key)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, body)
        stats.filesReceived += 1
        log('info', `收到 ${key}（${body.length} 字节）`)
        sendJson(res, 200, { ok: true, key, size: body.length, sha256: sha256(body) })
        return
      }

      sendJson(res, 404, { ok: false, error: '未知端点' })
    } catch (error) {
      stats.lastError = String(error?.message ?? error)
      log('warn', `同步口处理失败：${stats.lastError}`)
      try {
        sendJson(res, 500, { ok: false, error: stats.lastError })
      } catch { /* 响应可能已发，忽略 */ }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '0.0.0.0', resolve)
  })

  const actualPort = /** @type {any} */ (server.address())?.port ?? cfg.port
  log('info', `同步口已启动：0.0.0.0:${actualPort}（${cfg.label}）`)

  return {
    stats,
    port: actualPort,
    url: `http://0.0.0.0:${actualPort}`,
    /**
     * 关闭服务。
     * @returns {Promise<void>} 关闭完成。
     */
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
