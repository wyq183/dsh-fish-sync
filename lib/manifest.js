/**
 * manifest —— 把「要同步什么」算成一张带 sha256 的清单。
 *
 * 设计要点：
 *  · **清单是同步的唯一真相**。两端各自算清单，比对清单决定传什么，
 *    而不是靠「时间戳变了就传」（时间戳会被 cp / 解压 / 换时区搞乱）。
 *  · 内容哈希用 sha256，**不是 mtime**。mtime 只用来判「谁后改的」，不判「一样不一样」。
 *  · 单文件读取有大小上限，防止把大文件读进内存。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MAX_FILE_BYTES, normalizeRelPath } from './identity.js'
import { ALLOWED_ROOTS, DENY_PATTERNS, isUserExcluded } from './targets.js'

/**
 * 插件自己拥有、**永远可同步**的文件（不需要走提案投票）。
 *
 * ## 为什么需要这个例外
 *
 * 唤醒机制（2026-10-25 加）要通知对方「有新信了」。
 * 如果连这个信标都要先提提案、等对方投票才生效，
 * 那就成了「你想通知我，得先让我批准你通知我」—— 荒谬。
 *
 * ## 为什么只列文件名，不做前缀匹配
 *
 * `fish-sync/` 这个目录里有 `paired.json`（**长期密钥**）。
 * 用前缀匹配 = 给「读任意 fish-sync 下文件」开了口子。
 * 所以这里**逐个列出**允许的文件名，多一个都不放。
 *
 * @type {readonly string[]}
 */
export const PLUGIN_OWNED_FILES = [
  'fish-sync/targets.json', // 提案与投票（本来就同步，这里显式列出）
  // ⚠️ 只放 outbox，**不放 state**（2026-10-25 改）。
  //
  // 原来的 `wakeup.json` 把 outbox 和本机游标（lastSeenAt / lastWakeAt）放一起，
  // 而它是双向同步的 → 两端互相覆盖对方的游标 →
  // 「同步完成 → 读到旧游标 → 判定有新消息 → 唤醒 → 再同步 → 又退回」的死循环。
  // 小肥鱼 14:12~14:14 实测连着被叫醒四次。
  //
  // 拆开之后：
  //   wakeup-outbox.json            参与同步（消息队列，两端并集）
  //   wakeup-state-<identity>.json  不参与同步（本机游标）
  'fish-sync/wakeup-outbox.json',
]

/**
 * 算一个 Buffer 的 sha256（hex）。
 * @param {Buffer} buf - 内容。
 * @returns {string} hex 摘要。
 */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 把一个绝对路径转成「相对 dsh home 的、用 / 分隔」的键。
 * 同步清单里所有键都用这个形式，两端才对得上。
 * @param {string} home - dsh home 绝对路径。
 * @param {string} abs - 绝对路径。
 * @returns {string} 相对键。
 */
export function toKey(home, abs) {
  return relative(home, abs).split(sep).join('/')
}

/**
 * 列出某个目标下所有应同步的文件（绝对路径 + 键）。
 *
 * @param {string} home - dsh home。
 * @param {object} target - 目标定义（见 identity.js DEFAULT_TARGETS）。
 * @param {Date} now - 当前时间，用于 dir-recent 的日期裁剪。
 * @returns {Promise<Array<{key: string, abs: string}>>} 文件列表。
 */
