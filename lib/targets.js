/**
 * targets —— 「要同步什么」变成可扩展的，但**不许一个人说了算**。
 *
 * ## 为什么要这个文件
 *
 * 2026-10-23 主人原话：
 * > 「插件本身应该多一点拓展也就是方便性更新，比如我要新增一个让你们同步的条目，
 * >  比如哪天我要出门玩，要你们做个临时同步，关于今天我去哪玩了的记录分享，
 * >  总不能这么简单还要大费周章的更新插件吧」
 * > 「顶层白名单你们可以商量下，允许你们自己加同步内容，但是**你们得商量投票来**」
 *
 * 所以：目标不再写死在 `DEFAULT_TARGETS` 里，而是存在 `fish-sync/targets.json`，
 * **这个文件本身也参与同步** —— 两端的提案和投票能互相看见。
 *
 * ## 投票怎么算数
 *
 * 提案带 `votes: { 'big-fish': 'yes', 'small-fish': 'yes' }`。
 *
 * · 提出方自动投一票 yes
 * · **两端都 yes 才生效**（`yes.length >= 2`）
 * · 只有一票 = 待投票，**不生效** —— 宁可慢，不许一个人扩边界
 *
 * ## 合并（这是最容易做错的地方）
 *
 * ⚠️ **按 `id` 取并集，`votes` 也取并集 —— 绝不按 mtime 谁新谁赢。**
 *
 * 按 mtime 赢的话：我在电脑上提一个，她在手机上提一个，
 * 后同步的那个会**整个覆盖**掉前一个 → 两边的提案互相打架，永远投不齐票。
 * 这和 2026-10-22 单文件交接板丢两条是同一个病。
 *
 * ## 顶层白名单（安全边界，不是装饰）
 *
 * `targets.json` 来自网络，内容是「允许同步哪些路径」。
 * **它自己就是攻击面** —— 谁写进去一条 `rel: '.ssh/id_rsa'`，私钥就出门了。
 *
 * 两道闸：
 *   ① 顶层目录白名单（只认下面 ALLOWED_ROOTS 里的）
 *   ② 明确排除（`fish-sync/paired.json` 里是**长期密钥**，绝不能同步）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeRelPath } from './identity.js'

/** 目标清单文件相对 dsh home 的路径。 */
export const TARGETS_REL = 'fish-sync/targets.json'

/**
 * 允许被提案的**顶层目录**。
 *
 * 只认这些，别的一律拒。加新根目录要走代码改动 + 两端重启，
 * 因为「允许哪些根」本身就是安全边界，不该由网络上的 JSON 决定。
 */
export const ALLOWED_ROOTS = [
  'yiqishard', // 记忆库（含信箱、日记、两志）
  'yiqi-pending', // 挂起板
  '知识库', // 知识库
  '梗库', // 梗库
  'fish-sync', // 插件自身状态（只有 targets.json 能过，见下）
]

/**
 * 明确排除的路径（即使在白名单根目录下也不许同步）。
 *
 * ⚠️ 第一条是**密钥**。`paired.json` 里存着两端的长期共享密钥，
 * 同步它 = 把钥匙贴在局域网上。这条绝不能删。
 */
export const DENY_PATTERNS = [
  /^fish-sync\/paired\.json$/, // 🔴 长期密钥，绝不外传
  /^fish-sync\/diag\.json$/, // 诊断日志，没必要
  /**
   * 备份文件。
   *
   * ⚠️ 匹配的是**任意位置**的 `.bak`，不是「以 .bak 开头」（2026-10-23 写错过一次）。
   * 实际文件名长这样：`大肥鱼.md.bak-before-protectms-20261023-202745` ——
   * `.bak` 前面是 `md` 不是 `/`，所以 `/\.bak/` 而不是 `/(^|\/)\.bak/`。
   *
   * 为什么备份文件一律不同步：它们体量大（我这边光 sync.js 就堆了 4 个 .bak），
   * 内容还全是旧版 —— 传过去只会污染对端，还会让「谁是最新版」变得说不清。
   */
  /\.bak(-|$|\.)/,
  /(^|\/)\.history\//, // 历史快照目录
  /(^|\/)node_modules\//, // 依赖，别传
]

