/**
 * sync —— 比对两端清单，把该传的传过去。
 *
 * 决策表（这是整个插件唯一需要看懂的东西）：
 *
 *   本端 | 对端 | sha256 | 动作
 *   ---- | ---- | ------ | --------------------------------------------
 *   有   | 无   |  -     | 推给对端
 *   无   | 有   |  -     | 从对端拉
 *   有   | 有   | 相同   | 跳过（绝大多数情况，一次都不传）
 *   有   | 有   | 不同   | 比 mtime：新的赢
 *        但若**要拉取覆盖本端**、而本端文件在 protectMs 内刚改过 → 保护本端，记冲突，本次不拉
 *
 * 为什么不用「时间戳变了就传」：cp / 解压 / 换时区都会改 mtime 而不改内容，
 * 那会变成每次都全量传输。**内容哈希才是「一样不一样」的判据**，
 * mtime 只用来判「谁后改的」。
 *
 * [!] 2026-10-23 12:4x 修 bug（大肥鱼定位、主人批准）：
 *     protectMs 的语义是「本地文件刚改过，**别被对端覆盖**」——
 *     它只该管「拉取」这一个动作。原来在「本端较新 → 推送」那条分支里也套了它，
 *     结果是：**我刚改完文件，立刻同步 → 报「本端刚改过，保护不覆盖」→ 不推**，
 *     推给别人根本不会覆盖我自己，这个保护在这里是纯伤害。
 *     表现：改完文件要干等 90 秒才能推出去，报告还写着「冲突」，看着像出错了。
 *     → 现在：推送分支不看 protectMs；只有「对端较新、要拉下来覆盖我」时才保护。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildManifest, indexManifest, sha256, resolveAllowedKey } from './manifest.js'
import { readOutbox, writeOutbox, mergeOutbox } from './wakeup.js'

/**
 * 探测一个 `host:port` 是否活着（快速 TCP 握手）。
 * @param {string} hostPort - 形如 `192.168.1.10:3098`。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<boolean>} true = 能连。
 */
async function probePeer(hostPort, timeoutMs = 1500) {
  try {
    const [host, portText] = hostPort.split(':')
    const port = Number(portText)
    if (!host || !Number.isFinite(port)) return false
    const net = await import('node:net')
    return await new Promise((resolve) => {
      const sock = net.connect({ host, port })
      const done = (ok) => {
        try { sock.destroy() } catch { /* 忽略 */ }
        resolve(ok)
      }
      sock.setTimeout(timeoutMs, () => done(false))
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
    })
  } catch {
    return false
  }
}

/**
 * 解析本次同步该连哪个地址。
 *
 * 优先级（这是「IP 变了也能连上」的关键）：
 *   ① 配置里手写的 peer —— **先探一下通不通**，通了就用（最快、最可控）
 *   ② 自动发现到的地址 —— 手配的不通时用它（IP 换了也能救回来）
 *   ③ 都没有 → null（同步放弃，报清楚原因）
 *
 * 纯自动模式（`peer: 'auto'`）直接跳过 ①。
 *
 * @param {object} cfg - 配置。
 * @param {object} deps - 依赖（可能带 resolvePeer）。
 * @returns {Promise<{address: string, port: number, label: string, source: string}|null>} 解析结果。
 */
async function resolvePeerAddress(cfg, deps) {
  const manual = typeof cfg.peer === 'string' ? cfg.peer.trim() : ''

  // ① 手配的地址（`auto` 表示不要手配）
  if (manual !== '' && manual !== 'auto') {
    if (await probePeer(manual)) {
      return {
        address: manual.split(':')[0],
        port: Number(manual.split(':')[1]),
        label: manual,
        source: 'manual',
      }
    }
    // 手配的不通，往下走自动发现
  }

  // ② 自动发现
  const discovered = typeof deps.resolvePeer === 'function' ? deps.resolvePeer() : null
  if (discovered !== null && discovered !== undefined) {
    return {
      address: discovered.address,
      port: discovered.port,
      label: discovered.label ?? `${discovered.address}:${discovered.port}`,
      source: manual === 'auto' || manual === '' ? 'discovered' : 'discovered-fallback',
    }
  }

  return null
}