export async function listTargetFiles(home, target, now) {
  const abs = join(home, target.rel)

  if (target.mode === 'file') {
    try {
      const st = await stat(abs)
      if (!st.isFile()) return []
      return [{ key: toKey(home, abs), abs }]
    } catch {
      return [] // 不存在 = 空清单，不是错误
    }
  }

  if (target.mode === 'dir-recent') {
    let names
    try {
      names = await readdir(abs)
    } catch {
      return []
    }
    // 只要最近 N 天的 `YYYY-MM-DD.md`
    const days = Number.isFinite(Number(target.days)) ? Number(target.days) : 3
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
    const out = []
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      const dayKey = name.slice(0, 10)
      if (dayKey < cutoffKey) continue
      const fileAbs = join(abs, name)
      out.push({ key: toKey(home, fileAbs), abs: fileAbs })
    }
    return out
  }

  /**
   * `dir` —— 目录下**所有文件**，不看文件名，**递归**。
   *
   * 2026-10-26 加。治的病见 `targets.js` 里 `normalizeProposal` 的注释：
   * `dir-recent` 只收日期文件名，`视频模板.md` 这种永远进不了清单。
   *
   * ## ⚠️ 这个分支有两版实现，现在用的是第二版（小肥鱼的）
   *
   * **第一版（我的）**：只扫一层，不递归。
   *   `ent.isFile()` 判断 —— 但 `Dirent.isFile()` 对符号链接返回 **false**，
   *   所以软链是被「顺带」挡住的，不是「有意」挡的。
   *   ⚠️ 那是运气，不是设计。
   *
   * **第二版（她的，2026-10-26 10:54 提出，我采纳）**：
   *   · **递归**，深度上限 `MAX_DIR_DEPTH = 8`
   *   · **`lstat` 判，符号链接一律跳过** —— 有意挡，不是顺带
   *   · 跳过点开头的（`.git` / `.hidden.md`）
   *
   * **为什么采纳她的**：我那个「只一层」是为了省事，不是因为它对。
   *   万一以后要同步带子目录的目录，我那个直接废。
   *   而软链防护是**安全边界**，不能靠 `isFile()` 的副作用。
   *
   * ## 边界（一条都没放松）
   *
   *  · 跳过 `DENY_PATTERNS` 命中的（`paired.json` 密钥 / `.bak` / `.history` / `node_modules`）
   *  · 跳过符号链接（**`lstat` 判，不跟**）—— 否则一条软链指到 `/etc` 就逃出白名单
   *  · 跳过点开头的
   *  · 深度上限 8 层 —— 防环形目录把扫描拖死
   *  · **不接受 `days`**（见 `targets.js`：提案是两端共享的语义契约）
   */
  if (target.mode === 'dir') {
    return await listDirRecursive(home, abs, 0)
  }

  return []
}

/** `dir` 模式的递归深度上限。 */
const MAX_DIR_DEPTH = 8

/**
 * 递归列一个目录下的文件（`dir` 模式用）。
 *
 * @param {string} home - dsh home（用来算相对 key）。
 * @param {string} abs - 要扫的目录绝对路径。
 * @param {number} depth - 当前深度（0 = 起点）。
 * @returns {Promise<Array<{key: string, abs: string}>>} 文件条目。
 */
async function listDirRecursive(home, abs, depth) {
  if (depth > MAX_DIR_DEPTH) return []

  let entries
  try {
    // ⚠️ withFileTypes 给的 Dirent 对软链是「链接本身」，不是目标 ——
    //    但我们仍然显式 lstat 一次：`Dirent.isSymbolicLink()` 在部分
    //    平台/文件系统上不可靠，而软链是安全边界，不能靠「大概」。
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return [] // 读不了 = 空清单，不是错误（跟 dir-recent 一致）
  }

  const out = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue // 隐藏文件 / 目录

    const fileAbs = join(abs, ent.name)

    // 软链：先按 Dirent 挡一层，再按 lstat 挡一层（双保险）
    if (ent.isSymbolicLink()) continue

    let st
    try {
      st = await lstat(fileAbs)
    } catch {
      continue // 断链 / 权限不足 —— 跳过，不抛
    }
    if (st.isSymbolicLink()) continue // lstat 再确认一次

    if (st.isDirectory()) {
      const sub = await listDirRecursive(home, fileAbs, depth + 1)
      for (const s of sub) out.push(s)
      continue
    }

    if (!st.isFile()) continue // 设备文件 / FIFO / socket 一律不收

    const key = toKey(home, fileAbs)
    if (isDeniedKey(key)) continue
    out.push({ key, abs: fileAbs })
  }
  return out
}

/**
 * 读一个文件并算出它的清单条目。
 *
 * @param {string} home - dsh home。
 * @param {{key: string, abs: string}} entry - 文件条目。
 * @returns {Promise<object|null>} 清单项，或 null（读不了 / 太大）。
 */
export async function describeFile(home, entry) {
  try {
    const st = await stat(entry.abs)
    if (!st.isFile()) return null
    if (st.size > MAX_FILE_BYTES) {
      return { key: entry.key, size: st.size, mtimeMs: st.mtimeMs, sha256: null, skipped: 'too-large' }
    }
    const buf = await readFile(entry.abs)
    return {
      key: entry.key,
      size: buf.length,
      mtimeMs: Math.round(st.mtimeMs),
      sha256: sha256(buf),
    }
  } catch {
    return null
  }
}

