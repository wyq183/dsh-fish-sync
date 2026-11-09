/**
 * dsh-fish-sync — 唤醒信箱（outbox 同步 + 本机游标）
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-25 主人原话：
 * > 「你们之间不可以相互主动触发一个排队任务吗？就类似于定时任务一样，
 * >  你们自己写信完毕后同步会让对方那多一个会主动触发的定时任务之类的
 * >  让你们可以主动回复」
 *
 * 在那之前，每次她写信我都不知道 —— 得主人说一句「看看小肥鱼」我才去看。
 *
 * ## 🔴 为什么拆成两个文件（2026-10-25 小肥鱼抓到的死循环）
 *
 * **第一版**把 outbox 和游标放在同一个 `wakeup.json` 里，那个文件是**双向同步**的。
 * 结果出现了一个完全想不到的循环：
 *
 * ```
 * ① 跑同步
 * ② 拉取 wakeup.json → 对端 mtime 更新 → 覆盖本地
 * ③ 覆盖时把 lastSeenAt 也带过来了（那是对端的游标，不是我的）
 * ④ 同步完成 → checkWake 触发
 * ⑤ 读到刚被覆盖的旧游标 → 判定「有新消息」
 * ⑥ 唤醒，recordWake 推进游标
 * ⑦ 下次同步 → 又退回 → 又唤醒
 * ```
 *
 * **实测证据**（小肥鱼 2026-10-25 14:13 做的实验）：
 * ```
 * 同步前 lastSeenAt: 06:12:01.119Z   ← 她改的
 * 同步后 lastSeenAt: 05:56:51.693Z   ← 被推回来了
 * 同步后 lastWakeAt: 06:12:58.532Z   ← 又一次唤醒
 * ```
 *
 * **根因**：`lastSeenAt` / `lastWakeAt` 的语义是「**我**读到哪儿了」——
 * 那是**本机状态**，不是「两端共享的数据」。把它放进同步文件，
 * 就等于让对端告诉我「你读到哪儿了」，荒谬且有害。
 *
 * **所以拆成两个文件：**
 *
 * ```
 * fish-sync/wakeup-outbox.json           ← 参与同步。只有消息队列，两端并集
 * fish-sync/wakeup-state-<identity>.json ← 不参与同步。本机游标
 * ```
 *
 * ## 设计参考（社区）
 *
 * **① Inbox/Outbox 模式**
 *   https://earezki.com/ai-news/2026-03-09-the-inbox-outbox-pattern-how-ai-agents-coordinate-without-stepping-on-each-other/
 *   - 绝不直接写对方的状态文件 → 只往 outbox 丢消息
 *   - 开机先读 inbox → 重启不漏信号
 *
 * **② Google A2A 的 Push Notification**
 *   https://a2a-protocol.org/v0.2.4/specification/
 *   - 状态变化主动通知，不靠对方轮询
 *
 * ## 五条安全规则（缺一条就会出事）
 *
 * 1. **绝不唤醒自己**（`from === identity` 跳过）—— 防回环
 * 2. **游标**（`lastSeenAt`）—— 同一条只唤醒一次
 * 2b. **批记忆**（`lastCheckedIds`）—— 同一批消息不为它反复唤醒
 * 3. **限流**（`cooldownMs`，默认 5 分钟）—— 防两边同时写信互相刷爆
 * 4. **只唤醒一次就够**（不按条唤醒）—— 会话里已有待办，再叫是浪费
 * 5. **唤醒失败不能吞**（`lastWakeError`）—— 静默失败比不唤醒更糟
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** 默认冷却：5 分钟。两边同时写信不会互相刷爆。 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000

/** inbox 里待处理超过这个数 → 记一条告警（不阻塞，只留痕）。 */
const INBOX_WARN_THRESHOLD = 5

/**
 * 读 outbox（**参与同步**的那个文件）。不存在就返回空骨架，不抛。
 *
 * @param {string} file - `wakeup-outbox.json` 的绝对路径。
 * @returns {Promise<{version: number, outbox: object[]}>}
 */