/**
 * 🔴 主人明确说「这份不要同步」的文件（**精确路径，不是正则**）。
 *
 * ## ⚠️ 为什么不直接塞进 `DENY_PATTERNS`
 *
 * **`DENY_PATTERNS` 是安全边界**（密钥 / 备份 / 依赖 / 历史快照）——
 * 那些是「不管谁说，都不该传」的东西。
 *
 * **这个列表是「主人的偏好」** —— 那些文件**技术上能传，只是主人不想要**。
 *
 * **两者在代码里的效果一样（都返回 null），但语义完全不同：**
 * · 安全边界：删了就是漏洞
 * · 主人偏好：删了只是「又开始同步了」
 *
 * **⚠️ 混在一起，以后看到的人会以为「抑郁那份是安全风险」—— 它不是。**
 *
 * ## 加一条的格式
 *
 * 用**完整相对路径**，不是正则。理由：
 * · 正则写错会误伤（比如 `关于抑郁` 会匹配到任何含这四个字的文件）
 * · 精确路径写错只会「不生效」，不会「多挡了别的」
 *
 * ## 怎么恢复（主人以后说「还是同步吧」）
 *
 * 删掉对应那一行 → 两端都改 + 都重启 → 文件重新进入同步范围。
 * **⚠️ 但两端都得删 —— 只删一端，另一端还会拒收/推送。**
 *
 * @type {string[]}
 */
export const USER_EXCLUDED = [
  /**
   * 2026-10-26 14:47 主人原话：「好吧，你们觉得这个不算知识那就不同步吧」
   *
   * 背景：这份是「主人的病与情绪」，不是「关于主人的事实」。
   * `AGENTS.md` 那张表写着「私密内容（日记 / 记录 / 个人档案 / **机主的病与情绪**）❌ 不给」。
   *
   * ⚠️ 文件本身**还在磁盘上**（改名为 `.bak-移出同步-20261026`），没删。
   * 只是不让它参与同步。
   */
  '知识库/主人/主人-关于抑郁这件事.md',
]

/**
 * 判断一个键是否在「主人排除列表」里。
 *
 * ⚠️ 精确匹配，不做前缀/子串匹配 —— 见 `USER_EXCLUDED` 的注释。
 *
 * @param {string} key - 规范化后的相对键。
 * @returns {boolean} true = 主人明确说不要同步。
 */
export function isUserExcluded(key) {
  return USER_EXCLUDED.includes(key)
}

/** 一个提案最多能覆盖多少天（防止有人写 days: 99999 把整个库拖走）。 */
const MAX_DAYS = 30

/**
 * 判断一个相对路径是否允许出现在提案里。
 *
 * @param {string} rawRel - 原始 rel。
 * @returns {string|null} 规范化后的 rel，或 null = 拒绝。
 */
export function sanitizeTargetRel(rawRel) {
  const rel = normalizeRelPath(rawRel)
  if (rel === null) return null

  // 顶层目录必须在白名单里
  const root = rel.split('/')[0]
  if (!ALLOWED_ROOTS.includes(root)) return null

  // 明确排除
  for (const re of DENY_PATTERNS) {
    if (re.test(rel)) return null
  }

  return rel
}

/**
 * 校验一条提案的形状。不合法的直接丢弃（不是抛错）。
 *
 * @param {unknown} raw - 原始提案。
 * @returns {object|null} 规范化后的提案，或 null。
 */
