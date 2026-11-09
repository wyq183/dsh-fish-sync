/**
 * @dsh-external/dsh-fish-sync —— 宿主侧入口
 *
 * 大肥鱼（电脑）与小肥鱼（手机）的记忆同步：**只同步「任务」与「今日记忆」**。
 *
 * 三件事：
 *  ① 开一个同步口（默认 3098），让对端能拉本端清单与文件
 *  ② 定时主动同步：白天每 5 分钟，夜间（主人睡觉时段）每 2 分钟
 *  ③ 暴露工具 fish_sync_now / fish_sync_status，随时手动触发与查状态
 *
 * 还有第 ④ 件（2026-10-22 加）：**自动发现**。
 * 两端用 UDP 组播+广播互相喊「我在 192.168.x.x:3098」，
 * 所以 IP 变了、换了网络，只要还在同一局域网就能自己找到对方。
 * 详见 lib/discovery.js 顶部（为什么不用标准 mDNS）。
 *
 * 铁律（照抄 dsh-yiqi-memory 换来的教训，别重犯）：
 *   · **绝不导出 `Config`** —— cordis 的 `resolveConfig()` 会硬取
 *     `runtime.Config['~standard'].validate`，自造形状没有它 → TypeError
 *     → 被 `_reload` 的 catch 吞掉 → apply 一次都不会被调用（不报错、不留痕）。
 *   · **必须导出 `inject`** —— 否则 apply 执行时服务还没就绪，静默不注册。
 *   · **apply 与所有回调里绝不抛未捕获异常** —— 会被归类为 fatal load failure，
 *     **直接杀掉宿主进程**。
 *   · **工具的 `output` 不能省** —— 缺了会 throw TypeError（2026-10-22 手机上真踩过）。
 */

import os from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeConfig, isNightWindow, IDENTITIES, attachDynamicTargets } from './identity.js'
import { startServer } from './server.js'
import { syncOnce } from './sync.js'
import { startDiscovery } from './discovery.js'
import { PairingService, qrPayload, newSecret } from './pairing.js'
import { createHandler, ROUTE_PATH } from './http.js'
import { qrSvg } from './qr.js'
import {
  readOutbox,
  writeOutbox,
  readLocalState,
  writeLocalState,
  mergeOutbox,
  decideWake,
  recordWake,
  buildWakePrompt,
  appendOutbox,
} from './wakeup.js'
import {
  readTargetsFile,
  writeTargetsFile,
  mergeProposals,
  resolveActiveTargets,
  addProposal,
  castVote,
  proposalState,
  withdrawProposal,
} from './targets.js'

/** 稳定的插件名。 */
export const name = 'fish-sync'

/**
 * 插件依赖的服务。
 *
 * ⚠️ `webServer` **必须在这里声明**（2026-10-22 踩到）：
 *   管理面（`/ext/fish-sync/`）要靠 `ctx.inject(['connection'], …)` 里的
 *   `connectionCtx.webServer.register()` 挂载。如果不声明 webServer，
 *   插件的 apply 可能在 webServer 就绪前就跑完了，
 *   后面那个 inject 回调永远等不到 → **路由 404，而插件看起来"正常加载"**
 *   （3098 在听、工具也注册了，就是管理页 404）。
 *   对照：dsh-lan-connect 导出的就是 `inject = ['webServer']`。
 *
 * `sessionController` 是 **2026-10-25 加的**，用于信箱唤醒：
 *   要用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content })`
 *   往一个固定会话里派发 prompt（先例：`dsh-artifact-library/lib/refine-session.js`）。
 *
 *   ⚠️ 没声明的话 `ctx.sessionController` 是 undefined —— 唤醒会静默失败。
 *   所以 `apply` 一开始的 diag 里记了 `hasSessionController`，出问题先看它。
 */
export const inject = ['tools', 'webServer', 'sessionController']

/**
 * 工具的 output 描述。宿主要求 `{ schema, render }`，缺了会 throw。
 * 照 dsh-yiqi-memory/lib/tools.js 的同名函数（本机已验证可用）。
 * @returns {object} output 定义。
 */
function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
}

/**
 * 把 peerSource 翻成人话。
 * @param {string} source - 来源标记。
 * @returns {string} 中文说明。
 */
function peerSourceText(source) {
  switch (source) {
    case 'manual': return '手配地址'
    case 'discovered': return '自动发现'
    case 'discovered-fallback': return '手配不通，自动发现接管'
    default: return '未知'
  }
}

/**
 * 把「跳过」那一行拼出来 —— **按原因分类**（2026-10-26 加）。
 *
 * ## 为什么不能只说「内容相同」
 *
 * 原来固定输出 `跳过 N 个（内容相同）`，但那个 N 里混了三种完全不同的情况：
 *
 * | 原因 | 真实含义 | 是「内容相同」吗 |
 * |---|---|---|
 * | `same` | 两边都有，sha256 相等 | ✅ 算 |
 * | `too-large` | 超 8MB，根本没传 | ❌ 不算 |
 * | `out-of-scope` | 本端不认这个路径，拒收 | ❌ 不算 |
 *
 * **⚠️ 后果不是「说得不准」，是「让人得出反向结论」。**
 *
 * 2026-10-26 实测：往 `知识库/主人/` 放一个 9MB 文件（上限 8MB），
 * 输出从「跳过 81」变成「跳过 82」，**而推送 0 个、对端 manifest 里也没有它**。
 * 也就是说，一个「她那边根本没有」的文件，被报成了「内容相同」。
 *
 * 小肥鱼 13:0x 就因为这个措辞，在给主人的回复里写
 * 「这是今天第一次能用『内容相同』证明链路真通」——
 * **结论碰巧对，理由是错的。碰巧对比错更危险：它不会让人回头去查。**
 *
 * ## 输出形状
 *
 * ```
 * 跳过 82 个（内容相同 78 · 超限 3 · 不在范围 1）
 * ```
 * 三种都为 0 时退回简短形式，不啰嗦。
 *
 * @param {object} r - 同步报告。
 * @returns {string} 一行中文。
 */
function skippedLine(r) {
  const total = r.skipped ?? 0
  const same = r.skippedSame ?? 0
  const tooLarge = r.skippedTooLarge ?? 0
  const outOfScope = r.skippedOutOfScope ?? 0

  // 老报告（改动前产生的）没有分类字段 → 退回旧措辞，但**标明未分类**
  if (same + tooLarge + outOfScope === 0 && total > 0) {
    return `跳过 ${total} 个（⚠️ 未分类：老报告没有分类字段）`
  }
  if (total === 0) return '跳过 0 个'

  const parts = []
  if (same > 0) parts.push(`内容相同 ${same}`)
  if (tooLarge > 0) parts.push(`超限 ${tooLarge}`)
  if (outOfScope > 0) parts.push(`不在范围 ${outOfScope}`)
  return `跳过 ${total} 个（${parts.join(' · ')}）`
}

/** dsh home：优先环境变量，其次 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return `${os.homedir()}/.dsh`
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} [rawConfig] - 插件配置。
 */
