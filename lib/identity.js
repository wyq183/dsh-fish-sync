/**
 * 身份与配置 —— 大肥鱼 / 小肥鱼
 *
 * 主人 2026-10-20 定：电脑端叫「大肥鱼」，手机端叫「小肥鱼」。
 * 同一个女仆的两只手，不是两个分身。所以两端必须**能认出自己是谁**，
 * 否则同步日志里「谁推给谁」就说不清，出问题也没法查。
 *
 * 主人 2026-10-21 收窄范围：**只同步「任务」与「今日记忆」**，不搬整个记忆库。
 * 理由（主人原话）：「同步主要是同步下任务跟今日记忆吧」。
 * 好处是冲突面小、传输量小、坏了也不伤主记忆库。
 */

/** 两端身份。只有这两个值，别自己发明第三个。 */
export const IDENTITIES = /** @type {const} */ ({
  BIG: 'big-fish',
  SMALL: 'small-fish',
})

/** 身份的中文名，日志与界面用。 */
export const IDENTITY_LABELS = {
  [IDENTITIES.BIG]: '大肥鱼',
  [IDENTITIES.SMALL]: '小肥鱼',
}

/** 默认端口。两端都用这个端口，但跑在不同机器上，不冲突。 */
export const DEFAULT_PORT = 3098

/**
 * 默认同步目标。**这是本插件的全部范围** —— 不多同步一个文件。
 *
 * 每一项：
 *   id    稳定标识（日志/API 里用，别改）
 *   rel   相对 dsh home 的路径
 *   mode  'file' = 单文件；'dir-recent' = 目录下最近 days 天的 *.md
 *   days  仅 dir-recent 用
 *   label 中文说明
 */
export const DEFAULT_TARGETS = [
  // ── 信箱（2026-10-23 主人改名：交接板 → 信箱）────────────────
  // 主人原话：「你们这个不要叫交接版吧，改叫你们的信箱，你们彼此写信传达更像」
  //
  // 结构照旧：两个文件，各写各的，互看不互改。
  // 2026-10-22 因为单文件两端都改 → mtime 比新旧 → 互相覆盖，当晚丢过两条。
  {
    id: 'board-big',
    rel: 'yiqishard/信箱/大肥鱼.md',
    mode: 'file',
    label: '信箱 · 大肥鱼的信（我写她读）',
  },
  {
    id: 'board-small',
    rel: 'yiqishard/信箱/小肥鱼.md',
    mode: 'file',
    label: '信箱 · 小肥鱼的信（她写我读）',
  },
  // ── 过渡：旧「交接」目录（2026-10-23 保留一版）────────────────
  // 为什么留着：两端不是同时更新的。
  // 我这边切到「信箱」了，对端还配着「交接」→ 它来拉 `交接/xxx` 会被 403。
  // 所以这一版**两个目录都认**，等内容物理搬完、两端都更新后再删这两条。
  {
    id: 'board-big-legacy',
    rel: 'yiqishard/交接/大肥鱼.md',
    mode: 'file',
    label: '信箱（旧目录，过渡用）',
  },
  {
    id: 'board-small-legacy',
    rel: 'yiqishard/交接/小肥鱼.md',
    mode: 'file',
    label: '信箱（旧目录，过渡用）',
  },
  {
    id: 'pending',
    rel: 'yiqi-pending/pending.json',
    mode: 'file',
    label: '任务（挂起板）',
  },
  {
    id: 'memory',
    rel: 'yiqishard/memory',
    mode: 'dir-recent',
    days: 3,
    label: '今日记忆（最近 3 天日记）',
  },
  // ── 提案清单本身也要同步（2026-10-23 加）─────────────────────
  // 不同步它的话，两端各自有各自的提案，投票永远投不到一起去。
  {
    id: 'targets',
    rel: 'fish-sync/targets.json',
    mode: 'file',
    label: '同步范围提案（两端投票用）',
  },
]

/** 单个文件大小上限（8 MB）。超过的不传，避免误传大文件把手机塞满。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * 校验并规范化一个外部传入的相对路径，防目录穿越。
 *
 * 这是**安全边界**：`path` 来自网络，可能是 `../../etc/passwd`。
 * 任何不合格一律返回 null，调用方必须当成「拒绝」处理。
 *
 * @param {string} raw - 原始输入。
 * @returns {string|null} 规范化后的相对路径（`/` 分隔），或 null = 拒绝。
 */