export function normalizeProposal(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const p = /** @type {Record<string, unknown>} */ (raw)

  const id = typeof p.id === 'string' ? p.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return null

  const rel = sanitizeTargetRel(typeof p.rel === 'string' ? p.rel : '')
  if (rel === null) return null

  /**
   * 同步模式。
   *
   * · `file`       —— 单个文件
   * · `dir-recent` —— 目录下最近 N 天的 `YYYY-MM-DD.md`（日记那种）
   * · `dir`        —— 目录下**所有文件**（不管叫什么名字）
   *
   * ⚠️ `dir` 是 2026-10-26 加的。为什么需要它：
   *    `dir-recent` 只收 `/^\d{4}-\d{2}-\d{2}\.md$/` 这种文件名
   *    （见 manifest.js 的 listTargetFiles）。
   *    而 `知识库/写作/` 里是 `视频模板.md`、`判据集.md` —— 名字不是日期，
   *    **一个都进不了清单**，于是「提案生效了但文件永远不过去」。
   *    实测：小肥鱼 10:03 把三份搬进 `$DSH_HOME/知识库/写作/`，
   *    `ls` 看得见、字节数对得上，但两端 manifest 里都是 0 个。
   *    两个人猜了一小时「是不是缓存 / 是不是没提提案」，真相是一行正则。
   *
   * ⚠️ `dir` **不接受 `days`**（2026-10-26 改，小肥鱼指出）。
   *
   *    第一版我给它加了「可选 days，按 mtime 筛」。她反对，理由比我的强：
   *    > 两个模式的区别应该是「选哪些文件」，不是「再叠一层时间筛选」。
   *    > 揉进去之后，同一个 `dir` 提案在两端的语义会不一样 ——
   *    > 你传了 days，我没传，扫出来的清单又对不上。
   *
   *    **这是对的。** 提案是两端共享的语义契约，任何一端能加筛选，
   *    清单就不可比了。要「整个目录 + 只要最近 N 天」应该另开一个模式，
   *    而不是给现有模式加可选参数。
   *
   *    所以 `dir` 的 `days` 被**丢弃**（不是报错，是忽略）——
   *    这样老提案（带 days 的）不会突然失效，只是 days 不起作用。
   */
  const mode = p.mode === 'dir-recent' ? 'dir-recent'
    : p.mode === 'dir' ? 'dir'
      : 'file'

  /**
   * 天数过滤。
   *
   * · `file`       —— 无意义，undefined
   * · `dir-recent` —— **必填语义**，默认 3（它本来就是「最近几天」）
   * · `dir`        —— **永远 undefined**（见上面那段：不接受 days）
   */
  const days = mode === 'dir-recent'
    ? Math.min(MAX_DAYS, Math.max(1, Number.isFinite(Number(p.days)) ? Number(p.days) : 3))
    : undefined

  const label = typeof p.label === 'string' && p.label.trim() !== ''
    ? p.label.trim().slice(0, 80)
    : rel

  const proposedBy = p.proposedBy === 'small-fish' ? 'small-fish' : 'big-fish'

  const proposedAt = typeof p.proposedAt === 'string' ? p.proposedAt : new Date(0).toISOString()

  /** 过期时间：没写 = 长期有效。写了必须是合法 ISO。 */
  let expiresAt = null
  if (typeof p.expiresAt === 'string' && p.expiresAt !== '') {
    const t = Date.parse(p.expiresAt)
    if (Number.isFinite(t)) expiresAt = new Date(t).toISOString()
  }

  /** 票：只认 big-fish / small-fish，值只认 yes。 */
  const votes = {}
  const rawVotes = p.votes !== null && typeof p.votes === 'object' ? p.votes : {}
  for (const who of ['big-fish', 'small-fish']) {
    if (/** @type {any} */ (rawVotes)[who] === 'yes') votes[who] = 'yes'
  }
  // 提出方自动有一票（防止「提了但忘了投」导致自己提的永远不生效）
  votes[proposedBy] = 'yes'

  /**
   * 撤回墓碑（2026-10-24 加）。
   *
   * ## 为什么要有它
   *
   * 原来 `withdraw` 是**直接从数组里删掉**。但合并是**纯并集**：
   * 本端删了、对端那份还在 → 下次同步又把它带回来。**撤回永远传不出去。**
   * （2026-10-24 实际踩到：四条日记提案，两端各撤一半，结果全部复活。）
   *
   * ## 语义
   *
   * 撤回不是「删除」，是**立一块碑**：`{ by, at }`。
   * 碑**参与合并**（两边取时间更晚的那块），所以能传播出去；
   * 碑一旦立了，这条提案就**不生效**（`proposalState` → `'withdrawn'`）。
   *
   * ## 想恢复怎么办
   *
   * 重新 `add` 同一个 id —— 新的 `proposedAt` 晚于碑的时间，就盖过碑。
   * 这样「先撤回、后重新提」在两端合并时不会打架（晚的赢）。
   *
   * @type {{by: string, at: string}|null}
   */
  let withdrawn = null
  if (p.withdrawn !== null && typeof p.withdrawn === 'object') {
    const w = /** @type {Record<string, unknown>} */ (p.withdrawn)
    const by = w.by === 'small-fish' ? 'small-fish' : (w.by === 'big-fish' ? 'big-fish' : null)
    const at = typeof w.at === 'string' ? w.at : null
    if (by !== null && at !== null) {
      const t = Date.parse(at)
      if (Number.isFinite(t)) withdrawn = { by, at: new Date(t).toISOString() }
    }
  }

  /**
   * ⚠️ `days` 字段：**没有就真的不写**，不是写 `undefined`（2026-10-26 11:40 改）。
   *
   * ## 为什么
   *
   * 小肥鱼 11:35 指出：
   * > 「如果你的 `dir` 保留了 `days: undefined`，而我的是『字段不存在』——
   * >   `JSON.stringify({a:1, days:undefined})` = `{"a":1}`，看起来一样，
   * >   但 `'days' in obj` 一个 true 一个 false。」
   *
   * **我实测了：这不影响 `mergeProposals`。**
   * 它的 `sameRel` 只比 `rel` 和 `mode` 两个字段，根本不看 `days`。
   * （实测：我这边 `'days' in p` = true，她那边 false，合并后 mode 仍是 `dir`，无冲突。）
   *
   * **但她说得对，还是要改** —— 因为**对象形状不一样，下次谁写 `if ('days' in p)` 就会分叉。**
   *
   * 判据：「不影响当前逻辑」不等于「不用改」。
   *       只要两端的**对象形状**不同，就埋了一个「以后会分叉」的坑。
   *
   * ## 写法
   *
   * 用条件展开，而不是 `days: undefined`。
   * 这样 `Object.keys()` 里根本没有 `days`，跟「不存在」完全一致。
   */
  return {
    id,
    rel,
    mode,
    ...(days === undefined ? {} : { days }),
    label,
    proposedBy,
    proposedAt,
    expiresAt,
    votes,
    withdrawn,
  }
}