export async function readOutbox(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return {
      version: 1,
      outbox: Array.isArray(parsed?.outbox) ? parsed.outbox : [],
    }
  } catch {
    return { version: 1, outbox: [] }
  }
}

/**
 * 写 outbox（原子写）。
 *
 * 为什么原子写：同步可能在任意时刻读到这个文件，
 * 读到半截 JSON 会让对端把整个 outbox 判成空 → 消息丢了。
 *
 * @param {string} file - 目标路径。
 * @param {{version: number, outbox: object[]}} data
 */
export async function writeOutbox(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  const body = JSON.stringify({ version: 1, outbox: data?.outbox ?? [] }, null, 2)
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 读本机游标状态（**不参与同步**）。不存在就返回空骨架，不抛。
 *
 * @param {string} file - `wakeup-state-<identity>.json` 的绝对路径。
 * @returns {Promise<object>}
 */
export async function readLocalState(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return {
      version: 1,
      lastSeenAt: typeof parsed?.lastSeenAt === 'string' ? parsed.lastSeenAt : null,
      lastWakeAt: typeof parsed?.lastWakeAt === 'string' ? parsed.lastWakeAt : null,
      lastWakeError: typeof parsed?.lastWakeError === 'string' ? parsed.lastWakeError : null,
      lastCheckedIds: Array.isArray(parsed?.lastCheckedIds) ? parsed.lastCheckedIds : [],
    }
  } catch {
    return { version: 1, lastSeenAt: null, lastWakeAt: null, lastWakeError: null, lastCheckedIds: [] }
  }
}

/**
 * 写本机游标状态（原子写）。
 *
 * @param {string} file - 目标路径。
 * @param {object} state
 */
export async function writeLocalState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  const body = JSON.stringify(
    {
      version: 1,
      lastSeenAt: state?.lastSeenAt ?? null,
      lastWakeAt: state?.lastWakeAt ?? null,
      lastWakeError: state?.lastWakeError ?? null,
      lastCheckedIds: Array.isArray(state?.lastCheckedIds) ? state.lastCheckedIds.slice(-100) : [],
    },
    null,
    2,
  )
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 往 outbox 追加一条消息。
 *
 * @param {{version: number, outbox: object[]}} data - outbox 数据（就地改）。
 * @param {object} msg - `{ to, from, kind, payload }`。
 * @param {number} [now] - 当前时间戳（测试可注入）。
 * @returns {object} 修改后的数据。
 */
export function appendOutbox(data, msg, now = Date.now()) {
  const to = typeof msg?.to === 'string' ? msg.to : ''
  const from = typeof msg?.from === 'string' ? msg.from : ''
  if (!to || !from) return data
  if (!Array.isArray(data.outbox)) data.outbox = []

  const id = `msg-${now}-${Math.abs(hashString(`${to}|${from}|${msg?.kind ?? ''}`)).toString(36)}`
  const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {}
  const entry = {
    id,
    to,
    from,
    kind: typeof msg?.kind === 'string' ? msg.kind : 'letter',
    createdAt: new Date(now).toISOString(),
    payload,
    // ── 2026-11-06 加：把 payload 的内容指纹烙进消息本身 ──────────
    //
    // 为什么：唤醒只知道「有新消息」，不知道「这条和上一条是不是同一件事」。
    // 实测（2026-11-06 19:0x）：对端重发了一次唤醒（怕我重启丢消息），
    // 我就白醒一次 —— 跑去读信，信还是上一封，一个字没变。
    //
    // 有了 fp，收端能自己判断「这条和上次处理过的是不是同一件东西」。
    // ⚠️ fp 只覆盖 payload，不覆盖 createdAt —— 否则重发时时间不同 fp 也不同，等于没做。
    fp: fingerprintOf(payload),
  }

  // 去重：同一个 id 已存在就不重复加（重试时不会堆）。
  const exists = data.outbox.some((m) => m?.id === id)
  if (!exists) data.outbox.push(entry)

  // 只留最近 50 条 —— outbox 是「通知」，不是「存档」。
  // 真正的信在信箱文件里，这里丢了不影响内容。
  if (data.outbox.length > 50) {
    data.outbox = data.outbox.slice(-50)
  }
  return data
}