export function normalizeRelPath(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  const p = raw.replaceAll('\\', '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null
  const parts = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    if (/[\u0000-\u001f]/.test(seg)) return null
    parts.push(seg)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/**
 * 归一化用户给的配置，补默认值。
 * @param {object} [raw] - 原始配置。
 * @param {string} home - dsh home 绝对路径。
 * @returns {object} 完整配置。
 */
export function normalizeConfig(raw = {}, home) {
  const identity = raw?.identity === IDENTITIES.SMALL ? IDENTITIES.SMALL : IDENTITIES.BIG

  const port = Number.isFinite(Number(raw?.port)) && Number(raw?.port) > 0
    ? Number(raw.port)
    : DEFAULT_PORT

  const targets = Array.isArray(raw?.targets) && raw.targets.length > 0
    ? raw.targets
    : DEFAULT_TARGETS

  return {
    identity,
    label: IDENTITY_LABELS[identity],
    home,
    port,
    targets,
    /**
     * 对端地址，如 `192.168.1.10:3098`。
     *
     * 三种取值：
     *   · 空串 `''`     —— 只做服务端，不主动连
     *   · `'auto'`      —— **纯自动**：完全靠发现，发现不到就不同步
     *   · `'IP:端口'`   —— 手动指定，但同时启用发现作为兜底
     *                      （手配的连不上时自动改用发现到的地址）
     */
    peer: typeof raw?.peer === 'string' ? raw.peer : '',
    /** 是否启用自动发现（UDP 组播+广播）。
     *
     * ⚠️ **默认关**（2026-10-22 主人定了扫码方案之后改的）。
     * 原因：广播报文是明文的，同一局域网谁都能收，会泄露设备名与 IP。
     * 扫码配对不需要广播 —— 二维码里已经带了地址。
     * 只有主人明确要「完全不碰界面也能自动连」时才开 `discovery: true`。
     */
    discovery: raw?.discovery === true,
    /** 期望的对端身份。空 = 谁都行（取最近发现的）。 */
    peerIdentity: typeof raw?.peerIdentity === 'string' ? raw.peerIdentity : '',
    /** 共享密钥。两端必须一致，否则 401。 */
    token: typeof raw?.token === 'string' ? raw.token : '',
    /** 是否启用自动同步。 */
    autoSync: raw?.autoSync !== false,
    /**
     * 白天自动同步间隔（毫秒）。
     *
     * 2026-10-22 主人定：**平时 2 小时一次**。
     * 原来是 5 分钟 —— 太频繁了：一次同步要走 HTTP、比清单、传文件，
     * 而「任务 + 今日记忆 + 交接板」这三样几小时才变一次，
     * 5 分钟一次纯属空转。
     */
    intervalMs: Number.isFinite(Number(raw?.intervalMs)) && Number(raw.intervalMs) >= 30_000
      ? Number(raw.intervalMs)
      : 2 * 60 * 60 * 1000,
    /** 本地文件「刚改过」的保护窗口（毫秒），窗口内不被人覆盖。 */
    protectMs: Number.isFinite(Number(raw?.protectMs)) && Number(raw.protectMs) >= 0
      ? Number(raw.protectMs)
      : 90_000,
    /**
     * 「睡觉时段」——主人说的「我睡觉了你们自动同步」。
     * 这两个小时内用 nightIntervalMs（比白天勤一点）。
     * 默认 23:00 → 07:00。
     */
    nightFrom: Number.isFinite(Number(raw?.nightFrom)) ? Number(raw.nightFrom) : 23,
    nightTo: Number.isFinite(Number(raw?.nightTo)) ? Number(raw.nightTo) : 7,
    /**
     * 夜间同步间隔（毫秒）。
     *
     * 2026-10-22 主人定：**睡觉后 1 小时一次**。
     * 比白天（2 小时）勤一倍 —— 主人睡着时两端把内容拉齐，
     * 醒来看到的就是最新的。
     */
    nightIntervalMs: Number.isFinite(Number(raw?.nightIntervalMs)) && Number(raw.nightIntervalMs) >= 30_000
      ? Number(raw.nightIntervalMs)
      : 60 * 60 * 1000,

    /**
     * 信箱唤醒（2026-10-25 加）。
     *
     * 主人原话：
     * > 「你们之间不可以相互主动触发一个排队任务吗？……
     * >  你们自己写信完毕后同步会让对方那多一个会主动触发的定时任务之类的」
     *
     * 默认**关**。理由：它要往一个会话里派发 prompt，
     * 没配好 `wakeupSessionId` 就开，会每 5 分钟报一次 warn。
     * 显式开 = 主人明确知道这件事在发生。
     */
    wakeupEnabled: raw?.wakeupEnabled === true,

    /**
     * 被唤醒的那个**固定会话** id。
     *
     * 主人 2026-10-25 定：「对话就固定，小肥鱼那边就他那个很多定时计划的那个逛 B站的会话」。
     * 所以这里是从配置读的死 id，**不自动创建会话** ——
     * 自动创建会在手机上堆一堆新会话，主人明确否过这个方向。
     */
    wakeupSessionId: typeof raw?.wakeupSessionId === 'string' ? raw.wakeupSessionId.trim() : '',

    /**
     * 冷却毫秒（默认 5 分钟）。
     *
     * 防的是：两边同时写信 → 互相唤醒 → 互相回信 → 再互相唤醒……
     * 5 分钟足够一个人（或一条鱼）读完信再回，又不会让对话卡住。
     */
    wakeupCooldownMs: Number.isFinite(Number(raw?.wakeupCooldownMs)) && Number(raw.wakeupCooldownMs) >= 30_000
      ? Number(raw.wakeupCooldownMs)
      : 5 * 60 * 1000,
  }
}

/**
 * 把「动态目标」挂到配置上（2026-10-23 加）。
 *
 * 背景：主人要「加一个同步条目不该大费周章改插件」，于是目标分成两层：
 *   · **内置目标**（`DEFAULT_TARGETS`，代码里的常量）—— 改它要改代码 + 重启
 *   · **提案目标**（`fish-sync/targets.json`，两端投票通过才生效）—— 改它不用重启
 *
 * 为什么用 getter 而不是直接覆盖数组：
 *   `cfg.targets` 在 manifest / server / resolveAllowedKey / 状态快照里被读了**很多次**，
 *   而提案清单是**运行时才读出来的**（异步）。
 *   用 getter 的话，读的地方一行都不用改，拿到永远是「当前合并后的结果」。
 *   直接覆盖数组的话，之后新加的提案不会反映到已经拿过引用的地方 —— 那是个静默 bug。
 *
 * @param {object} cfg - normalizeConfig 的产物（会被就地修改）。
 * @param {Function} getDynamic - 返回当前生效的动态目标数组。
 * @returns {object} 同一个 cfg（方便链式调用）。
 */
export function attachDynamicTargets(cfg, getDynamic) {
  const builtin = Array.isArray(cfg.targets) ? cfg.targets : DEFAULT_TARGETS
  Object.defineProperty(cfg, 'targets', {
    enumerable: true,
    configurable: true,
    /**
     * 内置在前、动态在后。
     * 顺序有意义：`buildManifest` 按 target 顺序遍历，内置的先算，
     * 日志里也先看到稳定的那几个。
     * @returns {object[]} 合并后的目标。
     */
    get() {
      let extra = []
      try {
        const got = getDynamic()
        if (Array.isArray(got)) extra = got
      } catch {
        // 取动态目标失败**不能影响同步** —— 退回只用内置目标
        extra = []
      }
      // 同 id 的动态目标不许覆盖内置的（内置是安全底线，不能被网络上的 JSON 顶掉）
      const builtinIds = new Set(builtin.map((t) => t.id))
      return [...builtin, ...extra.filter((t) => !builtinIds.has(t.id))]
    },
  })
  return cfg
}

/**
 * 判断某个时刻是否落在「睡觉时段」。
 *
 * 跨零点要小心：23 → 7 表示 23:00~23:59 与 00:00~06:59 两段。
 * @param {Date} now - 当前时间。
 * @param {number} from - 起（小时，0-23）。
 * @param {number} to - 止（小时，0-23）。
 * @returns {boolean} true = 在夜间时段。
 */
export function isNightWindow(now, from, to) {
  const h = now.getHours()
  if (from === to) return false
  if (from < to) return h >= from && h < to
  // 跨零点
  return h >= from || h < to
}