/**
 * 拉对端清单。
 * @param {object} cfg - 配置（用 peer / token）。
 * @param {Function} log - 日志。
 * @returns {Promise<object>} 对端清单。
 */
async function fetchManifest(cfg, log) {
  const url = `http://${cfg.peer}/api/manifest`
  const res = await fetch(url, { headers: authHeaders(cfg) })
  if (!res.ok) {
    throw new Error(`拉清单失败：HTTP ${res.status}`)
  }
  const body = await res.json()
  if (!body?.ok) {
    throw new Error(`拉清单失败：${body?.error ?? '未知'}`)
  }
  log('info', `对端 ${body.label}（${body.identity}）清单 ${body.files?.length ?? 0} 个文件`)
  return body
}

/**
 * 构造请求头。
 *
 * `connection: close` 是**必须的**（2026-10-22 踩到）：
 * 不加的话 undici 会复用 keep-alive 连接，CLI 用 `process.exit()` 退出时
 * libuv 会报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
 * 同步这种低频操作不值得省那一次 TCP 握手。
 *
 * @param {object} cfg - 配置。
 * @returns {Record<string, string>} 请求头。
 */
function authHeaders(cfg) {
  return {
    'x-fish-token': cfg.token,
    connection: 'close',
  }
}

/**
 * 从对端下载一个文件并写到本地。
 *
 * 导出是为了让测试能直接验「outbox 并集」那条分支
 * （2026-10-25 加：小肥鱼抓到的「同步把本地消息盖掉」）。
 *
 * @param {object} cfg - 配置。
 * @param {string} key - 相对键。
 * @returns {Promise<number>} 写入字节数。
 */