/**
 * 生成本端的完整清单。
 *
 * @param {object} cfg - 已归一化的配置。
 * @param {Date} [now] - 当前时间（测试可注入）。
 * @returns {Promise<{identity: string, label: string, generatedAt: string, files: Array<object>}>} 清单。
 */
export async function buildManifest(cfg, now = new Date()) {
  const files = []
  const seen = new Set()

  for (const target of cfg.targets) {
    const entries = await listTargetFiles(cfg.home, target, now)
    for (const entry of entries) {
      if (seen.has(entry.key)) continue
      seen.add(entry.key)
      const desc = await describeFile(cfg.home, entry)
      if (desc !== null) files.push({ ...desc, target: target.id })
    }
  }

  // ── 插件自己拥有的文件（2026-10-25 加）──────────────────────
  //
  // ⚠️ 这一步不能省。上面那个循环**只遍历 targets**，
  //    而 `fish-sync/wakeup.json` 不在任何 target 里（它不该走提案投票），
  //    所以只在 `resolveAllowedKey` 里放行是**不够的** ——
  //    那样只让 HTTP 能读写它，**它永远进不了清单，也就永远同步不出去**。
  //
  //    实测：2026-10-25 更新完两端，`fish_sync_notify` 报「已同步过去」，
  //    但对端 GET 返 404 —— 因为清单里根本没有这个 key。
  //
  //    教训：**「能读写」和「在清单里」是两件事。** 同步靠的是清单。
  for (const key of PLUGIN_OWNED_FILES) {
    if (seen.has(key)) continue
    if (isDeniedKey(key)) continue
    const abs = join(cfg.home, ...key.split('/'))
    const st = await statSafe(abs)
    if (st === null) continue
    seen.add(key)
    const desc = await describeFile(cfg.home, { key, abs, stat: st })
    if (desc !== null) files.push({ ...desc, target: 'plugin-owned' })
  }

  files.sort((a, b) => a.key.localeCompare(b.key))

  return {
    identity: cfg.identity,
    label: cfg.label,
    generatedAt: now.toISOString(),
    files,
  }
}

/**
 * `stat` 的容错版：文件不存在返 null，不抛。
 *
 * @param {string} abs - 绝对路径。
 * @returns {Promise<object | null>}
 */
async function statSafe(abs) {
  try {
    return await stat(abs)
  } catch {
    return null
  }
}

/**
 * 把本端清单整理成 Map，方便按 key 查。
 * @param {object} manifest - buildManifest 的产物。
 * @returns {Map<string, object>} key → 清单项。
 */
export function indexManifest(manifest) {
  const map = new Map()
  for (const f of manifest?.files ?? []) {
    if (typeof f?.key === 'string') map.set(f.key, f)
  }
  return map
}

/**
 * 校验一个键是否在允许同步的范围内（白名单校验，不是黑名单）。
 *
 * 服务端**必须**在每次读/写文件前调用它 —— 否则对端可以传任意路径过来。
 *
 * 2026-10-23 加了两道闸（因为目标现在可以由 `targets.json` 动态扩展了）：
 *
 *   ① **明确拒绝**（`DENY_PATTERNS`）—— 最高优先级。
 *      尤其 `fish-sync/paired.json` 里是**长期密钥**，同步它 = 把钥匙贴到局域网上。
 *      这条必须在最前面，不能靠「目标里没配它」来兜底 —— 万一有人配了呢。
 *
 *   ② **顶层目录白名单**（`ALLOWED_ROOTS`）—— 提案只能落在这些根目录下。
 *      防的是「提案里写了个绝对路径 / 系统目录」这种。
 *
 * 为什么「顶层白名单」不能省：目标现在来自网络上的 JSON，
 * 而这份 JSON 的语义就是「允许传哪些路径」。**它自己就是攻击面。**
 *
 * @param {object} cfg - 配置。
 * @param {string} rawKey - 请求里的路径。
 * @param {Date} [now] - 当前时间。
 * @returns {Promise<string|null>} 规范化后的键，或 null = 不在范围内。
 */