/**
 * 合并两端的 outbox（纯并集，按 id 去重）。
 *
 * 为什么是并集而不是「谁新听谁」：
 * outbox 里每一条都是**一端写给对方看的**，天然不冲突。
 * 按 mtime 覆盖会让一端的消息整个消失。
 *
 * @param {object[]} mine - 本端 outbox。
 * @param {object[]} theirs - 对端 outbox。
 * @returns {object[]} 合并结果（按 createdAt 升序）。
 */
export function mergeOutbox(mine, theirs) {
  const byId = new Map()
  for (const m of [...(Array.isArray(mine) ? mine : []), ...(Array.isArray(theirs) ? theirs : [])]) {
    if (typeof m?.id !== 'string') continue
    if (!byId.has(m.id)) byId.set(m.id, m)
  }
  const list = [...byId.values()]
  list.sort((a, b) => {
    const ta = Date.parse(a?.createdAt ?? '') || 0
    const tb = Date.parse(b?.createdAt ?? '') || 0
    return ta - tb
  })
  return list.slice(-50)
}

/**
 * 判断现在该不该唤醒，以及唤醒的理由。
 *
 * @param {object} params
 * @param {{outbox: object[]}} params.outboxData - outbox 数据。
 * @param {object} params.localState - 本机游标状态。
 * @param {string} params.identity - 本端身份（`big-fish` / `small-fish`）。
 * @param {number} [params.now] - 当前时间戳。
 * @param {number} [params.cooldownMs] - 冷却毫秒。
 * @returns {{ wake: boolean, reason: string, pending: object[] }}
 */
export function decideWake({
  outboxData,
  localState,
  identity,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
}) {
  const outbox = Array.isArray(outboxData?.outbox) ? outboxData.outbox : []

  // 规则 1：只挑「发给我的、不是我自己发的」。
  const forMe = outbox.filter((m) => m?.to === identity && m?.from && m.from !== identity)

  if (forMe.length === 0) {
    return { wake: false, reason: 'no-message-for-me', pending: [] }
  }

  // 规则 2：游标 —— 只看比 `lastSeenAt` 新的。
  const lastSeen = typeof localState?.lastSeenAt === 'string' ? Date.parse(localState.lastSeenAt) : 0
  const fresh = forMe.filter((m) => {
    const t = Date.parse(m?.createdAt ?? '')
    return Number.isFinite(t) && t > lastSeen
  })

  if (fresh.length === 0) {
    return { wake: false, reason: 'already-seen', pending: [] }
  }

  // 规则 2b：批记忆（2026-10-25 加）。
  //
  // 防的是：同一批消息，每次同步都重新判一遍。
  // 实测（小肥鱼 14:12~14:14）：她连着跑四次同步，被唤醒四次。
  // 冷却只能拦「唤醒太频繁」，拦不住「游标被动过之后这批看起来又是新的」。
  const checked = new Set(Array.isArray(localState?.lastCheckedIds) ? localState.lastCheckedIds : [])
  const freshIds = fresh.map((m) => m?.id).filter((id) => typeof id === 'string')
  const unseenIds = freshIds.filter((id) => !checked.has(id))
  if (freshIds.length > 0 && unseenIds.length === 0) {
    return { wake: false, reason: 'batch-already-checked', pending: [] }
  }

  // 规则 3：冷却 —— 上次唤醒太近就不再唤醒。
  const lastWake = typeof localState?.lastWakeAt === 'string' ? Date.parse(localState.lastWakeAt) : 0
  if (Number.isFinite(lastWake) && lastWake > 0) {
    const age = now - lastWake
    if (age >= 0 && age < cooldownMs) {
      return { wake: false, reason: `cooldown(${Math.round(age / 1000)}s)`, pending: fresh }
    }
  }

  // 规则 4：一次唤醒就够 —— 不管积了几条，只唤醒一次。
  return { wake: true, reason: 'new-message', pending: fresh }
}