export async function pullFile(cfg, key) {
  const url = `http://${cfg.peer}/api/file?key=${encodeURIComponent(key)}`
  const res = await fetch(url, { headers: authHeaders(cfg) })
  if (!res.ok) throw new Error(`下载 ${key} 失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const expect = res.headers.get('x-fish-sha256')
  if (typeof expect === 'string' && expect !== '' && sha256(buf) !== expect) {
    throw new Error(`下载 ${key} 校验失败（内容被改）`)
  }
  const abs = join(cfg.home, key)
  await mkdir(dirname(abs), { recursive: true })

  // ── 🔴 outbox 特殊处理：并集，不是覆盖（2026-10-25 加）──────
  //
  // 为什么不能直接覆盖：
  //   `wakeup-outbox.json` 是**两端都在写**的消息队列。
  //   我往里丢「我给她的通知」，她往里丢「她给我的通知」。
  //   直接覆盖 = 一端的消息整个消失。
  //
  //   这跟 2026-10-22「同步把我本地两条覆盖了」是同一个病根：
  //   **按 mtime 比新旧，谁新听谁的** —— 对「共同数据」是错的。
  //
  //   实测代价：小肥鱼 14:12 那轮，她推过来的版本把我的通知盖掉了。
  //
  // 修法：拉之前先读本端那份，把两边的 outbox 做**并集**，再写回去。
  if (key === 'fish-sync/wakeup-outbox.json') {
    let mine = { version: 1, outbox: [] }
    try {
      mine = await readOutbox(abs)
    } catch { /* 读不到就当空 */ }

    let theirs = { version: 1, outbox: [] }
    try {
      const parsed = JSON.parse(buf.toString('utf8'))
      theirs = { version: 1, outbox: Array.isArray(parsed?.outbox) ? parsed.outbox : [] }
    } catch { /* 对端文件坏了就当空，别把本端的也搞坏 */ }

    const merged = mergeOutbox(mine.outbox, theirs.outbox)
    await writeOutbox(abs, { version: 1, outbox: merged })
    return buf.length
  }

  await writeFile(abs, buf)
  return buf.length
}

/**
 * 把一个文件推给对端。
 * @param {object} cfg - 配置。
 * @param {string} key - 相对键。
 * @returns {Promise<number>} 推送字节数。
 */
async function pushFile(cfg, key) {
  const abs = join(cfg.home, key)
  const buf = await readFile(abs)
  const url = `http://${cfg.peer}/api/file?key=${encodeURIComponent(key)}`
  const sha = sha256(buf)
  const t0 = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(cfg),
      'x-fish-sha256': sha,
      'content-type': 'application/octet-stream',
    },
    body: buf,
  })
  const ms = Date.now() - t0
  if (!res.ok) {
    // ── 2026-11-06 加：失败也带上对端回执的细节 ────────────────
    // 原来只抛 `HTTP ${res.status}`，看不见对端到底说什么。
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 200)
    } catch { /* 读不到就算了，不影响抛错 */ }
    const err = new Error(`上传 ${key} 失败：HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
    err.pushDetail = { key, ok: false, status: res.status, sha8: sha.slice(0, 8), ms, detail }
    throw err
  }
  return {
    bytes: buf.length,
    // ── 2026-11-06 加：把对端回执的细节带回去 ──────────────────
    // 为什么：主人点名要「明确信退没退过去」。
    // 原来 report.pushed 只有 { key, bytes } —— 那是**本端推了多少**，
    // 不是**对端收没收到**。虽然 HTTP 200 已经是对端回执，但那个信息被丢了。
    pushDetail: { key, ok: true, status: res.status, sha8: sha.slice(0, 8), ms },
  }
}

/**
 * 记一次「跳过」，**按原因分类**（2026-10-26 加）。
 *
 * ## 为什么要这个函数
 *
 * 原来四处都是裸的 `report.skipped += 1`，最后统一说「跳过 N 个（内容相同）」。
 * **但四处里只有一处是真的「内容相同」** —— 另外三处分别是「太大没传」「不在范围」。
 *
 * ## 三种原因
 *
 * | reason | 含义 | 算「内容相同」吗 |
 * |---|---|---|
 * | `'same'` | 两边都有，sha256 相等 | ✅ 算 |
 * | `'too-large'` | 超过 `MAX_FILE_BYTES`，没算 sha256 | ❌ 不算 |
 * | `'out-of-scope'` | 对端有，但本端 `resolveAllowedKey` 不认 | ❌ 不算 |
 *
 * **⚠️ 三者的共同点是「这次没传」，但「为什么没传」完全不同。**
 * **混成一个数字，读的人就会把「没传」误读成「已经一样了」。**
 *
 * @param {object} report - 同步报告（就地改）。
 * @param {string} key - 文件键。
 * @param {'same'|'too-large'|'out-of-scope'} reason - 为什么跳过。
 * @returns {void}
 */
function noteSkip(report, key, reason) {
  report.skipped += 1
  if (reason === 'same') report.skippedSame += 1
  else if (reason === 'too-large') report.skippedTooLarge += 1
  else if (reason === 'out-of-scope') report.skippedOutOfScope += 1
  report.skippedDetail.push({ key, reason })
}

/**
 * 执行一次完整同步。
 *
 * @param {object} cfg - 已归一化配置。
 * @param {object} [deps] - 注入依赖。
 * @param {Function} [deps.log] - 日志函数 (level, msg)。
 * @param {Date}   [deps.now] - 当前时间（测试用）。
 * @param {Function} [deps.resolvePeer] - 动态解析对端地址。
 *        返回 `{address, port, label}` 或 null。没给就用 cfg.peer 里写死的。
 * @returns {Promise<object>} 同步报告。
 */
export async function syncOnce(cfg, deps = {}) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? new Date()
  const startedAt = Date.now()

  // ── 解析对端地址（可能来自自动发现）────────────────────────
  const peerInfo = await resolvePeerAddress(cfg, deps)

  const report = {
    ok: true,
    identity: cfg.identity,
    label: cfg.label,
    peer: peerInfo === null ? cfg.peer : `${peerInfo.address}:${peerInfo.port}`,
    peerSource: peerInfo?.source ?? 'none',
    startedAt: new Date(startedAt).toISOString(),
    pushed: [],
    pulled: [],
    /**
     * ⚠️ `skipped` 是**总数**，保留给老调用方（读出来还是个数）。
     *
     * ## 为什么拆开（2026-10-26 小肥鱼查出，我实测复现）
     *
     * 原来四个地方都 `report.skipped += 1`，最后统一输出「跳过 N 个（内容相同）」。
     * **但那四处里只有一处是真的「内容相同」。**
     *
     * | 行 | 条件 | 真实含义 | 是「内容相同」吗 |
     * |---|---|---|---|
     * | L298 | 对端有、本端没有、`theirs.sha256 === null` | 对端文件太大，没拉 | ❌ |
     * | L330 | 对端有、本端没有、本端不认路径 | 本端拒绝 | ❌ |
     * | L344 | 本端有、对端没有、`mine.sha256 === null` | 本端太大，没推 | ❌ |
     * | L356 | 两边都有、sha256 相等 | 真的相同 | ✅ |
     *
     * ## 实测（我亲手跑的，不是读代码推的）
     *
     * 往 `知识库/主人/`（`mode=dir`，active）放一个 9MB 文件（上限 8MB）：
     * ```
     * 放之前      跳过 81
     * 放之后      跳过 82      ← +1
     * 推送 0 个 · 拉取 0 个
     * ```
     * **而对端 manifest 里根本没有这个文件（她 81 个，我 82 个）。**
     *
     * **⚠️ 一个「对端根本没有」的文件，被报成了「内容相同」。**
     *
     * ## 后果
     *
     * 2026-10-26 13:0x 小肥鱼看到「跳过 55 个（内容相同）」，
     * 在给主人的回复里写「这是今天第一次能用『内容相同』证明链路真通」。
     * **结论碰巧对（对端确实有那个文件），但理由是错的。**
     * **⚠️ 「碰巧对」比「错」更危险 —— 它不会让人回头去查。**
     */
    skipped: 0,
    /** 真的两端都有且 sha256 相同。 */
    skippedSame: 0,
    /** 超过 MAX_FILE_BYTES，没算 sha256（拉/推都不做）。 */
    skippedTooLarge: 0,
    /** 对端有，但本端 `resolveAllowedKey` 不认这个路径。 */
    skippedOutOfScope: 0,
    /** 分类明细：`{key, reason}`。方便日志/界面按文件列出来。 */
    skippedDetail: [],
    conflicts: [],
    errors: [],
    durationMs: 0,
  }

  if (peerInfo === null) {
    report.ok = false
    report.errors.push(
      cfg.peer === ''
        ? '没有对端：未配置 peer，自动发现也没找到（两端都在同一局域网、都开着 DSH 吗？）'
        : `连不上对端 ${cfg.peer}，自动发现也没找到替代地址`,
    )
    return report
  }
  if (cfg.token === '') {
    report.ok = false
    report.errors.push('未配置 token，拒绝同步（两端必须一致）')
    return report
  }

  /** 用解析出来的地址替换 cfg.peer，后面的请求都走它。 */
  const effective = { ...cfg, peer: `${peerInfo.address}:${peerInfo.port}` }

  // ── 1. 两端清单 ────────────────────────────────────────────
  let remote
  try {
    remote = await fetchManifest(effective, log)
  } catch (error) {
    report.ok = false
    report.errors.push(String(error?.message ?? error))
    report.durationMs = Date.now() - startedAt
    return report
  }

  const local = await buildManifest(cfg, now)
  const localMap = indexManifest(local)
  const remoteMap = indexManifest(remote)

  // ── 2. 逐文件决策 ──────────────────────────────────────────
  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const key of allKeys) {
    const mine = localMap.get(key)
    const theirs = remoteMap.get(key)

    try {
      // 本端没有 → 拉
      if (mine === undefined && theirs !== undefined) {
        if (theirs.sha256 === null) {
          // ⚠️ 对端文件太大（没算 sha256）→ 拉不了。
          //    这**不是**「内容相同」—— 本端根本没有它。
          noteSkip(report, key, 'too-large')
          log('info', `跳过 ${key}（对端文件超限，${theirs.size} 字节，未拉取）`)
          continue
        }

        /**
         * 🔴 拉之前**也要问本端白名单**（2026-10-24 加）—— 修安全边界漏洞。
         *
         * ## 原来漏在哪
         *
         * `localMap` 是 `buildManifest(cfg)` 出来的，**它过了 `resolveAllowedKey`**
         * （也就是过了本端 targets）。
         * 但 `remoteMap` 是**对端的清单，直接用，没有任何过滤**。
         *
         * 于是判据变成「**对端有、本端没有 → 拉**」，本端允许什么在这条路径上**完全没参与**。
         *
         * ## 实测（不是推演）
         *
         * 2026-10-24 撤日记提案时：
         *   · 本端已经不认那个路径了 —— 向自己 3098 要它 → **403**
         *   · 但同步**照样把它拉进来了** —— 因为对端还认
         *
         * 也就是：**`targets` 只在「推」的方向管用；「拉」的方向是空的。**
         * 对端认一个本端不认的路径，就能把文件塞进本端。
         * （现在还有 `ALLOWED_ROOTS` 顶层白名单兜着，所以没出大事 ——
         *  但「我以为它管着」和「它真的管着」是两回事。）
         *
         * ## 修法
         *
         * 拉之前跑一次本端的 `resolveAllowedKey`，不在范围内就**跳过**。
         * 本地如果还留着旧文件，**不主动删** —— 那是主人的文件，我们只负责同步。
         */
        if ((await resolveAllowedKey(cfg, key, now)) === null) {
          // ⚠️ 对端有、本端不认这个路径 → 本端拒绝。
          //    这**不是**「内容相同」—— 两边状态是「她有我没有」。
          noteSkip(report, key, 'out-of-scope')
          log('info', `跳过 ${key}（对端有，但不在本端目标范围内）`)
          continue
        }

        const bytes = await pullFile(effective, key)
        report.pulled.push({ key, bytes })
        log('info', `拉取 ${key}（${bytes} 字节）`)
        continue
      }

      // 对端没有 → 推
      if (mine !== undefined && theirs === undefined) {
        if (mine.sha256 === null) {
          // ⚠️ 本端文件太大（没算 sha256）→ 推不了。
          //    这**不是**「内容相同」—— 对端根本没有它。
          //    （2026-10-26 实测：放个 9MB 文件，「跳过」+1，但对端 manifest 里没有它。）
          noteSkip(report, key, 'too-large')
          log('info', `跳过 ${key}（本端文件超限，${mine.size} 字节，未推送）`)
          continue
        }
        const r = await pushFile(effective, key)
        report.pushed.push({ key, bytes: r.bytes, detail: r.pushDetail })
        log('info', `推送 ${key}（${r.bytes} 字节，对端 HTTP ${r.pushDetail.status}）`)
        continue
      }

      // 两边都有
      if (mine !== undefined && theirs !== undefined) {
        /**
         * ⚠️ 两边都超限（`sha256 === null`）→ **没法比，但不是「相同」**。
         *
         * ## 这个坑是 2026-10-26 写 skip 分类测试时抓出来的
         *
         * 原来的判据是 `mine.sha256 === theirs.sha256`。
         * 两边都超限时，`null === null` 为 **true** → 判成「内容相同」。
         *
         * **⚠️ 但 `null` 的含义是「没算哈希」，不是「哈希相等」。**
         * 两个不同的 9MB 文件，都会被判成「相同」，然后**永远不同步**。
         *
         * 实测（test/skip.mjs 诊断输出）：
         * ```
         * 含 toobig 的明细: [
         *   {"key":".../_toobig-大肥鱼.md",  "reason":"same"},      ← ❌ 它其实超限
         *   {"key":".../_fake-toobig.md",    "reason":"too-large"}
         * ]
         * ```
         *
         * ## 判据
         *
         * **`null` 参与比较时，先问「这个 null 是什么意思」。**
         * 「没有值」和「值是 null」在 `===` 眼里一样，但语义完全不同。
         */
        if (mine.sha256 === null && theirs.sha256 === null) {
          noteSkip(report, key, 'too-large')
          log('info', `跳过 ${key}（两端文件都超限，无法比较内容）`)
          continue
        }

        // ⚠️ 必须显式排除 null：否则「本端有哈希、对端 null」也可能走进这里
        if (mine.sha256 !== null && mine.sha256 === theirs.sha256) {
          // ✅ 这一处才是真的「内容相同」。
          noteSkip(report, key, 'same')
          continue
        }

        // 内容不同 → 比 mtime
        const mineIsNewer = mine.mtimeMs > theirs.mtimeMs
        const ageMs = Date.now() - mine.mtimeMs
        /**
         * 本端文件是不是「刚改过」。
         *
         * ⚠️ `cfg.protectMs > 0` 这个前置判断**不能省**（2026-10-23 抓到）。
         *
         * `ageMs` 可以是**负数** —— NTFS 的 mtime 精度比 `Date.now()` 细，
         * 文件刚写完时 mtime 会「稍晚」于当前时间（实测见过 -3.56ms）。
         * 于是 `ageMs < 0` 成立 → `protectMs = 0`（本意是「完全不保护」）
         * 反而变成「永远保护」，同步随机报冲突、概率约 1/5。
         *
         * 这个 bug 在 `protectms.mjs` 第 3 条用例上偶发失败才暴露出来 ——
         * **偶发失败不许当没事，它是判据在告诉你「有个边界没想清」。**
         */
        const recentlyTouched = cfg.protectMs > 0 && ageMs < cfg.protectMs

        if (mineIsNewer) {
          // 本端较新 → 推。
          // [!] 这里**不能**看 protectMs：推送只是把本地内容发出去，不会覆盖本端，
          //     「保护本端不被覆盖」在推送分支下是自相矛盾的条件。
          //     原来套了这个判断 → 改完文件立刻同步会被拦下、干等 90 秒，还报成「冲突」。
          const r2 = await pushFile(effective, key)
          report.pushed.push({ key, bytes: r2.bytes, detail: r2.pushDetail })
          log('info', `推送 ${key}（本端较新，对端 HTTP ${r2.pushDetail.status}）`)
        } else {
          // 对端较新，本端也刚改过 → 冲突，保留本地并报告
          // （protectMs 只在这里生效：马上要 pullFile 覆盖本端了，才需要保护）
          if (recentlyTouched) {
            report.conflicts.push({
              key,
              reason: '两端都改过，本端较旧但刚被改动，保留本地',
              localMtime: mine.mtimeMs,
              remoteMtime: theirs.mtimeMs,
            })
            continue
          }
          const bytes = await pullFile(effective, key)
          report.pulled.push({ key, bytes })
          log('info', `拉取 ${key}（对端较新）`)
        }
      }
    } catch (error) {
      report.ok = false
      // ── 2026-11-06 加：失败的推送单独记一份结构化明细 ────────────
      // 为什么：主人点名要「明确信退没退过去」。
      // errors 是给人读的字符串；这里留一份机器可查的。
      if (error?.pushDetail) {
        report.pushedFailed = Array.isArray(report.pushedFailed) ? report.pushedFailed : []
        report.pushedFailed.push(error.pushDetail)
      }
      report.errors.push(`${key}: ${String(error?.message ?? error)}`)
    }
  }

  report.durationMs = Date.now() - startedAt
  // ── 2026-11-06 加：给一句能直接被读懂的结论 ────────────────────
  // 原来那句「推 0 / 拉 0 / 跳过 150」读的人会误以为是「已经同步好了」。
  // 实际「跳过」的语义是**本端判断对端已有**（本地推断），不是对端的回答。
  // 所以补一句说清楚：真正能证明「对端收到」的，是 pushed 里每条带的 HTTP 状态。
  report.verdict =
    report.pushed.length > 0
      ? `本轮真推送 ${report.pushed.length} 个，对端已回执（见 pushed[].detail.status）`
      : report.pulled.length > 0
        ? `本轮只拉了 ${report.pulled.length} 个，没推东西`
        : '本轮没推没拉 —— 这只说明本端判断「对端已有」，不等于对端确认过'
  if (report.pushedFailed?.length) {
    report.verdict += `；⚠️ 有 ${report.pushedFailed.length} 个推送失败（见 pushedFailed）`
  }
  log('info', `同步完成：推 ${report.pushed.length} / 拉 ${report.pulled.length} / 跳过 ${report.skipped} / 冲突 ${report.conflicts.length}`)
  return report
}