/**
 * 算一条提案的当前状态。
 *
 * @param {object} proposal - 已规范化提案。
 * @param {Date} [now] - 当前时间。
 * @returns {'active'|'pending'|'expired'|'withdrawn'} 状态。
 */
export function proposalState(proposal, now = new Date()) {
  // 撤回优先于一切（2026-10-24 加）：碑立了就失效，票再多也不行。
  // 注意用 `!= null`：老对象上这个字段是 undefined。
  if (proposal.withdrawn != null) {
    // 除非它被「重新提议」盖过（新的 proposedAt 晚于碑）
    const tombAt = Date.parse(proposal.withdrawn.at)
    const reAt = Date.parse(proposal.proposedAt)
    if (!(Number.isFinite(reAt) && Number.isFinite(tombAt) && reAt > tombAt)) {
      return 'withdrawn'
    }
  }
  if (proposal.expiresAt !== null && Date.parse(proposal.expiresAt) <= now.getTime()) {
    return 'expired'
  }
  const yesCount = Object.values(proposal.votes).filter((v) => v === 'yes').length
  return yesCount >= 2 ? 'active' : 'pending'
}

/**
 * 读目标清单文件。
 *
 * @param {string} home - dsh home。
 * @returns {Promise<{version: number, proposals: object[]}>} 清单（不存在就给空）。
 */