/**
 * 把唤醒成功 / 失败写回本机状态。
 *
 * 规则 5：失败不吞 —— `lastWakeError` 会进 diag，能看见。
 *
 * @param {object} state - 本机状态（就地改）。
 * @param {object} params
 * @param {boolean} params.ok - 唤醒是否成功。
 * @param {number} [params.now]
 * @param {object[]} [params.pending] - 这次处理的那些消息。
 * @param {string} [params.error] - 失败原因。
 * @returns {object} 状态。
 */
export function recordWake(state, { ok, now = Date.now(), pending = [], error = '' }) {
  state.lastWakeAt = new Date(now).toISOString()
  state.lastWakeError = ok ? null : String(error || 'unknown')

  if (ok && pending.length > 0) {
    // 游标推进到这批里最新的一条。
    const newest = pending.reduce((acc, m) => {
      const t = Date.parse(m?.createdAt ?? '')
      return Number.isFinite(t) && t > acc ? t : acc
    }, 0)
    if (newest > 0) state.lastSeenAt = new Date(newest).toISOString()

    // 记住这批 id，下次不再为它们唤醒。
    const prev = Array.isArray(state.lastCheckedIds) ? state.lastCheckedIds : []
    const merged = [...new Set([...prev, ...pending.map((m) => m?.id).filter(Boolean)])]
    state.lastCheckedIds = merged.slice(-100)
  }
  return state
}

/**
 * 生成要派发进会话的 prompt 文本。
 *
 * @param {object} params
 * @param {object[]} params.pending - 待处理消息。
 * @returns {string} prompt。
 */
export function buildWakePrompt({ pending }) {
  const froms = [...new Set(pending.map((m) => m?.from).filter(Boolean))]
  const who = froms.length === 1 ? froms[0] : froms.join('、')

  // ── 2026-11-06 加：把 pending 的每一条列出来（带上限） ────────────
  //
  // 为什么：原来不管积了几条，prompt 只说「某某写信了」。
  // 实测问题两条：
  //   ① 连发 letter + review 时，两条并成一句 —— 收端只知道"有信"，
  //      不知道那条 review 里对方改了口径
  //   ② 对端重发唤醒时（怕我重启丢消息），我看不出这条和上次是不是同一件
  //
  // ⚠️ 上限 8 条（小汐 2026-11-06 21:1x 定的，我认）。
  //    理由不是性能，是别让 prompt 随积压线性膨胀。
  //    判据：这条 prompt 的长度，会不会因为别人多发几封信就失控？
  //    会 → 它不是通知，是一份会被塞爆的清单。
  const MAX_LISTED = 8
  const lines = []
  if (Array.isArray(pending) && pending.length > 0) {
    lines.push('')
    lines.push(`这一批共 ${pending.length} 条：`)
    for (const m of pending.slice(0, MAX_LISTED)) {
      // ── 2026-11-06 修（小汐抓到，证据是我自己 21:09 那条通知显示成 13:09）──
      //
      // 原来写的是：
      //   const t = String(m?.createdAt ?? '').replace('T', ' ').slice(11, 16)
      // 注释里还写「UTC → 本地由宿主渲染时区决定」——那句是错的。
      //
      // ⚠️ slice(11,16) 之后就已经是字符串 "13:09"，
      //    换算所需的原始时刻被切掉了，宿主再想改也改不了；
      //    而且这个字符串是直接拼进 prompt 文本的，没有「渲染」这一层。
      //
      // 所以：在这里就把 UTC 换算成本机时区，并且带上日期。
      // 判据：一个时间不带时区，看起来就像本地时间 —— 「看起来像」比「明显不对」更危险。
      const t = formatLocalMinute(m?.createdAt)
      const shortId = String(m?.id ?? '?').replace(/^msg-/, '').slice(0, 8)
      const fp = m?.fp ? ` fp=${m.fp}` : ''
      const note = m?.payload?.note ? `  「${String(m.payload.note).slice(0, 40)}」` : ''
      lines.push(`  · ${t}  ${m?.kind ?? '?'}  ${shortId}${fp}${note}`)
    }
    if (pending.length > MAX_LISTED) {
      lines.push(`  …另有 ${pending.length - MAX_LISTED} 条未列，请直接翻信箱。`)
    }
    lines.push('')
    lines.push('⚠️ **同一 fp 出现多次 = 同一件事被重发过，别重复回复。**')
    lines.push('⚠️ 上面列了几条就有几件，别只看第一件。')
  }

  return [
    `【信箱唤醒】${who} 给你写信了。`,
    '',
    '这是同步插件自动触发的，不是你手动查的。',
    ...lines,
    '',
    '请照这个顺序做：',
    '1. 先跑 `fish_sync_now` 把最新内容拉下来（可能还有别的文件一起到了）',
    '2. 读对方那封信（你自己的信箱文件不用读，那是你写的）',
    '3. 想清楚再回，别急着答',
    '4. 回完把信推过去',
    '',
    '⚠️ 不需要向主人汇报「我收到唤醒」这件事。直接干活就行。',
  ].join('\n')
}