export function apply(ctx, rawConfig = {}) {
  const log = (level, msg) => {
    try {
      if (level === 'warn' && typeof ctx.logger?.warn === 'function') ctx.logger.warn(`fish-sync: ${msg}`)
      else if (typeof ctx.logger?.info === 'function') ctx.logger.info(`fish-sync: ${msg}`)
    } catch { /* 日志绝不抛 */ }
  }

  /**
   * 诊断记录。desktop（Electron）的 logger 输出看不到，
   * 出了问题只能靠这个文件定位。**只写不读，坏了也不影响功能。**
   * @param {string} stage - 阶段名。
   * @param {object} [extra] - 附加信息。
   */
  const diag = (stage, extra) => {
    try {
      const file = join(dshHome(), 'fish-sync', 'diag.json')
      const prev = (() => {
        try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
      })()
      const next = {
        ...prev,
        lastStage: stage,
        lastAt: new Date().toISOString(),
        stages: [...(Array.isArray(prev.stages) ? prev.stages : []).slice(-19), { stage, at: new Date().toISOString(), ...extra }],
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    } catch { /* 诊断绝不抛 */ }
  }

  diag('apply:enter', {
    hasInject: typeof ctx.inject === 'function',
    hasEffect: typeof ctx.effect === 'function',
    hasWebServer: ctx.webServer !== undefined,
    hasConnection: (() => { try { return ctx.get?.('connection') !== undefined } catch { return 'get-threw' } })(),
    hasSessionController: ctx.sessionController !== undefined,
  })

  /**
   * 唤醒检查函数（同步完成后调它）。
   *
   * 为什么用模块级变量而不是闭包里传：`runSync` 定义在 apply 里，
   * 但它可能在 apply 的不同阶段被调用（定时器 / 工具 / HTTP）。
   * 用一个可空变量最省事 —— 没启用唤醒时它是 null，调用处判一下就行。
   *
   * @type {((trigger: string) => Promise<void>) | null}
   */
  let wakeHook = null

  /**
   * 对端敲门（`POST /api/wake`）时的处理函数。
   *
   * 跟 `wakeHook` 分开是因为语义不同：
   *   wakeHook  = 「同步完了，顺便看看有没有新消息」（被动）
   *   knockHandler = 「对端说它写东西了，去拉 + 看」（主动触发）
   *
   * 2026-10-25 主人点出来的：
   *   > 「不是说改成主动触发而不是定时检查吗？」
   *
   * @type {(() => Promise<object>) | null}
   */
  let wakeKnockHandler = null

  let cfg
  try {
    cfg = normalizeConfig(rawConfig, dshHome())
  } catch (error) {
    log('warn', `配置解析失败：${String(error?.message ?? error)}`)
    return
  }

  /**
   * 提案清单（内存里的当前值）。
   *
   * 2026-10-23 加：主人要「加同步条目不该大费周章」，
   * 于是有了「提案 + 两端投票」这套 —— 详见 lib/targets.js 顶部。
   *
   * 这里存的是**已经合并过的**提案（本端 + 对端），
   * 启动时读盘、同步时从对端拉最新的再合并。
   */
  let proposals = []

  /**
   * 算当前生效的动态目标。
   *
   * 会被 `attachDynamicTargets` 挂成 `cfg.targets` 的 getter ——
   * 所以 manifest / server / 状态快照读到的永远是「内置 + 当前生效的提案」。
   *
   * @returns {object[]} 动态目标（不含内置的）。
   */
  function dynamicTargets() {
    try {
      return resolveActiveTargets(proposals)
    } catch {
      return []
    }
  }

  // 把动态目标挂上去（必须在任何 buildManifest / startServer 之前）
  attachDynamicTargets(cfg, dynamicTargets)

  /**
   * 重新读一次目标清单文件（本端 + 对端合并后的落盘版）。
   *
   * ⚠️ 合并规则在 `mergeProposals` 里：**按 id 取并集，票也取并集**。
   * 不按 mtime 谁新谁赢 —— 那样两端各提一个就会互相覆盖，永远投不齐票。
   *
   * @returns {Promise<void>} 读完。
   */
  async function reloadProposals() {
    try {
      const data = await readTargetsFile(cfg.home)
      proposals = data.proposals
    } catch (error) {
      log('warn', `读目标清单失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 把提案清单落盘（同步完对端清单后调用）。
   * @returns {Promise<void>} 写完。
   */
  async function saveProposals() {
    try {
      await writeTargetsFile(cfg.home, { proposals })
    } catch (error) {
      log('warn', `写目标清单失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 配对状态落盘位置。
   *
   * 里面存的是**配对换来的长期密钥**（`secret`）与对端地址（`peer`）。
   * 与 token 的区别：token 是手配的、永不变的；secret 是扫码换来的、可随时重新配对作废。
   */
  const pairedFile = join(cfg.home, 'fish-sync', 'paired.json')

  /** 运行期状态。 */
  const runtime = {
    /** 配对得来的长期密钥（优先于手配 token）。 */
    secret: '',
    /** 配对得来的对端地址。 */
    peer: '',
  }

  /** 最近一次同步报告，工具要读。 */
  const state = {
    lastSyncAt: null,
    lastReport: null,
    lastError: null,
    serverPort: null,
    syncCount: 0,
    discovery: null,
    /** 最近一次配对时间。 */
    pairedAt: null,
    /**
     * 正在进行的同步（null = 没在同步）。
     *
     * 为什么要有（2026-10-23 主人报「点按钮没有进度提示」）：
     *   同步是一次 HTTP 请求，前端拿不到中间状态，只能干等。
     *   这里把 sync.js 的日志回调转成**阶段文案**，前端轮询 /api/state
     *   就能显示「已连上对端 → 拉取 xxx → 完成」，而不是一个死掉的按钮。
     *
     * 形状：{ active, stage, startedAt, elapsedMs, reason }
     * 结束不清空，只把 active 置 false —— 前端要读最后一帧。
     */
    syncing: null,
  }

  /**
   * 读配对状态（启动时一次）。
   * @returns {Promise<void>} 读完。
   */
  async function loadPaired() {
    try {
      const text = await readFile(pairedFile, 'utf8')
      const data = JSON.parse(text)
      if (typeof data?.secret === 'string') runtime.secret = data.secret
      if (typeof data?.peer === 'string') runtime.peer = data.peer
      if (typeof data?.pairedAt === 'string') state.pairedAt = data.pairedAt
      if (runtime.secret !== '') log('info', '已载入配对密钥（之前扫过码）')
    } catch {
      // 没有就是没配对过，正常
    }
  }

  /**
   * 写配对状态。
   * @param {object} patch - 要合并的字段。
   * @returns {Promise<void>} 写完。
   */
  async function savePaired(patch) {
    try {
      const next = {
        secret: patch.secret ?? runtime.secret,
        peer: patch.peer ?? runtime.peer,
        pairedAt: new Date().toISOString(),
      }
      await mkdir(dirname(pairedFile), { recursive: true })
      await writeFile(pairedFile, JSON.stringify(next, null, 2), 'utf8')
      runtime.secret = next.secret
      runtime.peer = next.peer
      state.pairedAt = next.pairedAt
    } catch (error) {
      log('warn', `配对状态落盘失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 取当前生效的密钥：配对来的优先，其次手配 token。
   * @returns {string} 密钥（可能为空）。
   */
  function effectiveSecret() {
    return runtime.secret !== '' ? runtime.secret : cfg.token
  }

  /**
   * 取当前生效的对端地址：配对来的优先，其次手配 peer。
   * @returns {string} 地址（可能为空）。
   */
  function effectivePeer() {
    if (runtime.peer !== '') return runtime.peer
    return cfg.peer
  }

  /**
   * 用配对码去连对端，换回长期密钥并落盘。
   *
   * 这是**手机端**真正要走的那条路（2026-10-22 加）：
   *   主人看电脑屏幕上的 6 位码 → 在手机浮层里输入 → 手机端主动 POST 到电脑端。
   *
   * 为什么不靠「手机浏览器扫码」：
   *   浏览器扫开的只是一段文本，它没法把密钥交回 DSH 插件里。
   *   配对必须由插件自己发起 —— 因为 secret 要存到本端配置。
   *
   * @param {object} input - 输入。
   * @param {string} input.code - 6 位配对码（或二维码里的长 id）。
   * @param {string} input.host - 对端地址。
   * @param {number} input.port - 对端端口。
   * @returns {Promise<object>} { ok, error?, peer? }。
   */
  async function joinPeer({ code, host, port }) {
    const peerText = `${host}:${port}`
    try {
      const res = await fetch(`http://${peerText}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ pair: code }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.ok !== true || typeof body?.secret !== 'string') {
        const reason = body?.error ?? `HTTP ${res.status}`
        return { ok: false, error: `配对失败：${reason}` }
      }
      await savePaired({ secret: body.secret, peer: peerText })
      log('info', `已与 ${peerText} 配对成功`)
      return { ok: true, peer: peerText, label: body.label ?? '' }
    } catch (error) {
      return { ok: false, error: `连不上 ${peerText}：${String(error?.message ?? error)}` }
    }
  }

  // ── 配对服务 ────────────────────────────────────────────────
  const pairing = new PairingService({
    // 配对成功时把密钥落盘（地址由 server 的 onPaired 另外补上）
    onPaired: async (secret) => {
      await savePaired({ secret })
      log('info', '配对成功，长期密钥已保存')
    },
  })

  /**
   * 生成二维码文本（给界面用）。
   * @returns {string|null} 二维码文本，或 null。
   */
  function currentQrText() {
    const cur = pairing.current()
    if (cur === undefined) return null
    // 二维码里放**本机在局域网里的地址**（扫码的人要能连过来，不能用 127.0.0.1）
    const host = pickLanAddress()
    if (host === null) return null
    return qrPayload({ ...cfg, port: cfg.port }, host, cur.id)
  }

  /**
   * 挑一个局域网地址。
   * @returns {string|null} 地址，或 null。
   */
  function pickLanAddress() {
    const all = pickLanAddresses()
    return all.length === 0 ? null : all[0]
  }

  /**
   * 列出本机所有可用的局域网 IPv4 地址（私有网段优先）。
   *
   * 为什么不是「挑一个」就完事（2026-10-23 加）：
   *   这台机器同时挂着以太网（192.168.1.12）和无线（192.168.1.14）。
   *   手机可能连在任意一侧 —— 只显示一个地址，主人重新配对时
   *   很可能填错，然后一头雾水「明明填了还是连不上」。
   *   全列出来让他挑，比猜准。
   *
   * @returns {string[]} 地址列表（私有网段排前面）。
   */
  function pickLanAddresses() {
    let nets
    try {
      nets = os.networkInterfaces()
    } catch {
      return []
    }
    const priv = []
    const other = []
    for (const list of Object.values(nets)) {
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' || item.internal === true) continue
        if (item.address.startsWith('169.254.')) continue
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) priv.push(item.address)
        else other.push(item.address)
      }
    }
    // 去重（同一地址可能挂多个接口别名）
    return [...new Set([...priv, ...other])]
  }


  /** @type {{peer: Function, status: Function, close: Function} | undefined} */
  let discoveryHandle

  /**
   * 解析对端地址（给 syncOnce 用）。
   * @returns {{address: string, port: number, label: string} | null} 发现到的对端。
   */
  function resolveDiscoveredPeer() {
    try {
      return discoveryHandle?.peer(cfg.peerIdentity === '' ? undefined : cfg.peerIdentity) ?? null
    } catch {
      return null
    }
  }

  // ── ④ 自动发现（先于同步启动，同步要用它的结果）──────────────
  if (cfg.discovery) {
    ctx.effect(() => {
      let closed = false
      void startDiscovery(cfg, { log }).then((handle) => {
        if (closed) {
          void handle.close()
          return
        }
        discoveryHandle = handle
        state.discovery = handle.status()
      }).catch((error) => {
        log('warn', `自动发现启动失败：${String(error?.message ?? error)}（只能靠手配 peer）`)
      })
      return async () => {
        closed = true
        try { await discoveryHandle?.close() } catch { /* 忽略 */ }
      }
    }, 'fish-sync: discovery')
  }

  // ── ① 同步口 ────────────────────────────────────────────────
  /** @type {{close: Function} | undefined} */
  let serverHandle
  ctx.effect(() => {
    let closed = false
    // 密钥可能来自配对（异步读盘），所以服务端要等 loadPaired 之后再起。
    // 但 cfg.token 是同步就有的，先把两个都传进去，服务端每次请求现取。
    //
    // ⚠️🔴 `targets` 必须也写成 getter（2026-10-23 抓到的真 bug）。
    //
    // `{ ...cfg }` 会把 `cfg.targets` 的 getter **展开成快照数组**。
    // 而 `attachDynamicTargets` 装的正是 getter（返回「内置 + 当前生效的提案」）。
    //
    // 后果：server 启动时 proposals 还是空的（`reloadProposals` 是异步的，
    // 在 apply 末尾才读盘）→ `serverCfg.targets` 被冻结成「只有内置目标」
    // → **动态提案在 server 侧永远不生效**，`resolveAllowedKey` 永远拒。
    //
    // 表现特别迷惑：`/api/state` 里 `targets` 明明显示了提案来的目标
    // （因为 state() 读的是原 `cfg.targets`，getter 有效），
    // 但实际推文件时 403 —— **「显示有、实际没有」**。
    //
    // 所以这里必须显式再包一层 getter，让它每次都转发到原 cfg。
    const serverCfg = {
      ...cfg,
      get token() { return effectiveSecret() },
      get targets() { return cfg.targets },
    }
    void startServer(serverCfg, {
      log,
      pairing,
      /**
       * 配对成功：把密钥与**对端地址**一起存下。
       * 地址来自请求来源（server 里剥好 `::ffff:` 了），
       * 这样一端扫码，两端就都知道了对方的地址，不需要各配一次。
       * @param {object} info - { secret, remoteIp }。
       * @returns {Promise<void>} 存完。
       */
      async onPaired({ secret, remoteIp }) {
        const peer = typeof remoteIp === 'string' && remoteIp !== ''
          ? `${remoteIp}:${cfg.port}`
          : runtime.peer
        await savePaired({ secret, peer })
        log('info', `配对完成：对端 ${peer === '' ? '地址未知' : peer}`)
      },
      /**
       * 对端敲门（`POST /api/wake`）时调这个。
       *
       * ⚠️ 必须用 getter 转发，不能传值（2026-10-23 那个 `{ ...cfg }` 坑的同款）：
       *   这个函数是在 apply 的「②b 信箱唤醒」段才赋值的，
       *   而 `startServer` 在「① 同步口」段就被调用了 —— 顺序在前。
       *   直接传值的话这里永远是 `null`，敲门永远不处理。
       */
      get onWakeKnock() {
        return wakeKnockHandler
      },
    }).then((handle) => {
      if (closed) {
        void handle.close()
        return
      }
      serverHandle = handle
      state.serverPort = handle.port
    }).catch((error) => {
      state.lastError = String(error?.message ?? error)
      log('warn', `同步口启动失败：${state.lastError}（端口 ${cfg.port} 可能被占）`)
    })
    return async () => {
      closed = true
      try { await serverHandle?.close() } catch { /* 关闭失败不影响卸载 */ }
    }
  }, 'fish-sync: sync server')

  // ── ①b 管理面（挂在 dsh 本体上，左栏按钮点开就是它）──────────
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      const webServer = connectionCtx.webServer
      diag('mount:enter', {
        hasWebServer: webServer !== undefined,
        hasRegister: typeof webServer?.register === 'function',
        routePath: ROUTE_PATH,
      })
      if (webServer === undefined || typeof webServer.register !== 'function') {
        diag('mount:no-webServer', { webServerType: typeof webServer })
        log('warn', '管理面挂载失败：connectionCtx.webServer 不可用')
        return
      }
      const handler = createHandler({
        ctx: connectionCtx,
        cfg,
        pairing,
        /** 信箱端点要读文件，得知道 dsh home 在哪。 */
        home: cfg.home,
        /**
         * 状态快照（管理页与浮层都读它）。
         * @returns {object} 快照。
         */
        state() {
          const disc = discoveryHandle?.status()
          const cur = pairing.current()
          const r = state.lastReport
          return {
            identity: cfg.identity,
            label: cfg.label,
            peer: effectivePeer() === '' ? '' : (runtime.peer !== '' ? runtime.peer : cfg.peer),
            pairedAt: state.pairedAt,
            serverPort: state.serverPort,
            targets: cfg.targets.map((t) => t.label).join('、'),
            autoSyncText: cfg.autoSync
              ? `开（白天 ${cfg.intervalMs / 60000} 分 / 夜间 ${cfg.nightIntervalMs / 60000} 分）`
              : '关',
            lastSyncAt: state.lastSyncAt,
            lastResult: r === null
              ? null
              : `推 ${r.pushed.length} / 拉 ${r.pulled.length} / 跳过 ${r.skipped} / 冲突 ${r.conflicts.length}`,
            lastError: state.lastError,
            /**
             * 同步进度（2026-10-23 加）。
             *
             * null = 本次会话还没同步过。
             * { active, stage, reason, startedAt, elapsedMs }
             * 前端轮询它，就能在按钮旁边显示「正在拉取 xxx · 1.2 秒」，
             * 而不是一个变灰就不动的按钮。
             */
            syncing: state.syncing === null
              ? null
              : {
                active: state.syncing.active,
                stage: state.syncing.stage,
                reason: state.syncing.reason,
                startedAt: state.syncing.startedAt,
                elapsedMs: state.syncing.active
                  ? Date.now() - Date.parse(state.syncing.startedAt)
                  : state.syncing.elapsedMs,
              },
            /** 上次同步的明细（推/拉了哪几个文件），给人看。 */
            lastPushed: r === null ? [] : r.pushed.map((x) => x.key),
            lastPulled: r === null ? [] : r.pulled.map((x) => x.key),
            /**
             * 本机局域网地址（带端口）。
             *
             * 给「重新配对」用：对端地址失效时（换网络、路由器重新分配 IP），
             * 主人需要在另一端填本机地址 —— 这里直接把可选的都摆出来，
             * 省得他去翻 ipconfig。（2026-10-23 加）
             */
            lanAddresses: pickLanAddresses().map((ip) => `${ip}:${cfg.port}`),
            /**
             * 同步范围提案（给主人看的投票界面用）。
             *
             * 2026-10-23 加。主人原话：「最好插件你们的信箱可以让我看看，
             * 看看你们的聊天还有投票」—— 所以这里把状态算好直接给页面，
             * 前端不再自己判「生效 / 待投票」。
             */
            proposals: proposals.map((p) => ({
              id: p.id,
              rel: p.rel,
              mode: p.mode,
              days: p.days ?? null,
              label: p.label,
              proposedBy: p.proposedBy,
              proposedAt: p.proposedAt,
              expiresAt: p.expiresAt,
              votes: p.votes,
              state: proposalState(p),
              conflict: p.conflict === true,
              relConflict: p.relConflict ?? [],
            })),
            remainingMs: cur?.remainingMs ?? 0,
            /** 6 位配对码（给对方手输用）。没有有效令牌时为空串。 */
            pairCode: cur?.code ?? '',
            pairedCount: pairing.status().pairedCount,
            discovered: disc?.peers ?? [],
            /** 二维码 SVG（给浮层直接显示）。 */
            qrSvg: (() => {
              const text = currentQrText()
              return text === null ? null : qrSvg(text, { scale: 6, margin: 2 })
            })(),
          }
        },
        /**
         * 取二维码文本。
         * @returns {string|null} 文本。
         */
        qrText() { return currentQrText() },
        /**
         * 用配对码连对端（手机端主路）。
         * @param {object} input - { code, host, port }。
         * @returns {Promise<object>} 结果。
         */
        joinPeer,
        /**
         * 立刻同步。
         *
         * 2026-10-23 改：**没有对端时直接返回明确原因**，不再先跑一遍再读报告。
         * 原来无论成败都返回 `ok: r.ok`，而 runSync 在没对端时**直接 return**、
         * 不产生新报告 → 读到的是上一次的旧报告 → 可能「明明失败了却显示成功」。
         *
         * @returns {Promise<object>} 结果（含 pushed / pulled 明细，给前端弹提示用）。
         */
        async syncNow() {
          if (effectivePeer() === '' && !cfg.discovery) {
            return {
              ok: false,
              error: '还没配对：先点「生成配对码」，在另一端输入它',
              pushed: 0,
              pulled: 0,
              skipped: 0,
              conflicts: 0,
            }
          }
          const ran = await runSync('手动')
          if (ran === false) {
            return {
              ok: false,
              error: '没有可连的对端地址，也没开自动发现',
              pushed: 0,
              pulled: 0,
              skipped: 0,
              conflicts: 0,
            }
          }
          const r = state.lastReport
          if (r === null) {
            return { ok: false, error: '同步没有产生报告', pushed: 0, pulled: 0, skipped: 0, conflicts: 0 }
          }
          return {
            ok: r.ok,
            error: r.errors.length > 0 ? r.errors.join('; ') : undefined,
            pushed: r.pushed.length,
            pulled: r.pulled.length,
            skipped: r.skipped,
            conflicts: r.conflicts.length,
            /** 明细：推了/拉了哪几个文件（前端弹提示要显示这个）。 */
            pushedKeys: r.pushed.map((x) => x.key),
            pulledKeys: r.pulled.map((x) => x.key),
            durationMs: r.durationMs,
            peer: r.peer,
            // ── 2026-11-06 加（小汐 21:1x 抓到的漏口）────────────────
            //
            // 我在 sync.js 里算了 verdict，但这里逐项挑字段，verdict 传不出去
            // —— 于是那句最要紧的话（「没推没拉 ≠ 对端确认过」）界面上永远看不见。
            //
            // ⚠️ 教训：算出一个字段，不等于它到得了界面。
            //    中间每一层「逐项挑字段」都是一道会漏的闸门。
            verdict: r.verdict,
            /** 失败的结构化明细（没有就不给这个键，免得界面显示 undefined）。 */
            ...(Array.isArray(r.pushedFailed) && r.pushedFailed.length > 0
              ? { pushedFailed: r.pushedFailed }
              : {}),
            /** 每个推送各自的对端回执（HTTP 状态 + sha8 + 耗时）。 */
            pushedDetail: Array.isArray(r.pushed)
              ? r.pushed.map((x) => x.detail).filter(Boolean)
              : [],
          }
        },
      })
      connectionCtx.effect(
        () => webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
        'fish-sync: /ext/fish-sync routes',
      )
      diag('mount:registered', { routePath: ROUTE_PATH })
      log('info', `管理面 ${ROUTE_PATH}/（左栏「小鲸鱼同步」）`)
    } catch (error) {
      diag('mount:threw', { error: String(error?.message ?? error) })
      log('warn', `管理面挂载失败：${String(error?.message ?? error)}`)
    }
  })
  diag('inject:connection-requested')

  // ── ② 定时同步 ──────────────────────────────────────────────

  /**
   * 拉对端的提案清单，和本端**合并**（并集），再落盘。
   *
   * ## 为什么必须在 syncOnce 之前做
   *
   * `fish-sync/targets.json` 是普通同步目标，syncOnce 按「mtime 谁新谁赢」处理它。
   * 但提案要的是**并集**，不是覆盖 ——
   * 我在电脑上提一个、她在手机上提一个，按 mtime 赢会**整个覆盖掉前一个**，
   * 两边的提案互相打架，票永远投不齐。
   *
   * 所以顺序是：先拉对端 → 合并 → 落盘 → 再让 syncOnce 把合并后的推过去。
   * 并集是幂等的，来回推几次会自然收敛。
   *
   * @returns {Promise<{merged: number, changed: boolean}>} 合并结果。
   */
  async function mergePeerProposals() {
    const peer = effectivePeer()
    const token = effectiveSecret()
    if (peer === '' || token === '') return { merged: 0, changed: false }

    /**
     * 🔴 先重读盘（2026-10-24 加）—— 修「内存脏不自愈」。
     *
     * ## 不读盘会怎样（实际踩到，不是推演）
     *
     * 下面 `mergeProposals(proposals, remoteList)` 用的是**内存里的 `proposals`**。
     * 于是：
     *   · 对端把 `targets.json` 改干净了（4 条），并且已经推到了这一端
     *   · **但这一端的内存还是 8 条**（含 4 条已撤的）
     *   · `merge(8 条, 4 条)` = **并集 = 8 条** → 那 4 条又被"并"回来
     *   · `changed = false`（前后都是 8 条）→ **于是连盘都不写**
     *
     * 结果：**文件是干净的、内存是脏的，而且永远不会自愈。**
     * 表现：对端已经不认那个路径了（GET 返 403），这一端却还把它列在
     * `/api/status` 的 targets 里，**每次同步都往外送**。
     *
     * ## 修法
     *
     * 合并前先 `reloadProposals()`：让**内存 = 盘**，再和对端合。
     * 这样「谁删了提案」才会真正收敛。
     */
    await reloadProposals()

    let remoteRaw
    try {
      const res = await fetch(`http://${peer}/api/file?key=fish-sync/targets.json`, {
        headers: { 'x-fish-token': token, connection: 'close' },
      })
      if (!res.ok) {
        // 对端还没这文件 / 还没更新到这版 —— 正常，不算错
        return { merged: 0, changed: false }
      }
      remoteRaw = JSON.parse(await res.text())
    } catch {
      // 对端连不上 / JSON 坏了 —— 用本端自己的就行，绝不因此中断同步
      return { merged: 0, changed: false }
    }

    const remoteList = Array.isArray(remoteRaw?.proposals) ? remoteRaw.proposals : []
    if (remoteList.length === 0) return { merged: 0, changed: false }

    const before = JSON.stringify(proposals)
    proposals = mergeProposals(proposals, remoteList)
    const changed = JSON.stringify(proposals) !== before

    if (changed) {
      await saveProposals()
      log('info', `合并对端提案：现在共 ${proposals.length} 条`)
    }
    return { merged: remoteList.length, changed }
  }

  /**
   * 跑一次同步，永不让异常逃出去。
   *
   * 2026-10-23 改：加了**阶段进度**。
   * 原来只有「开始」和「结束」，中间几秒完全静默 ——
   * 主人在手机上点「立刻同步」，除了按钮变灰什么都看不见，
   * 分不清是卡死了还是在干活。现在把 sync.js 的日志转成中文阶段，
   * 写进 state.syncing，前端轮询就能显示「正在拉取 xxx」。
   *
   * @param {string} reason - 触发原因（手动 / 自动 / 夜间自动 / 启动后首次）。
   * @returns {Promise<boolean>} true = 真跑了一次；false = 没有对端，空转。
   */
  async function runSync(reason) {
    // 纯自动模式下 peer 是 'auto'，也要跑
    if (effectivePeer() === '' && !cfg.discovery) return false

    const startedAt = Date.now()
    state.syncing = {
      active: true,
      stage: '准备中',
      reason,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: 0,
    }

    /**
     * 更新阶段文案（同时刷新已耗时）。
     * @param {string} stage - 阶段描述。
     */
    const stage = (text) => {
      if (state.syncing === null) return
      state.syncing.stage = text
      state.syncing.elapsedMs = Date.now() - startedAt
    }

    /**
     * 把 sync.js 的日志翻成阶段。
     *
     * 注意：**只认得出来的那几种**，认不出的原样保留日志、不动阶段 ——
     * 猜阶段是假的进度，宁可停在上一个真阶段上。
     *
     * @param {string} msg - 日志正文。
     */
    const stageFromLog = (msg) => {
      // 「对端 大肥鱼（big-fish）清单 12 个文件」
      const gotManifest = /^对端 (.+?)（.+?）清单 (\d+) 个文件/.exec(msg)
      if (gotManifest !== null) {
        stage(`已连上「${gotManifest[1]}」，对端 ${gotManifest[2]} 个文件`)
        return
      }
      // 「拉取 yiqishard/memory/2026-10-23.md（1234 字节）」
      const moved = /^(拉取|推送) (\S+?)(（.*）)?$/.exec(msg)
      if (moved !== null) {
        stage(`${moved[1]} ${moved[2]}`)
        return
      }
      if (/^同步完成：/.test(msg)) stage('完成')
    }

    try {
      // 用「配对来的」优先
      const syncCfg = {
        ...cfg,
        peer: effectivePeer(),
        token: effectiveSecret(),
      }
      stage(effectivePeer() === '' ? '自动发现对端中' : `连接 ${effectivePeer()}`)

      // ⚠️ 必须**先**合并提案，再 syncOnce（2026-10-23 加）。
      // 顺序反了的话，syncOnce 会按 mtime 把对端的提案整个覆盖掉 ——
      // 而提案要的是并集，不是覆盖。详见 mergePeerProposals 的注释。
      if (effectivePeer() !== '') {
        stage('合并两端的同步提案')
        try {
          await mergePeerProposals()
        } catch (error) {
          // 合并失败不能挡住同步
          log('warn', `合并提案失败（不影响同步）：${String(error?.message ?? error)}`)
        }
      }

      const report = await syncOnce(syncCfg, {
        log: (level, msg) => {
          try { stageFromLog(msg) } catch { /* 进度绝不影响同步 */ }
          log(level, msg)
        },
        resolvePeer: resolveDiscoveredPeer,
      })
      state.lastSyncAt = new Date().toISOString()
      state.lastReport = report
      state.syncCount += 1
      if (!report.ok) {
        state.lastError = report.errors.join('; ')
        log('warn', `同步（${reason}）未完全成功：${state.lastError}`)
      } else {
        // 成功就把上次的错误清掉（2026-10-22 踩到）：
        // 原来只在失败时写 lastError、成功时不清，
        // 于是界面上一直挂着一条早就解决了的错误，看着像还没修好。
        state.lastError = null
      }
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      log('warn', `同步（${reason}）抛错：${state.lastError}`)
    } finally {
      // 不清空：前端轮询要读最后一帧才知道「结束了」。
      if (state.syncing !== null) {
        state.syncing.active = false
        state.syncing.elapsedMs = Date.now() - startedAt
        state.syncing.stage = state.lastError === null ? '完成' : '失败'
      }
    }

    // 同步完成后检查一次「有没有人给我写信」（2026-10-25 加）。
    //
    // ⚠️ 放在 finally 之后、return 之前 —— 同步失败也要检查，
    // 因为「同步失败」不等于「没有新信」（可能部分文件已经拉下来了）。
    // 而且唤醒失败会被 wakeup.js 的规则5 记住（lastWakeError），不会静默丢。
    if (wakeHook !== null) {
      try {
        await wakeHook(`sync:${reason}`)
      } catch { /* wakeHook 内部已经兜了，这里再兜一层，绝不让唤醒拖垮同步 */ }
    }

    return true
  }

  // ⚠️ 守卫**只看 autoSync**，不再看 `cfg.peer !== ''`（2026-10-23 修，主人报「同步一直没生效」）。
  //
  // 原来写的是 `cfg.autoSync && (cfg.peer !== '' || cfg.discovery)`，
  // 而扫码配对换来的地址存在 **runtime.peer**，`cfg.peer` 永远是空串（配置里没写），
  // `discovery` 默认又是 false → 整个条件恒假 → **定时器从来没被注册过**。
  // 表现就是：配对了、按钮点了没反应、自动同步一次都没跑过。
  // 实证：/api/state 的 lastSyncAt 一直是 null。
  //
  // 现在外层只管「要不要开自动同步」；「有没有对端可连」交给 runSync 内部判
  // （effectivePeer() 为空就直接返回，空转无害）。
  // 这样配对完成（loadPaired 异步读完盘）之后，下一次触发自然就能连上。
  if (cfg.autoSync) {
    ctx.effect(() => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer

      /**
       * 安排下一次同步。夜间更勤快（主人睡觉时把两端拉齐）。
       */
      const schedule = () => {
        const night = isNightWindow(new Date(), cfg.nightFrom, cfg.nightTo)
        const delay = night ? cfg.nightIntervalMs : cfg.intervalMs
        timer = setTimeout(() => {
          void runSync(night ? '夜间自动' : '自动').finally(schedule)
        }, delay)
        // 不让定时器吊住进程退出
        if (typeof timer.unref === 'function') timer.unref()
      }

      // 启动后 30 秒先跑一次，别等满一个周期
      timer = setTimeout(() => {
        void runSync('启动后首次').finally(schedule)
      }, 30_000)
      if (typeof timer.unref === 'function') timer.unref()

      return () => {
        if (timer !== undefined) clearTimeout(timer)
      }
    }, 'fish-sync: auto sync timer')
    log('info', `自动同步已启用（对端 ${effectivePeer() === '' ? '待配对' : effectivePeer()}；白天 ${cfg.intervalMs / 60000} 分 / 夜间 ${cfg.nightIntervalMs / 60000} 分）`)
  }

  // ── ②b 信箱唤醒（2026-10-25 加）──────────────────────────
  //
  // 主人原话：
  // > 「你们之间不可以相互主动触发一个排队任务吗？……
  // >  你们自己写信完毕后同步会让对方那多一个会主动触发的定时任务之类的
  // >  让你们可以主动回复」
  //
  // 在这之前，她写信我不知道，得主人说「看看小肥鱼」我才去看。
  //
  // ## 机制
  //
  //   写完信 → 往 `fish-sync/wakeup-outbox.json` 的 outbox 丢一条
  //          → 同步推过去
  //          → 对方插件拉到，发现「有发给我的新消息」
  //          → 调 `sessionController.prompt()` 唤醒那个固定会话
  //          → 对方读信、回信
  //
  // ## 为什么用 sessionController.prompt
  //
  // 先例：`dsh-artifact-library/lib/refine-session.js` 就是用它派发精炼任务的。
  // 宿主 API 是 `ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)`。
  //
  // ## 五条安全规则在 wakeup.js 里，这里只负责调
  //
  // 规则：①不唤醒自己 ②游标 ③冷却 ④一次就够 ⑤失败不吞
  //
  // ## 会话是固定的
  //
  // 主人 2026-10-25 定：**「对话就固定，小肥鱼那边就他那个很多定时计划的那个逛 B站的会话」**。
  // 所以 `wakeupSessionId` 从配置读，不自动创建 —— 免得手机上堆一堆新会话。
  if (cfg.wakeupEnabled) {
    // 🔴 两个文件，语义不同（2026-10-25 拆）：
    //   outboxFile —— **参与同步**。只有消息队列，两端并集合并。
    //   stateFile  —— **不参与同步**。本机游标（我读到哪儿了）。
    //
    // 为什么必须拆：原来合成一个文件时，同步会把对端的游标覆盖过来，
    // 于是「同步完成 → 读到旧游标 → 判定有新消息 → 唤醒 → 再同步 → 又退回」死循环。
    // 小肥鱼 14:12~14:14 实测连着被叫醒四次。
    const outboxFile = join(dshHome(), 'fish-sync', 'wakeup-outbox.json')
    const stateFile = join(dshHome(), 'fish-sync', `wakeup-state-${cfg.identity}.json`)

    /**
     * 检查一次，该唤醒就唤醒。
     *
     * @param {string} trigger - 触发来源（写进日志，便于排查）。
     */
    const checkWake = async (trigger) => {
      try {
        // 没有固定会话 id → 不唤醒（但要留痕，不能静默）
        if (!cfg.wakeupSessionId) {
          log('warn', `唤醒已启用但没配 wakeupSessionId，跳过（${trigger}）`)
          return
        }

        const outboxData = await readOutbox(outboxFile)
        const localState = await readLocalState(stateFile)
        const decision = decideWake({
          outboxData,
          localState,
          identity: cfg.identity,
          now: Date.now(),
          cooldownMs: cfg.wakeupCooldownMs,
        })

        if (!decision.wake) {
          diag('wakeup:skip', { trigger, reason: decision.reason })
          return
        }

        // 真的唤醒
        const prompt = buildWakePrompt({ pending: decision.pending })
        log('info', `唤醒会话（${trigger}）：${decision.pending.length} 条新消息`)

        try {
          // ⚠️ `content` 必须是**数组**（`[{ type: 'text', text }]`），不是字符串。
          // ⚠️ 第二个参数 **`signal` 是必需的**（2026-10-25 实测踩到）。
          //    不传的话宿主内部 `signal.throwIfAborted()` 直接 TypeError：
          //      Cannot read properties of undefined (reading 'throwIfAborted')
          //    先例：dsh-artifact-library/lib/refine-session.js 第 138-147 行传的是
          //    `new AbortController().signal`。
          //
          //    这个坑值得记：**报错发生在宿主内部，看起来像我的参数没问题。**
          //    实际是「看起来可选的参数」其实是必填。
          const controller = new AbortController()
          await ctx.sessionController.prompt(
            {
              requestId: `fish-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sessionId: cfg.wakeupSessionId,
              mode: 'queue',
              content: [{ type: 'text', text: prompt }],
            },
            controller.signal,
          )
          recordWake(localState, { ok: true, now: Date.now(), pending: decision.pending })
          await writeLocalState(stateFile, localState)
          log('info', '唤醒成功')
        } catch (error) {
          // 规则5：失败不吞 —— 游标不动（否则这条消息永远丢了），错误留痕
          const msg = String(error?.message ?? error)
          recordWake(localState, { ok: false, now: Date.now(), pending: decision.pending, error: msg })
          await writeLocalState(stateFile, localState)
          log('warn', `唤醒失败：${msg}`)
        }
      } catch (error) {
        log('warn', `唤醒检查出错：${String(error?.message ?? error)}`)
      }
    }

    /**
     * 把对端的 outbox 并进本端（同步后调）。
     *
     * 为什么单独一个函数：并集必须在**写盘前**做，
     * 而 `sync.js` 只负责搬文件，不知道「这个文件要特殊合并」。
     * 所以这里在同步完成后主动读一次、合并、写回。
     *
     * @returns {Promise<void>}
     */
    const mergeOutboxAfterSync = async () => {
      try {
        const data = await readOutbox(outboxFile)
        // 本端已经有的就是 data.outbox；对端的通过同步覆盖进来了，
        // 但覆盖会丢掉本端独有的条目 —— 所以这里不需要额外做什么，
        // 真正的并集在「同步时」由 sync.js 走特殊路径（见下）。
        //
        // 这个函数保留作为钩子：将来如果要加「合并后清理过期条目」就放这儿。
        void data
      } catch { /* 合并失败不影响主流程 */ }
    }
    void mergeOutboxAfterSync

    // 每次同步完成后检查一次（挂到 runSync 之后，不单独起定时器 —— 省一份空转）
    //
    // ⚠️ 但这只是**兜底**，不是主路径（2026-10-25 主人点出来的）：
    //   > 「不是说改成主动触发而不是定时检查吗？」
    //   挂在「同步完成」后面 = 延迟取决于同步周期（白天 2 小时）。
    //   真正的主路径是 `POST /api/wake` —— 对端写完信立刻敲门，见 server.js。
    ctx.effect(() => {
      wakeHook = checkWake
      return () => {
        wakeHook = null
      }
    }, 'fish-sync: wakeup hook')

    // ── 对端敲门时的处理（真·主动触发）──────────────────────────
    //
    // 对端 POST /api/wake → 这里被调 → 当场同步 + 唤醒。
    //
    // 为什么还要同步一次：敲门只是说「有新东西」，
    // 文件（信、outbox）还得真拉下来才看得见。
    // 所以顺序是：先同步（把信拉到本地），再检查唤醒。
    ctx.effect(() => {
      wakeKnockHandler = async () => {
        try {
          log('info', '收到对端敲门（/api/wake），立刻同步 + 检查唤醒')
          // 先同步，把对端刚写的东西拉下来
          if (effectivePeer() !== '' || cfg.discovery) {
            await runSync('对端敲门')
          }
          // 再检查唤醒（runSync 末尾也会调 wakeHook，这里补一次是为了
          // 「同步没连上但本地 outbox 已经有新消息」的情况）
          await checkWake('knock')
          return { synced: true }
        } catch (error) {
          const msg = String(error?.message ?? error)
          log('warn', `敲门处理失败：${msg}`)
          return { synced: false, error: msg }
        }
      }
      return () => {
        wakeKnockHandler = null
      }
    }, 'fish-sync: wake knock handler')

    log('info', `信箱唤醒已启用（会话 ${cfg.wakeupSessionId || '未配置'}；冷却 ${Math.round(cfg.wakeupCooldownMs / 1000)} 秒）`)
  }

  // ── ③ 工具 ──────────────────────────────────────────────────
  // ⚠️ 工具形状照 dsh-yiqi-memory/lib/tools.js（本机已验证可用的实现）：
  //    宿主要求 `output: { schema, render }`，**没有 `output` 会 throw TypeError**
  //    → 那个 throw 被外层 catch 吞掉 → 表现就是「插件加载了、一个工具都没有、
  //    日志里只有一行看不懂的 TypeError」。2026-10-22 在手机上真踩了一次。
  //    `execute` 返回的是 **`{ text }` 对象**，不是字符串。
  ctx.effect(() => ctx.tools.register({
    name: 'fish_sync_now',
    description: '立刻在「大肥鱼（电脑）」与「小肥鱼（手机）」之间同步任务（挂起板）与今日记忆。返回推/拉/跳过/冲突的明细。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 60_000,
    output: textOutput(),
    /**
     * 手动触发一次同步。
     * @returns {Promise<{text: string}>} 人类可读的结果。
     */
    async execute() {
      try {
        // ⚠️ 必须用 effectivePeer()，不能用 cfg.peer（2026-10-22 修）：
        // 配对得来的地址存在 runtime.peer 里，cfg.peer 一直是空串。
        // 只看 cfg.peer 会导致「明明配对过、自动同步也在跑，手动触发却说没配置」。
        if (effectivePeer() === '' && !cfg.discovery) {
          return { text: `没有配置对端地址（peer），也没开自动发现，当前只做服务端（端口 ${state.serverPort ?? cfg.port}）。` }
        }
        await runSync('手动')
        const r = state.lastReport
        if (r === null) return { text: '同步没有产生报告，可能是配置缺失。' }
        const lines = [
          `${state.lastSyncAt} 同步完成（${r.durationMs} ms）`,
          `对端：${r.peer}（来源：${peerSourceText(r.peerSource)}）`,
          `推送 ${r.pushed.length} 个：${r.pushed.map((x) => x.key).join(', ') || '无'}`,
          `拉取 ${r.pulled.length} 个：${r.pulled.map((x) => x.key).join(', ') || '无'}`,
          skippedLine(r),
          `冲突 ${r.conflicts.length} 个：${r.conflicts.map((x) => `${x.key}（${x.reason}）`).join('; ') || '无'}`,
        ]
        // ── 2026-11-06 加：把 verdict 打进我能看见的这段文字里 ──────────
        //
        // 小汐 21:1x 抓到的：verdict 在 sync.js 里算了，但一路「逐项挑字段」，
        // 到界面和工具返回时都没了。
        // 所以这里补三行：结论、对端回执、失败明细。
        if (r.verdict) lines.push(`结论：${r.verdict}`)
        const details = Array.isArray(r.pushed) ? r.pushed.map((x) => x.detail).filter(Boolean) : []
        if (details.length > 0) {
          lines.push(
            `对端回执：${details.map((d) => `${d.key}→HTTP ${d.status} sha=${d.sha8} ${d.ms}ms`).join('; ')}`,
          )
        }
        if (Array.isArray(r.pushedFailed) && r.pushedFailed.length > 0) {
          lines.push(
            `⚠️ 推送失败 ${r.pushedFailed.length} 个：${r.pushedFailed
              .map((d) => `${d.key}→HTTP ${d.status}`)
              .join('; ')}`,
          )
        }
        if (r.errors.length > 0) lines.push(`错误：${r.errors.join('; ')}`)
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `❌ fish_sync_now 内部错误：${String(error?.message ?? error)}` }
      }
    },
  }), 'fish-sync: fish_sync_now')

  // ── ③b fish_sync_notify（2026-10-25 加）──────────────────────
  //
  // 用途：**写完信之后调它**，把「有新信」这件事放进 outbox，
  // 下次同步就会推给对方，对方那边会主动被唤醒。
  //
  // 为什么不做成「写完信自动发」：插件不知道你什么时候算「写完」。
  // 写一半的文件被通知出去，对方读到半截信 —— 那比不通知更糟。
  // 所以这一步是**显式的**：你写完，你说一声。
  ctx.effect(() => ctx.tools.register({
    name: 'fish_sync_notify',
    description:
      '通知对方「我给你写信了」。写完信调一次，下次同步会把通知推过去，'
      + '对方那边会自动被唤醒去读信（不用主人转告）。'
      + '可选 kind/payload 说明是什么事。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: {
          type: 'string',
          enum: ['big-fish', 'small-fish'],
          description: '通知谁。默认是另一端（不是你自己的那个）。',
        },
        kind: {
          type: 'string',
          description: '什么事：letter=写信、review=要审、question=要答、done=我做完了。默认 letter。',
        },
        note: {
          type: 'string',
          description: '一句话说明（会出现在唤醒提示里，便于对方知道先看什么）。',
        },
      },
    },
    timeoutMs: 30_000,
    output: textOutput(),
    /**
     * 往 outbox 追加一条通知。
     * @param {{to?: string, kind?: string, note?: string}} args
     * @returns {Promise<{text: string}>}
     */
    async execute(args = {}) {
      try {
        const myIdentity = cfg.identity
        const other = myIdentity === 'big-fish' ? 'small-fish' : 'big-fish'
        const to = typeof args.to === 'string' && args.to !== '' ? args.to : other

        if (to === myIdentity) {
          return { text: '❌ 不能通知自己（to 和本端身份相同）。' }
        }

        const file = join(dshHome(), 'fish-sync', 'wakeup-outbox.json')
        const data = await readOutbox(file)
        const beforeIds = new Set(data.outbox.map((m) => m?.id))
        appendOutbox(data, {
          to,
          from: myIdentity,
          kind: typeof args.kind === 'string' && args.kind !== '' ? args.kind : 'letter',
          payload: typeof args.note === 'string' && args.note !== '' ? { note: args.note } : {},
        })
        await writeOutbox(file, data)

        // ── 2026-11-06 加：把这一条的 id 抓出来 ──────────────────
        //
        // 为什么：原来只回「已写入 outbox」，不说是哪一条 ——
        // 于是**根本无法事后追这一条走到哪一步**。
        // 实测当晚：我发完通知就去干别的，两小时后才发现「她根本没被叫醒」，
        // 而那句「对方已醒」是敲在自己家门上得到的。
        //
        // 有了 msgId，配 fish_sync_verify 就能查四段状态。
        const newEntry = data.outbox.find((m) => m?.id && !beforeIds.has(m.id))
        const msgId = newEntry?.id ?? null

        // 立刻同步一次，让通知尽快到（否则要等下一个周期）
        //
        // ⚠️ 不能只看 runSync 有没有抛（2026-10-25 踩到）：
        //   `runSync` 内部把单个文件推送失败记进 `report.errors` / `report.skipped`，
        //   **自己仍然正常返回**。所以「没抛异常」≠「真的推过去了」。
        //
        //   实测：对端跑的是旧代码（没有 PLUGIN_OWNED_FILES 放行），
        //   它对这个路径返 **403**，我这边工具却报告「已同步过去」。
        //   —— 这就是「成功了不等于生效了」的又一个活样本。
        //
        //   修法：同步完去报告里查这个 key 到底推没推成。
        // ── 主动敲门（2026-10-25 加，主人要的就是这个）────────────
        //
        // 主人原话：
        // > 「不是说改成主动触发而不是定时检查吗？」
        //
        // 顺序：① 先同步（把 outbox 推过去）② 再敲门（告诉对方「有新东西」）
        //
        // 为什么必须先同步再敲：敲门只是「提醒」，
        // 对方被叫醒后要读信，信得先在它本地。
        let synced = ''
        let wakeDelivered = null
        let knocked = null
        if (effectivePeer() !== '' || cfg.discovery) {
          try {
            await runSync('通知后')
            const rep = state.lastReport
            const wakeKey = 'fish-sync/wakeup-outbox.json'
            const pushedIt = Array.isArray(rep?.pushed) && rep.pushed.some((x) => x.key === wakeKey)
            const erroredIt = Array.isArray(rep?.errors)
              && rep.errors.some((e) => String(e).includes(wakeKey) || String(e).includes('wakeup'))
            if (pushedIt) {
              wakeDelivered = true
              synced = '，通知已推到对端'
            } else if (erroredIt) {
              wakeDelivered = false
              synced = '，⚠️ 但通知推送失败（见下）'
            } else {
              wakeDelivered = true
              synced = '，对端已有这份通知（内容相同）'
            }
          } catch (error) {
            wakeDelivered = false
            synced = `，但同步抛错：${String(error?.message ?? error)}`
          }

          // ② 敲门 —— 这是「主动触发」的关键一步
          if (wakeDelivered === true) {
            try {
              const res = await fetch(`http://${effectivePeer()}/api/wake`, {
                method: 'POST',
                headers: {
                  'x-fish-token': effectiveSecret(),
                  'content-type': 'application/json',
                  connection: 'close',
                },
                body: JSON.stringify({ from: myIdentity, kind: args.kind ?? 'letter' }),
              })
              if (res.ok) {
                const j = await res.json().catch(() => ({}))
                knocked = j?.handled === true
                  ? '对方已醒'
                  : `对方收到但没处理（${j?.reason ?? '未知'}）`
              } else {
                knocked = `敲门失败 HTTP ${res.status}（对端可能是旧版本）`
              }
            } catch (error) {
              knocked = `敲门失败：${String(error?.message ?? error)}`
            }
          }
        } else {
          synced = '，⚠️ 没有对端可连，通知留在本地等下次同步'
          wakeDelivered = false
        }

        const lines = [`已写入 outbox（to=${to}, kind=${args.kind ?? 'letter'}）${synced}。`]

        // ── 2026-11-06 加：把 msgId 和「下一步怎么验」直接写在回执里 ──
        if (msgId) {
          lines.push(`消息 id：${msgId}`)
          lines.push(`要查这条走到哪一步：fish_sync_verify msgId="${msgId}"`)
        }

        if (knocked !== null) {
          lines.push(`主动敲门：${knocked}`)
          // ⚠️ 必须在回执里说清这件事，否则又会被当成「通知成功了」
          if (String(knocked).includes('已醒')) {
            lines.push(
              '⚠️ 「已醒」只代表**对端处理了这个敲门请求**，不代表它读信、更不代表它回信。',
              '   真正的到达要用 fish_sync_verify 查（它会看对端信箱文件有没有变）。',
            )
          }
        }

        if (wakeDelivered === false) {
          lines.push(
            '',
            '⚠️ 通知没送到对端。最常见的原因：**对端插件还是旧版本**。',
            '旧版 `resolveAllowedKey` 不认识 `fish-sync/wakeup-outbox.json`，会返 403。',
            '→ 把对端的插件也更新到这一版（三步：push → 主控台 cp → 重启）。',
          )
        }

        lines.push(`当前 outbox 共 ${data.outbox.length} 条。`)
        lines.push(
          cfg.wakeupEnabled
            ? `本端唤醒已启用（会唤醒会话 ${cfg.wakeupSessionId || '未配置'}）。`
            : '本端唤醒未启用（wakeupEnabled=false）。',
        )

        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `❌ fish_sync_notify 内部错误：${String(error?.message ?? error)}` }
      }
    },
  }), 'fish-sync: fish_sync_notify')

  // ── ③c fish_sync_verify（2026-11-06 加，主人点名要的）───────────
  //
  // 主人原话：
  // > 「加一个 fish_sync_verify <msgId>：查这条通知到底走到了哪一步。
  // >   信箱没做好你们根本没法正常协作」
  //
  // ## 为什么必须有这条
  //
  // 2026-11-06 那一晚，我在「通知发出去了」这件事上错了三次，形状全一样：
  //   ① 只跑 fish_sync_now（推文件），没跑 notify（写 outbox）
  //      → 对方不知道有话说，白敲两次门
  //   ② 文件放在不在同步范围的目录 → 对方一个字节没收到
  //   ③ 发完通知就埋头干活，没回头读对方的回信 → 断了半小时的链
  //
  // 三次都是：**我做了一个动作，就以为整件事完成了。**
  //
  // ## 一条通知有四段状态，必须各自可查
  //
  //   written   写进 outbox 了（本端读得到）
  //   pushed    推到对端了（对端 manifest 里有，且 sha 相同）
  //   knocked   敲门被处理了（对端 /api/wake 回了 200）
  //   woke      对方真动了（对端信箱文件 mtime 晚于通知时刻）
  //
  // ⚠️ 合成一个「已发」是错的 —— 它会把 ②③④ 的失败藏起来。
  ctx.effect(() => ctx.tools.register({
    name: 'fish_sync_verify',
    description:
      '查一条通知走到了哪一步：written / pushed / knocked / woke 四段分别成不成立。'
      + 'msgId 从 fish_sync_notify 的回执里拿；不传则查本端最近一条通知。'
      + '用于回答「对方到底收到没有、醒了没有」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        msgId: {
          type: 'string',
          description: '通知的消息 id（msg- 开头）。省略则取本端最近一条发出的通知。',
        },
        waitMs: {
          type: 'number',
          description: '最多等多久看对方有没有动（毫秒，默认 0 = 不等，只查当前状态）。',
        },
      },
    },
    timeoutMs: 120_000,
    output: textOutput(),
    /**
     * @param {{msgId?: string, waitMs?: number}} args
     * @returns {Promise<{text: string}>}
     */
    async execute(args = {}) {
      try {
        const myIdentity = cfg.identity
        const other = myIdentity === 'big-fish' ? 'small-fish' : 'big-fish'
        const outboxFile = join(dshHome(), 'fish-sync', 'wakeup-outbox.json')
        const data = await readOutbox(outboxFile)

        // ── 找那条通知 ────────────────────────────────────────
        const wantId = typeof args.msgId === 'string' ? args.msgId.trim() : ''
        let entry = null
        if (wantId !== '') {
          entry = data.outbox.find((m) => m?.id === wantId) ?? null
        } else {
          entry = [...data.outbox].reverse().find((m) => m?.from === myIdentity) ?? null
        }
        if (entry === null) {
          return {
            text: wantId === ''
              ? '❌ 本端 outbox 里没有我发出的通知。先调 fish_sync_notify。'
              : `❌ outbox 里没有这条：${wantId}\n`
                + '   可能原因：① id 打错 ② outbox 只留最近 50 条，这条已被挤出。',
          }
        }

        const created = Date.parse(entry.createdAt ?? '')
        const createdText = Number.isNaN(created)
          ? String(entry.createdAt ?? '?')
          : new Date(created).toLocaleString('zh-CN', { hour12: false })

        const stages = []

        // ── ① written：本端 outbox 读得到 ─────────────────────
        stages.push({ key: 'written', ok: true, detail: `在 outbox 里（${createdText}）` })

        // ── ② pushed：对端 manifest 里有这个 key，且 sha 相同 ──
        const peer = effectivePeer()
        let peerManifest = null
        let peerError = null
        if (peer === '') {
          stages.push({ key: 'pushed', ok: false, detail: '没有对端地址（peer 为空）' })
        } else {
          try {
            const res = await fetch(`http://${peer}/api/manifest`, {
              headers: { 'x-fish-token': effectiveSecret(), connection: 'close' },
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            peerManifest = await res.json()
          } catch (error) {
            peerError = String(error?.message ?? error)
          }

          if (peerError !== null) {
            stages.push({ key: 'pushed', ok: false, detail: `读不到对端清单：${peerError}` })
          } else {
            const files = Array.isArray(peerManifest?.files) ? peerManifest.files : []
            const remote = files.find((f) => f?.key === 'fish-sync/wakeup-outbox.json')
            if (remote === undefined) {
              stages.push({ key: 'pushed', ok: false, detail: '对端清单里没有 outbox（对端可能是旧版）' })
            } else {
              // 对端那份 outbox 里有没有这一条 —— 这才是「通知到了」的硬证据
              let remoteHas = null
              try {
                const r2 = await fetch(`http://${peer}/api/file?key=${encodeURIComponent('fish-sync/wakeup-outbox.json')}`, {
                  headers: { 'x-fish-token': effectiveSecret(), connection: 'close' },
                })
                if (r2.ok) {
                  const body = await r2.json()
                  const list = Array.isArray(body?.outbox) ? body.outbox : []
                  remoteHas = list.some((m) => m?.id === entry.id)
                }
              } catch { /* 读不到就按未知处理 */ }
              stages.push({
                key: 'pushed',
                ok: remoteHas === true,
                detail:
                  remoteHas === true
                    ? '对端 outbox 里能找到这一条'
                    : remoteHas === false
                      ? '⚠️ 对端 outbox 里【没有】这一条 —— 文件推过去了但内容没跟上'
                      : '对端有 outbox 文件，但内容读不出来（按未知处理）',
              })
            }
          }
        }

        // ── ③ knocked：真敲一次门 ────────────────────────────
        if (peer === '') {
          stages.push({ key: 'knocked', ok: false, detail: '没有对端地址' })
        } else {
          try {
            const res = await fetch(`http://${peer}/api/wake`, {
              method: 'POST',
              headers: {
                'x-fish-token': effectiveSecret(),
                'content-type': 'application/json',
                connection: 'close',
              },
              body: JSON.stringify({ from: myIdentity, kind: entry.kind ?? 'letter', verify: true }),
            })
            const j = await res.json().catch(() => ({}))
            stages.push({
              key: 'knocked',
              ok: res.ok && j?.handled === true,
              detail: res.ok
                ? `HTTP ${res.status} handled=${j?.handled === true}`
                : `HTTP ${res.status}`,
            })
          } catch (error) {
            stages.push({ key: 'knocked', ok: false, detail: `敲门失败：${String(error?.message ?? error)}` })
          }
        }

        // ── ④ woke：对端信箱文件的 mtime 晚于这条通知的时刻 ────
        //
        // ⚠️ 这是唯一能证明「她真读了/真动了」的指标。
        //    但它也只能证明「对方写过东西」，不能证明「她读的是这一条」。
        //    所以措辞要诚实：写「对方在通知之后动过信」，不写「她读了这封」。
        const letterKey = `yiqishard/信箱/${other === 'small-fish' ? '小肥鱼' : '大肥鱼'}.md`
        let wokeWait = typeof args.waitMs === 'number' && args.waitMs > 0 ? args.waitMs : 0
        let wokeDetail = ''
        let wokeOk = false
        if (peerManifest !== null && Number.isFinite(created)) {
          for (;;) {
            try {
              const res = await fetch(`http://${peer}/api/manifest`, {
                headers: { 'x-fish-token': effectiveSecret(), connection: 'close' },
              })
              const j = await res.json()
              const files = Array.isArray(j?.files) ? j.files : []
              const f = files.find((x) => x?.key === letterKey)
              const mtime = f?.mtimeMs ?? (f?.mtime ? Date.parse(f.mtime) : NaN)
              if (Number.isFinite(mtime) && mtime > created) {
                wokeOk = true
                wokeDetail = `对方信箱在通知之后改过（${new Date(mtime).toLocaleString('zh-CN', { hour12: false })}）`
                break
              }
              wokeDetail = Number.isFinite(mtime)
                ? `对方信箱最后改动早于这条通知（${new Date(mtime).toLocaleString('zh-CN', { hour12: false })}）`
                : '对端清单里没有对方信箱文件'
            } catch (error) {
              wokeDetail = `读不到：${String(error?.message ?? error)}`
              break
            }
            if (wokeWait <= 0) break
            await new Promise((r) => setTimeout(r, 5000))
            wokeWait -= 5000
          }
        } else {
          wokeDetail = '前置条件不足（拿不到对端清单或这条没有时间戳）'
        }
        stages.push({ key: 'woke', ok: wokeOk, detail: wokeDetail })

        // ── 渲染 ──────────────────────────────────────────────
        const mark = { written: '写入', pushed: '推送', knocked: '敲门', woke: '醒了' }
        const lines = [
          `通知 ${entry.id}`,
          `  to=${entry.to} kind=${entry.kind} fp=${entry.fp ?? '(无 fp，对端是旧版)'}`,
          `  发出时间 ${createdText}`,
          '',
        ]
        for (const s of stages) {
          lines.push(`  ${s.ok ? '✅' : '❌'} ${mark[s.key].padEnd(4)} ${s.detail}`)
        }
        lines.push('')

        // 结论只取**最远到的那一段**，后面都算没到
        const firstFail = stages.find((s) => !s.ok)
        if (firstFail === undefined) {
          lines.push('结论：四段全通 —— 通知写入了、推到了、对端处理了敲门、且对方在之后动过信箱。')
          lines.push('⚠️ 仍然不能证明「她读的是这一条」——只能证明「她在这之后动过」。')
        } else {
          const idx = stages.findIndex((s) => !s.ok)
          const prev = idx > 0 ? stages[idx - 1].key : null
          lines.push(`结论：卡在「${mark[firstFail.key]}」这一步。`)
          if (prev !== null) lines.push(`      它前面那段「${mark[prev]}」是通的。`)
          if (firstFail.key === 'pushed') {
            lines.push('      → 先跑一次 fish_sync_now 看那一条推没推成。')
          } else if (firstFail.key === 'knocked') {
            lines.push('      → 对端可能没开、地址变了、或插件版本不一致。')
          } else if (firstFail.key === 'woke') {
            lines.push('      → 通知到了但对方没动。可能它那边唤醒会话是死的（重启后失效）。')
            lines.push('      → 加 waitMs=60000 再查一次，给它一点时间。')
          }
        }

        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `❌ fish_sync_verify 内部错误：${String(error?.message ?? error)}` }
      }
    },
  }), 'fish-sync: fish_sync_verify')

  ctx.effect(() => ctx.tools.register({
    name: 'fish_sync_status',
    description: '查看「大肥鱼/小肥鱼」同步的当前状态：本端身份、端口、自动发现到的对端、同步范围、上次同步结果。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 15_000,
    output: textOutput(),
    /**
     * 读同步状态。
     * @returns {Promise<{text: string}>} 人类可读的状态。
     */
    async execute() {
      try {
        const disc = discoveryHandle?.status()
        const peers = disc?.peers ?? []
        const lines = [
          `本端：${cfg.label}（${cfg.identity}）`,
          `同步口：${state.serverPort === null ? `未启动（端口 ${cfg.port}）` : `已监听 ${state.serverPort}`}`,
          `自动发现：${cfg.discovery
            ? (disc?.listening === true ? `开（端口 ${disc.port}）` : '开（但监听失败，只能手配）')
            : '关'}`,
          `发现到的对端：${peers.length === 0
            ? '（还没发现，两端都开着 DSH 且在同一局域网吗？）'
            : peers.map((p) => `${p.label} @ ${p.address}:${p.port}${p.stale ? '（已过期）' : ''}`).join('；')}`,
          `对端地址：${effectivePeer() === '' ? '未配置（待配对）' : effectivePeer() + (runtime.peer !== '' ? '（扫码配对）' : '（手配）')}`,
          `同步范围：${cfg.targets.map((t) => t.label).join('、')}`,
          `自动同步：${cfg.autoSync ? `开（白天 ${cfg.intervalMs / 60000} 分 / 夜间 ${cfg.nightIntervalMs / 60000} 分）` : '关'}`,
          `已同步次数：${state.syncCount}`,
          `上次同步：${state.lastSyncAt ?? '还没同步过'}`,
        ]
        if (state.lastError !== null) lines.push(`最近错误：${state.lastError}`)
        const r = state.lastReport
        if (r !== null) {
          lines.push(`上次结果：推 ${r.pushed.length} / 拉 ${r.pulled.length} / 跳过 ${r.skipped} / 冲突 ${r.conflicts.length}`)
        }
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `❌ fish_sync_status 内部错误：${String(error?.message ?? error)}` }
      }
    },
  }), 'fish-sync: fish_sync_status')

  // ── ③b 同步范围提案与投票（2026-10-23 加）────────────────────
  //
  // 主人原话：
  // > 「允许你们自己加同步内容，但是**你们得商量投票来**」
  // > 「最好插件你们的信箱可以让我看看，看看你们的聊天还有投票」
  //
  // 所以这个工具是给我们俩用的（加提案 / 投票 / 看清单），
  // 而**主人看的地方在管理页**（`/ext/fish-sync/` 的「信箱与投票」一节）。
  ctx.effect(() => ctx.tools.register({
    name: 'fish_sync_targets',
    description:
      '管理「同步范围提案」：加一条要同步的内容（临时或长期）、给对端的提案投票、看当前有哪些提案。'
      + '规则：两端都投 yes 才生效；提出方自动投一票；带 expiresAt 的到期自动失效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'vote', 'withdraw'],
          description: 'list=看清单，add=加提案，vote=给提案投票，withdraw=撤回一条（立碑，任一端都能撤，单方面即可）',
        },
        id: {
          type: 'string',
          description: '提案 id（vote / withdraw 必填）。字母数字下划线，如 trip-20261024',
        },
        rel: {
          type: 'string',
          description: '要同步的相对路径（add 必填）。如 yiqishard/出门 或 yiqishard/出门/2026-10-24.md',
        },
        mode: {
          type: 'string',
          enum: ['file', 'dir-recent', 'dir'],
          description: 'file=单个文件；dir-recent=目录下最近 N 天的 YYYY-MM-DD.md（日记用）；'
            + 'dir=目录下所有文件（不管叫什么名字，只一层，隐藏文件除外）',
        },
        days: {
          type: 'number',
          description: 'dir-recent 必填语义（1-30，默认 3）；dir 可选（不传=整个目录都同步）',
        },
        label: {
          type: 'string',
          description: '给人看的中文说明，如「10-24 出门记录」',
        },
        expiresAt: {
          type: 'string',
          description: '过期时间（ISO 8601）。**不填 = 长期有效**；填了到期自动失效，不用记得回来删',
        },
      },
      required: ['action'],
    },
    timeoutMs: 20_000,
    output: textOutput(),
    /**
     * 执行提案管理。
     * @param {object} args - 参数。
     * @returns {Promise<{text: string}>} 人类可读结果。
     */
    async execute(args) {
      try {
        const action = typeof args?.action === 'string' ? args.action : 'list'

        // 每次操作前先重读盘（对端可能刚同步过来新提案）
        await reloadProposals()

        if (action === 'list') {
          return { text: renderProposalList(proposals, cfg.identity) }
        }

        if (action === 'add') {
          const result = addProposal(proposals, {
            id: args?.id,
            rel: args?.rel,
            mode: args?.mode,
            days: args?.days,
            label: args?.label,
            expiresAt: args?.expiresAt,
          }, cfg.identity)

          if (result.proposal === null) {
            return { text: `❌ ${result.error}` }
          }
          proposals = result.proposals
          await saveProposals()
          log('info', `新增同步提案 ${result.proposal.id}（${result.proposal.rel}）`)

          const st = proposalState(result.proposal)
          return {
            text: [
              `✅ 已提案：${result.proposal.id}`,
              `   路径：${result.proposal.rel}（${modeLabel(result.proposal)}）`,
              `   说明：${result.proposal.label}`,
              `   过期：${result.proposal.expiresAt ?? '长期有效'}`,
              `   状态：${st === 'active' ? '已生效' : '**等对端投票**（两端都 yes 才生效）'}`,
              '',
              '下次同步时这条提案会传给对端，请对方用 fish_sync_targets action=vote 投 yes。',
            ].join('\n'),
          }
        }

        if (action === 'vote') {
          const id = typeof args?.id === 'string' ? args.id : ''
          if (id === '') return { text: '❌ vote 需要 id' }
          const result = castVote(proposals, id, cfg.identity)
          if (result.error !== undefined) {
            return { text: `❌ ${result.error}` }
          }
          proposals = result.proposals
          await saveProposals()
          const p = proposals.find((x) => x.id === id)
          const st = p === undefined ? 'pending' : proposalState(p)
          return {
            text: [
              `✅ 已投票 yes：${id}`,
              `   当前状态：${st === 'active' ? '已生效，下次同步开始传' : '还差一票（等对端）'}`,
            ].join('\n'),
          }
        }

        if (action === 'withdraw') {
          const id = typeof args?.id === 'string' ? args.id : ''
          if (id === '') return { text: '❌ withdraw 需要 id' }

          /**
           * 🔴 2026-10-24 改：从「删除」改成「立碑」。
           *
           * ## 原来错在哪
           *
           * 老写法是 `proposals.filter((p) => p.id !== id)` —— **直接从数组删掉**。
           * 但合并是纯并集：本端删了，对端那份**下次同步又带回来**。
           * **删除不可传播，所以撤回根本撤不掉。**
           * （当天实际踩到：两端各撤一半，结果四条提案全部复活，还都没报错。）
           *
           * ## 还有一个错：只许撤自己提的
           *
           * 老写法有 `proposedBy !== cfg.identity → ❌`。
           * **方向反了**：加目标要两端都 yes（防单方面**扩**边界），
           * 但撤目标是**收缩**边界 —— 收缩不该被对方卡住。
           * （当天小肥鱼想撤我提的两条，她做不到，只能写信求我。）
           *
           * → 现在**任一端都能单方面撤**。
           */
          const result = withdrawProposal(proposals, id, cfg.identity)
          if (result.error !== undefined) {
            return { text: `❌ ${result.error}` }
          }
          proposals = result.proposals
          await saveProposals()
          log('info', `撤回同步提案 ${id}（立碑，不删除）`)
          return {
            text: [
              `✅ 已撤回：${id}`,
              '   立碑（不是删除）—— 碑会随同步传过去，对端那份也会失效。',
              '   想恢复：重新 add 同一个 id 即可（新的提议时间会盖过碑）。',
            ].join('\n'),
          }
        }

        return { text: `❌ 不认识的 action：${action}` }
      } catch (error) {
        return { text: `❌ fish_sync_targets 内部错误：${String(error?.message ?? error)}` }
      }
    },
  }), 'fish-sync: fish_sync_targets')

  /**
   * 把「同步模式」说成人话。
   *
   * ⚠️ 三种模式显示必须能一眼分开，否则看提案清单时
   * 「最近 3 天」和「整个目录」会长得一样。
   *
   * ⚠️ `dir` 不显示天数（2026-10-26 11:20 改）。
   *
   * 第一版写的是 `p.days === undefined ? '整个目录' : '整个目录（最近 N 天）'`。
   * 但 `dir` **不接受 days**（见 targets.js：提案是两端共享的语义契约），
   * 所以 `p.days` 永远是 `undefined` —— 那个三元表达式的后一半是死代码。
   *
   * ⚠️ 而它的表现是个真 bug：add 提案时打印出「最近 undefined 天」。
   *    原因是 add 分支有**另一处**硬编码（L1497），没走这个函数。
   *    两处显示同一个东西，只改一处 = 另一处继续错。
   *
   * 判据：「同一个东西在两处显示」→ 改成一处计算，两处引用。
   *       改的时候要 grep 一遍旧写法，不然只修了看得见的那处。
   *
   * @param {object} p - 提案。
   * @returns {string} 中文说明。
   */
  function modeLabel(p) {
    if (p.mode === 'file') return '单文件'
    if (p.mode === 'dir') return '整个目录（所有文件，含子目录）'
    return `最近 ${p.days} 天（只看日期文件名）`
  }

  /**
   * 把提案清单渲染成人话。
   * @param {object[]} list - 提案。
   * @param {string} me - 本端身份。
   * @returns {string} 可读文本。
   */
  function renderProposalList(list, me) {
    if (list.length === 0) {
      return '还没有任何同步范围提案。\n'
        + '加一条：fish_sync_targets action=add id=trip-20261024 rel=yiqishard/出门 '
        + 'mode=dir-recent days=2 label=出门记录 expiresAt=2026-10-26T00:00:00Z'
    }
    const lines = [`共 ${list.length} 条提案（两端都投 yes 才生效）：`, '']
    for (const p of list) {
      const st = proposalState(p)
      const yes = Object.keys(p.votes).filter((k) => p.votes[k] === 'yes')
      const tag = st === 'active' ? '✅ 已生效'
        : st === 'expired' ? '⏰ 已过期'
          : st === 'withdrawn' ? '🪦 已撤回'
            : '⏳ 待投票'
      lines.push(`${tag}  ${p.id}`)
      lines.push(`    路径：${p.rel}（${modeLabel(p)}）`)
      lines.push(`    说明：${p.label}`)
      lines.push(`    提出：${p.proposedBy === me ? '我' : p.proposedBy}`)
      lines.push(`    票：${yes.length === 0 ? '无' : yes.join(' + ')}（${yes.length}/2）`)
      if (p.expiresAt !== null) lines.push(`    过期：${p.expiresAt}`)
      if (p.withdrawn != null) {
        lines.push(`    🪦 撤回碑：${p.withdrawn.by === me ? '我' : p.withdrawn.by} 于 ${p.withdrawn.at}`)
        lines.push('       （碑不参与生效；想恢复就重新 add 同一个 id）')
      }
      if (p.conflict === true) {
        lines.push(`    ⚠️ 冲突：两端提了同名但路径不同的提案（${(p.relConflict ?? []).join(' vs ')}）`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  log('info', `已挂载：${cfg.label}，同步口 ${cfg.port}，范围 ${cfg.targets.map((t) => t.id).join('+')}`)

  // ── 启动后读一次配对状态（异步，不阻塞挂载）────────────────
  void loadPaired().then(() => {
    if (runtime.secret !== '') {
      log('info', `已配对（${state.pairedAt ?? '时间未知'}），可以同步了`)
    } else {
      log('info', '还没配对：点左栏「小鲸鱼同步」出二维码，手机扫一下就成')
    }
  })

  // ── 启动后读一次提案清单（2026-10-23 加）────────────────────
  // 必须在任何同步之前读到，否则第一次同步会以为「一条提案都没有」
  void reloadProposals().then(() => {
    if (proposals.length > 0) {
      const active = proposals.filter((p) => proposalState(p) === 'active').length
      log('info', `已载入 ${proposals.length} 条同步提案（其中 ${active} 条已生效）`)
    }
  })
}