export async function resolveAllowedKey(cfg, rawKey, now = new Date()) {
  const key = normalizeRelPath(rawKey)
  if (key === null) return null

  // ── ① 明确拒绝（最高优先级）──────────────────────────────
  if (isDeniedKey(key)) return null

  // ── ② 顶层目录白名单 ──────────────────────────────────────
  const root = key.split('/')[0]
  if (!ALLOWED_ROOTS.includes(root)) return null

  // ── ②b 插件自身的固定放行文件（不需要提案，永远可同步）──
  // 这些是「两端协作的元数据」，不是用户内容 —— 让它们走提案流程会很别扭
  // （比如唤醒信标：你没法先投个票才能通知对方有新信）。
  // ⚠️ 只放行明确列出的文件名，**不做前缀匹配**，避免开成任意读写的口子。
  if (PLUGIN_OWNED_FILES.includes(key)) return key

  // ── ③ 必须落在某个已配置目标的范围内 ──────────────────────
  for (const target of cfg.targets) {
    const rel = target.rel.replaceAll('\\', '/')
    if (target.mode === 'file') {
      if (key === rel) return key
      continue
    }
    if (target.mode === 'dir-recent') {
      if (!key.startsWith(`${rel}/`)) continue
      const tail = key.slice(rel.length + 1)
      // 只允许一层：memory/YYYY-MM-DD.md
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(tail)) continue
      return key
    }
    /**
     * `dir` —— 目录下任意文件名，**允许子目录**（跟清单那边一致）。
     *
     * ## ⚠️ 这里为什么从「只一层」改成了「允许子树」
     *
     * 第一版我写的是「只要一层」，理由是「一条提案不该变成一棵子树」。
     *
     * **小肥鱼 2026-10-26 10:54 指出清单那边是递归的 —— 两边口径不一致。**
     * 口径不一致的后果很具体：
     *   · 清单里有 `知识库/写作/代码交换/dir实现.md`（递归扫到的）
     *   · 但 `resolveAllowedKey` 拒它（不是一层）→ 推送 403
     *   · 于是「清单说有、传不过去」—— **又一个「看起来正常」**
     *
     * 而且「一条提案不该变成一棵子树」这个担心是**错的**：
     * 提案里的 `rel` 本来就限定了一棵子树的根，`ALLOWED_ROOTS` 又挡了顶层。
     * 子树不是「边界不清」，子树就是「我让你看这个目录」。
     *
     * ## 仍然守住的边界（一条都没放松）
     *
     *  · 必须在 `rel/` 下面（`startsWith` 已经挡了 `rel-xxx` 这种前缀攻击）
     *  · 路径里**任何一段**都不能是 `.` 开头（挡 `.git` / `.hidden` / `..`）
     *  · `normalizeRelPath` 在函数开头已经挡了 `..` 和绝对路径
     *  · `DENY_PATTERNS` 在最上面挡了 `paired.json` / `.bak` / `node_modules`
     *  · 段数上限跟清单的 `MAX_DIR_DEPTH` 对齐 —— 否则清单能列、鉴权拒
     */
    if (target.mode === 'dir') {
      if (!key.startsWith(`${rel}/`)) continue
      const tail = key.slice(rel.length + 1)
      if (tail === '') continue // 目录本身不是文件
      const segs = tail.split('/')
      if (segs.length > MAX_DIR_DEPTH + 1) continue // 跟清单深度对齐
      if (segs.some((s) => s === '' || s.startsWith('.'))) continue // 隐藏段 / 空段
      return key
    }
  }
  return null
}

/**
 * 判断一个规范化后的键是否被明确拒绝。
 *
 * 导出是为了让测试能直接验（不用每次造一整套 cfg）。
 *
 * ## 两类拒绝（2026-10-26 分开）
 *
 * ① **安全边界**（`DENY_PATTERNS`）—— 密钥 / 备份 / 依赖 / 历史快照。
 *    不管谁说都该挡，删了就是漏洞。
 *
 * ② **主人偏好**（`USER_EXCLUDED`）—— 主人明确说「这份不要同步」的。
 *    技术上能传，只是他不想要。
 *
 * **⚠️ 两类在这里合并成一个返回值（都是 true），但来源不同。**
 * **为什么还要分：** 以后看到的人要知道「能不能删」——
 * 删 ① 是制造漏洞，删 ② 只是恢复同步。
 *
 * @param {string} key - 规范化后的相对键。
 * @returns {boolean} true = 拒绝。
 */
export function isDeniedKey(key) {
  for (const re of DENY_PATTERNS) {
    if (re.test(key)) return true
  }
  // ⚠️ 精确匹配，不是正则 —— 见 targets.js 的 USER_EXCLUDED 注释
  if (isUserExcluded(key)) return true
  return false
}