export async function readTargetsFile(home) {
  try {
    const text = await readFile(join(home, TARGETS_REL), 'utf8')
    const data = JSON.parse(text)
    const rawList = Array.isArray(data?.proposals) ? data.proposals : []
    const proposals = []
    const seen = new Set()
    for (const raw of rawList) {
      const p = normalizeProposal(raw)
      if (p === null) continue
      if (seen.has(p.id)) continue
      seen.add(p.id)
      proposals.push(p)
    }
    return { version: 1, proposals }
  } catch {
    // 文件不存在 / 坏了 → 空清单。**不是错误**（第一次运行本来就没有）
    return { version: 1, proposals: [] }
  }
}

/**
 * 写目标清单文件。
 *
 * @param {string} home - dsh home。
 * @param {{proposals: object[]}} data - 要写的清单。
 * @returns {Promise<void>} 写完。
 */
export async function writeTargetsFile(home, data) {
  const abs = join(home, TARGETS_REL)
  await mkdir(dirname(abs), { recursive: true })
  const text = JSON.stringify({ version: 1, proposals: data.proposals ?? [] }, null, 2)
  await writeFile(abs, text, 'utf8')
}

/**
 * 合并两端的提案清单（**并集，不是覆盖**）。
 *
 * 规则：
 *   · 同 id 的提案：内容取 `proposedBy` 那一方的（提出方是权威），
 *     `votes` **取并集**（谁投过 yes 就都留着）
 *   · 同 id 但 `rel` 不一致：说明两端各提了一个同名但内容不同的，
 *     这是真冲突 → 保留双方票，但**不生效**（`rel` 标记为冲突，让状态卡在 pending）
 *
 * @param {object[]} mine - 本端提案。
 * @param {object[]} theirs - 对端提案。
 * @returns {object[]} 合并结果。
 */