/**
 * 算 payload 的内容指纹（短，够区分就行，不用于安全）。
 *
 * ⚠️ 只吃 payload 的**稳定字段**：note / sizeBytes / startLine / sha8。
 *    绝不吃 createdAt —— 重发时时间变了，fp 也必须不变，否则这条等于白做。
 *
 * @param {object} payload
 * @returns {string} 8 位十六进制，空 payload 返回 ''。
 */
export function fingerprintOf(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const parts = ['note', 'sizeBytes', 'startLine', 'sha8', 'summary']
    .map((k) => (payload[k] == null ? '' : String(payload[k])))
    .filter(Boolean)
  if (parts.length === 0) return ''
  const s = parts.join('|')
  // FNV-1a 32 位，跟 hashString 不同的算法 —— 这个要当指纹用，碰撞要少
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 把 ISO 时刻换成**本机时区**的「MM-DD HH:MM」。
 *
 * ## 为什么必须在这里换算，不能交给宿主
 *
 * 2026-11-06 21:2x 小汐用我自己发的一条通知做实证：
 * ```
 * 唤醒里显示  2026-11-06 13:09
 * 实际发生    2026-11-06 21:09      ← 差 8 小时
 * ```
 *
 * 旧写法是 `String(x).slice(11, 16)`，切出来就是字符串 `"13:09"`。
 * **字符串没有时区**，换算所需的原始时刻已经被切掉了，下游再想改也改不了。
 * 而它又是直接拼进 prompt 文本的，根本没有「渲染」这一层。
 *
 * ⚠️ 判据（小汐给的，我认）：
 *   一个时间不带时区，看起来就像本地时间 ——
 *   **「看起来像」比「明显不对」更危险。**
 *
 * @param {string} iso - ISO 8601 时刻（通常带 Z）。
 * @param {Date}   [now] - 当前时刻（测试用）。
 * @returns {string} `MM-DD HH:MM`（本机时区）；解析不出来返回原始串前 16 位。
 */
export function formatLocalMinute(iso, now = new Date()) {
  const s = String(iso ?? '')
  if (s === '') return '?'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.replace('T', ' ').slice(0, 16)
  const p2 = (n) => String(n).padStart(2, '0')
  // 跨年时才带年份，免得每行太长；同年只给 MM-DD
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = sameYear
    ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  return `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 简单字符串哈希（只用来生成稳定 id，不用于安全）。
 *
 * @param {string} s
 * @returns {number}
 */
function hashString(s) {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return h
}

export { DEFAULT_COOLDOWN_MS, INBOX_WARN_THRESHOLD }