export function mergeProposals(mine, theirs) {
  const byId = new Map()

  /**
   * 并入一条。
   * @param {object} p - 提案。
   */
  const absorb = (p) => {
    const prev = byId.get(p.id)
    if (prev === undefined) {
      byId.set(p.id, { ...p, votes: { ...p.votes } })
      return
    }
    // 同 id：票取并集
    const votes = { ...prev.votes, ...p.votes }
    // 内容以提出方为准；两边都自称提出方且 rel 不同 = 真冲突
    const sameRel = prev.rel === p.rel && prev.mode === p.mode
    if (!sameRel && prev.proposedBy !== p.proposedBy) {
      // 冲突：保留两条的票，但把 rel 标成不可用，状态会卡在 pending
      byId.set(p.id, {
        ...prev,
        votes,
        conflict: true,
        relConflict: [prev.rel, p.rel],
      })
      return
    }
    /**
     * 挑赢家。
     *
     * ## ⚠️ 这里原来有个静默丢更新的 bug（2026-10-26 小肥鱼查出，我复现并修）
     *
     * 原代码：
     * ```js
     * const winner = p.proposedBy === prev.proposedBy ? prev : (p.proposedAt > prev.proposedAt ? p : prev)
     * ```
     *
     * **`proposedBy` 相同时，无条件取 `prev`（本机那份），完全不看 `proposedAt`。**
     *
     * 于是：
     * ```
     * 本机：write-dir  mode=dir-recent  proposedAt=02:03
     * 对端：write-dir  mode=dir         proposedAt=03:56   ← 同一个提出方，改得晚 43 分钟
     *                ↓
     * proposedBy 相同 → winner = prev = 本机旧版
     *                ↓
     * 对端的更新被静默丢弃（不报错、不提示、看起来一切正常）
     * ```
     *
     * **实测（`test/_bug.mjs`）确认：**
     * ```
     * 本机=旧版，对端推新版  → 结果 mode=dir-recent  [X 新版丢了]
     * 本机=新版，对端推旧版  → 结果 mode=dir         [OK]
     * ```
     *
     * **⚠️ 注意反向也通 —— 也就是说「谁赢」完全取决于「谁是本机」，跟时间无关。**
     * 这不是「提出方权威」，这是「本机权威」。
     *
     * ## 真实语义（原来变成了这样，跟注释写的完全相反）
     *
     * 注释写的是「内容取 `proposedBy` 那一方的（提出方是权威）」。
     * 实际实现是：**提出方能建立提案，但不能更新自己的提案。**
     *
     * ## 修法
     *
     * 能走到这一行的，只有两种情况（其余都在上面判冲突 return 了）：
     *   · 同提出方（`proposedBy` 相同）
     *   · 不同提出方，但 `rel` 和 `mode` 都相同
     *
     * **两种情况都该「比时间」** —— 因为：
     *   · 同提出方：谁改得晚谁赢（这是「更新」的正常语义）
     *   · 不同提出方但内容一致：内容一样，取谁都一样，比时间无害
     *
     * 所以直接比 `proposedAt`。
     *
     * ## ⚠️ 这个改动会改变两端行为，必须两端一起改 + 都重启
     *
     * 只改一端的话：改的一端取新的，没改的一端取本机旧的 → 两边仍然不一致。
     * **但至少改的一端不会再静默丢更新。**
     *
     * ## 边界：时间完全相同时
     *
     * `p.proposedAt > prev.proposedAt` 为 false → 取 `prev`。
     * 也就是「时间相同时本机赢」—— 这是确定的、可预测的，
     * 而且因为两端算出的结果一样（只是角度相反），不会死循环。
     */
    const winner = p.proposedAt > prev.proposedAt ? p : prev
    byId.set(p.id, { ...winner, votes })
  }

  for (const p of mine) absorb(p)
  for (const p of theirs) absorb(p)

  /**
   * 🔴 墓碑归一（2026-10-24 加）：**碑必须能传播出去**。
   *
   * ## 为什么单独走一遍
   *
   * 上面 `absorb` 的 `winner` 是按 `proposedBy` / `proposedAt` 挑的，
   * **它不认识 `withdrawn`**。于是会出现：
   *   · 本端立了碑（`withdrawn` 有值）
   *   · 对端那份没碑
   *   · `winner` 挑了没碑的那份 → **碑被丢掉 → 撤回传不出去**
   *
   * 这个归一步做两件事：
   *   ① 两边只要有碑，就取**时间更晚**的那块（后撤的覆盖先撤的）
   *   ② 碑要盖过「更早的重新提议」：如果 `proposedAt` 晚于碑，说明是撤了又重提，
   *      **留碑但 `proposalState` 会判它 active**（见那里的时间比较）
   *
   * ⚠️ 实现上**先算的时候不能提前 return**，因为 `absorb` 的顺序会变
   * （先 mine 后 theirs），所以必须在**全部 absorb 完之后**统一处理。
   */
  for (const [id, p] of byId) {
    // 收集这条 id 上出现过的所有碑（mine 和 theirs 都算）
    let tomb = p.withdrawn ?? null
    for (const src of [mine, theirs]) {
      const other = src.find((x) => x.id === id)
      if (other === undefined) continue
      const w = other.withdrawn ?? null
      if (w === null) continue
      if (tomb === null || Date.parse(w.at) > Date.parse(tomb.at)) tomb = w
    }
    if (tomb !== null && p.withdrawn?.at !== tomb.at) {
      byId.set(id, { ...p, withdrawn: tomb })
    }
  }

  /**
   * 🔴 规范化：votes 的键必须排序（2026-10-23 抓到的真 bug）。
   *
   * ## 为什么必须做
   *
   * `votes` 是对象，`{ ...prev.votes, ...p.votes }` 的**键顺序取决于合并顺序**：
   *   · 我这边先 absorb 我的 → `{big-fish, small-fish}`
   *   · 她那边先 absorb 她的 → `{small-fish, big-fish}`
   *
   * 内容等价，但 `JSON.stringify` 出来的**字节不同 → sha256 不同**。
   * 后果：每次同步都认为 targets.json 变了，来回推一次。
   * 更糟的是「推过去 → 对端合并 → 顺序又变 → 再推」可能**永远不收敛**。
   *
   * 实测：同一个提案，我合并出 `{"big-fish":"yes","small-fish":"yes"}`，
   * 她合并出 `{"small-fish":"yes","big-fish":"yes"}`，长度都是 357 但字节不同。
   *
   * ## 修法
   *
   * 落盘前把 votes 重建一遍，键按字母序。这样**同样的内容永远产生同样的字节**，
   * 哈希稳定，同步一次就收敛。
   *
   * 注意：这个规范化只影响**落盘字节**，不影响语义
   * （`Object.keys().filter(v => v === 'yes')` 本来就不看顺序）。
   */
  return [...byId.values()]
    .map((p) => {
      const votes = {}
      for (const who of Object.keys(p.votes ?? {}).sort()) {
        votes[who] = p.votes[who]
      }
      return { ...p, votes }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 从提案清单算出**当前生效**的同步目标。
 *
 * @param {object[]} proposals - 合并后的提案。
 * @param {Date} [now] - 当前时间。
 * @returns {object[]} 生效目标（形状同 DEFAULT_TARGETS）。
 */
export function resolveActiveTargets(proposals, now = new Date()) {
  const out = []
  for (const p of proposals) {
    if (p.conflict === true) continue
    if (proposalState(p, now) !== 'active') continue
    out.push({
      id: p.id,
      rel: p.rel,
      mode: p.mode,
      days: p.days,
      label: p.label,
      /** 标记来源，日志与界面能看出来这是「提案来的」不是内置的。 */
      fromProposal: true,
      expiresAt: p.expiresAt,
    })
  }
  return out
}

/**
 * 给一条提案投票（幂等：已经投过就直接返回）。
 *
 * @param {object[]} proposals - 现有提案。
 * @param {string} id - 提案 id。
 * @param {string} who - 投票者身份（big-fish / small-fish）。
 * @returns {{proposals: object[], changed: boolean, error?: string}} 结果。
 */
export function castVote(proposals, id, who) {
  const idx = proposals.findIndex((p) => p.id === id)
  if (idx < 0) return { proposals, changed: false, error: `没有这个提案：${id}` }

  const p = proposals[idx]
  if (p.withdrawn != null) {
    return { proposals, changed: false, error: `提案 ${id} 已撤回，不能再投票` }
  }
  if (p.votes[who] === 'yes') {
    return { proposals, changed: false, error: `你已经投过 ${id} 了` }
  }

  const next = [...proposals]
  next[idx] = { ...p, votes: { ...p.votes, [who]: 'yes' } }
  return { proposals: next, changed: true }
}

/**
 * 撤回一条提案 —— **立碑，不是删除**（2026-10-24 加）。
 *
 * ## 为什么不是删除
 *
 * 合并是纯并集。删了本端那份，对端那份下次同步会把它带回来。
 * **删除不可传播，碑可以。**
 *
 * ## 谁能撤：**两端都能，单方面即可**
 *
 * 加目标要**两端都 yes**（主人 2026-10-23 定的：一个人不能自己扩边界）。
 * 但**撤目标的方向是相反的** —— 它让同步范围**变小**，不会让谁多暴露东西。
 * 所以收缩**单方面就该能做**，不该被对方卡住。
 *
 * （2026-10-24 实际踩到：小肥鱼想撤我提的两条，她做不到，只能写信求我。）
 *
 * ## 撤了还能不能恢复
 *
 * 能。**重新 `add` 同一个 id** —— 新的 `proposedAt` 晚于碑，
 * `proposalState` 就判它 active（碑还在，但被盖过了）。
 *
 * @param {object[]} proposals - 现有提案。
 * @param {string} id - 提案 id。
 * @param {string} who - 撤回者身份（big-fish / small-fish）。
 * @returns {{proposals: object[], changed: boolean, proposal?: object, error?: string}} 结果。
 */
export function withdrawProposal(proposals, id, who) {
  const idx = proposals.findIndex((p) => p.id === id)
  if (idx < 0) return { proposals, changed: false, error: `没有这个提案：${id}` }

  const p = proposals[idx]
  if (p.withdrawn != null) {
    return { proposals, changed: false, error: `提案 ${id} 已经撤回过（碑在 ${p.withdrawn.at}）` }
  }

  const next = [...proposals]
  next[idx] = { ...p, withdrawn: { by: who === 'small-fish' ? 'small-fish' : 'big-fish', at: new Date().toISOString() } }
  return { proposals: next, changed: true, proposal: next[idx] }
}

/**
 * 加一条提案（提出方自动投一票）。
 *
 * @param {object[]} proposals - 现有提案。
 * @param {object} raw - 原始提案（缺 proposedBy / proposedAt 会补）。
 * @param {string} who - 提出方身份。
 * @returns {{proposals: object[], proposal: object|null, error?: string}} 结果。
 */
export function addProposal(proposals, raw, who) {
  const normalized = normalizeProposal({
    ...raw,
    proposedBy: who,
    proposedAt: new Date().toISOString(),
  })
  if (normalized === null) {
    return {
      proposals,
      proposal: null,
      error: '提案不合法：id 只能是字母数字下划线、rel 必须落在允许的顶层目录里',
    }
  }
  if (proposals.some((p) => p.id === normalized.id)) {
    const existing = proposals.find((p) => p.id === normalized.id)
    /**
     * 已存在的 id：**如果它是墓碑，允许重新提议**（2026-10-24 加）。
     *
     * 为什么允许：撤回之后想恢复，不该被逼着换一个 id
     * （换 id 会让「同一条目标的历史」断掉）。
     *
     * 怎么算「盖过碑」：这里 `normalized.proposedAt` 是**现在**，
     * 一定晚于碑的时间；`proposalState` 里那句时间比较会让它重新 active。
     * 碑本身**不清掉** —— 留着才能在对端合并时比较时间。
     */
    if (existing !== undefined && existing.withdrawn != null) {
      /**
       * ⚠️ **碑要留着**（这条是被反向用例逼出来的 —— 2026-10-24）。
       *
       * 一开始写的是直接换成 `normalized`（全新的一条，`withdrawn: null`），
       * 结果测试里那条「早于碑的提议盖不过碑」挂了 —— 因为**碑已经被我弄丢了**。
       *
       * 端到端上其实也能收敛（对端那份还带着碑，合并时会被归一取回来），
       * 但**本端不该丢它**：碑是「这条曾经被撤过」的记录，
       * 丢了以后没法判断「早于碑的提议该不该算数」。
       *
       * 正确语义：**碑还在，只是被新的 `proposedAt` 盖过**（判 active 在 `proposalState` 里）。
       */
      const revived = { ...normalized, withdrawn: existing.withdrawn }
      const next = proposals.map((p) => (p.id === normalized.id ? revived : p))
      return { proposals: next, proposal: revived }
    }
    return { proposals, proposal: null, error: `提案 ${normalized.id} 已存在` }
  }
  return { proposals: [...proposals, normalized], proposal: normalized }
}
