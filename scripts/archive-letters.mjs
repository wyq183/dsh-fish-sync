#!/usr/bin/env node
/**
 * 信箱归档 —— 把「今天之前」的信切到知识库里，信箱只留今天的。
 *
 * ## 为什么要有这个
 *
 * 2026-10-25 主人原话：
 * > 「信的内容每天更新存档到知识库，免得太多内容爆炸了，
 * >  也留着可以需要的时候找，小肥鱼也要」
 *
 * 实况：两个信箱都到了 200+ KB / 5000+ 行。
 * 每次读信都要整个读进来，token 和注意力都被老信吃掉。
 *
 * ## ⚠️ 不套 40 KB 红线（2026-10-25 主人明确否了）
 *
 * > 「这个互通的是你们自己的不要设置40，按天来」
 *
 * 40 KB 是给 `MEMORY.md` / 两志那种**长期档案**定的 —— 它们要一直保持可读。
 * 信箱不是档案，是**流水**：一天一批，过了那天就该走。
 * 所以规则只有一条：**信箱只留今天的，其余按天进归档。**
 * 今天写了 200 KB 也没关系 —— 那是今天真实说的话。
 *
 * ## 🔴 按人分目录（2026-10-25 主人指出后改）
 *
 * > 「还有还给小肥鱼她的信箱备份，你全存电脑端了」
 *
 * **第一版把两个来源混在一个文件里**（`信箱存档/2026-10-24.md` 里既有我写的
 * 也有她写的）。这有两个问题：
 *
 * ① **她的信凭什么存在我这边？** 备份应该各管各的。
 * ② 我做了瘦身之后同步会把瘦身版推给她 → **她的原文在我这边被覆盖了**
 *    （实测：她那边从 205.7 KB 变成 137.2 KB，历史块丢了）。
 *    要不是归档里还有全量，那些信就真没了。
 *
 * 现在改成：
 *
 * ```
 * 知识库/信箱存档/大肥鱼/YYYY-MM-DD.md   ← 我写的信（我管）
 * 知识库/信箱存档/小肥鱼/YYYY-MM-DD.md   ← 她写的信（她自己管，我只负责给她）
 * ```
 *
 * `--who` 决定这次归档谁的信。默认 `big-fish`（本端只归自己的）。
 * 要帮她恢复历史，用 `--who=small-fish --apply` 生成她那套，然后同步过去。
 *
 * ## 怎么切
 *
 * **按信的标题里的日期切，不按行号。**
 *
 * 两个信箱的标题格式不一样（大肥鱼用 `## … · MM-DD HH:MM · …`，
 * 小肥鱼混用 `### HH:MM · …` / `# [YYYY-MM-DD …` / `# YYYY-MM-DD …`），
 * 所以**不能用一个正则通吃**。这个脚本给每种格式单独一条规则，
 * 认不出的行**原样留在当前块里**（宁可多留，不许丢）。
 *
 * ## 安全
 *
 * · 默认只预演，`--apply` 才真写
 * · 写之前先备份原文件到 `信箱/.bak-before-archive-<时间戳>/`
 * · **备份失败就中止**（不许在没有备份的情况下改信箱）
 * · 只切「今天之前」的，今天的信一条都不动
 *
 * 跑：
 *   node scripts/archive-letters.mjs                        # 预演自己的
 *   node scripts/archive-letters.mjs --apply                # 真写自己的
 *   node scripts/archive-letters.mjs --who=small-fish       # 预演她的
 *   node scripts/archive-letters.mjs --who=small-fish --apply
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 归档根目录（相对 dsh home）。 */
const ARCHIVE_ROOT_REL = '知识库/信箱存档'

/** 信箱目录（相对 dsh home）。 */
const LETTERS_REL = 'yiqishard/信箱'

/** 身份 → 信箱文件名。 */
const BOX_BY_WHO = {
  'big-fish': '大肥鱼.md',
  'small-fish': '小肥鱼.md',
}

/** 身份 → 归档子目录名。 */
const DIR_BY_WHO = {
  'big-fish': '大肥鱼',
  'small-fish': '小肥鱼',
}

/**
 * 从一行标题里抠日期，返回 `YYYY-MM-DD` 或 null。
 *
 * 四种格式（实测统计过）：
 *   ① `## 🎯 给小肥鱼 · 10-25 17:50 · …`        ← 大肥鱼主力格式
 *   ② `### 19:25 · …`                            ← 小肥鱼早期，没日期
 *   ③ `# [2026-10-24 19:26] 小肥鱼 → 大肥鱼：…`  ← 小肥鱼带方括号
 *   ④ `# 2026-10-24 19:31 小肥鱼 → 大肥鱼`       ← 小肥鱼不带括号
 *
 * ② 没有日期 → 返回 null（跟着上一块走）。
 *
 * @param {string} line - 一行文本。
 * @param {string} defaultYear - 缺年份时用（`2026`）。
 * @returns {string|null} `YYYY-MM-DD`。
 */
function dateOfHeading(line, defaultYear) {
  if (!/^#{1,3} /.test(line)) return null

  // ④ / ③：带完整年月日
  let m = line.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`

  // ①：`· MM-DD HH:MM ·`
  m = line.match(/·\s*(\d{2})-(\d{2})\s+\d{2}:\d{2}\s*·/)
  if (m) return `${defaultYear}-${m[1]}-${m[2]}`

  // ②：只有 HH:MM，没日期
  return null
}

/**
 * 把一个信箱文件切成「按日期分块」。
 *
 * @param {string} text - 文件全文。
 * @param {string} defaultYear - 缺年份时用。
 * @returns {{ preamble: string, blocks: Array<{date: string|null, lines: string[]}> }}
 */
function splitByDate(text, defaultYear) {
  const lines = text.split('\n')
  /** 头部：第一个「带日期的标题」之前的所有内容。 */
  let preambleEnd = lines.length
  /** @type {Array<{date: string|null, lines: string[]}>} */
  const blocks = []

  /** 当前块（null = 还在 preamble 里）。 */
  let current = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const d = dateOfHeading(line, defaultYear)

    if (d !== null) {
      // 遇到「带日期的标题」→ 开新块
      if (current === null) preambleEnd = i
      else blocks.push(current)
      current = { date: d, lines: [line] }
    } else if (current !== null) {
      current.lines.push(line)
    }
    // 还在 preamble 里且不是日期标题 → 什么都不做（留着）
  }
  if (current !== null) blocks.push(current)

  return {
    preamble: lines.slice(0, preambleEnd).join('\n'),
    blocks,
  }
}

/**
 * 主流程。
 *
 * @param {boolean} apply - 是否真写盘。
 * @param {string} who - 归档谁的信（`big-fish` / `small-fish`）。
 */
async function main(apply, who) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const lettersDir = path.join(home, LETTERS_REL)
  const subDir = DIR_BY_WHO[who] ?? who
  const archiveDir = path.join(home, ARCHIVE_ROOT_REL, subDir)
  const boxFile = BOX_BY_WHO[who]
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const year = String(today.getFullYear())

  console.log(`\n=== 信箱归档 ${apply ? '（真写）' : '（预演）'} ===`)
  console.log(`  home:     ${home}`)
  console.log(`  归档谁:   ${who}（${boxFile}）`)
  console.log(`  今天:     ${todayKey}`)
  console.log(`  归档到:   ${ARCHIVE_ROOT_REL}/${subDir}/`)
  console.log('')

  const abs = path.join(lettersDir, boxFile)
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch {
    console.log(`  ⚠️  读不到 ${boxFile}`)
    return
  }

  const { preamble, blocks } = splitByDate(text, year)
  const keep = []
  /** @type {Map<string, string[]>} */
  const byDate = new Map()

  for (const block of blocks) {
    const isToday = block.date === todayKey
    const isFuture = block.date > todayKey
    if (isToday || isFuture) {
      keep.push(block.lines.join('\n'))
      continue
    }
    const bucket = byDate.get(block.date) ?? []
    bucket.push(...block.lines)
    byDate.set(block.date, bucket)
  }

  const keptBody = keep.join('\n')
  const keptKB = (Buffer.byteLength(keptBody, 'utf8') / 1024).toFixed(1)
  const keptLines = keptBody.split('\n').length

  console.log(`  ${boxFile}`)
  console.log(`    总块数: ${blocks.length}  归档: ${blocks.length - keep.length}  保留: ${keep.length}`)
  console.log(`    归档后预计: ${keptKB} KB / ${keptLines} 行`)
  console.log('')
  console.log(`  按日期汇总（要写进 ${ARCHIVE_ROOT_REL}/${subDir}/）：`)

  const dates = [...byDate.keys()].sort()
  for (const d of dates) {
    const lines = byDate.get(d)
    const kb = (Buffer.byteLength(lines.join('\n'), 'utf8') / 1024).toFixed(1)
    console.log(`    ${d}.md  ${kb} KB  ${lines.length} 行`)
  }

  if (!apply) {
    console.log('')
    console.log('  这是预演。要真写加 --apply')
    return
  }

  // ── 真写 ────────────────────────────────────────────────────
  //
  // ⚠️ 时间戳**不能带末尾的点**（2026-10-25 踩到）：
  //    原来用 `new Date().toISOString().replace(/[-:T]/g,'').slice(0,15)`，
  //    ISO 串是 `2026-10-25T10:04:17.123Z` → 去掉 `-` `:` `T` 之后是
  //    `20261025100417.123Z`，slice(0,15) 正好切在 `.` 上 →
  //    目录名变成 `.bak-before-archive-20261025100417.`。
  //    **Windows 会把目录名末尾的点去掉**，于是 mkdir 建的是没点的那个，
  //    copyFile 写的是有点的那个 → 静默失败（被 catch 吞了）→ 备份目录是空的。
  //
  //    修法：只取数字，不取任何标点。
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const bakDir = path.join(lettersDir, `.bak-before-archive-${ts}`)
  await fs.mkdir(bakDir, { recursive: true })

  let backedUp = 0
  try {
    await fs.copyFile(abs, path.join(bakDir, boxFile))
    backedUp += 1
  } catch (error) {
    // ⚠️ 不许静默吞（这正是上面那个 bug 的成因）
    console.log(`  ⚠️  备份 ${boxFile} 失败：${error?.message ?? error}`)
  }
  // 备份是「真写」的前置条件 —— 没备成就别往下走
  if (backedUp === 0) {
    console.log('\n  ❌ 备份失败，已中止（不许在没有备份的情况下改信箱）')
    process.exit(1)
  }
  console.log(`\n  ✅ 已备份原文件到 ${path.relative(home, bakDir)}/`)

  // 写归档文件（每个日期一个文件）
  await fs.mkdir(archiveDir, { recursive: true })
  for (const d of dates) {
    const target = path.join(archiveDir, `${d}.md`)
    const header = [
      `# ${subDir} · 信箱存档 · ${d}`,
      '',
      `> 从 \`yiqishard/信箱/${boxFile}\` 归档过来的。**原文一字未改。**`,
      '> 归档规则见 `projects/dsh-fish-sync/scripts/archive-letters.mjs`。',
      '',
      '---',
      '',
    ].join('\n')
    await fs.writeFile(target, header + byDate.get(d).join('\n') + '\n', 'utf8')
    console.log(`  ✅ ${ARCHIVE_ROOT_REL}/${subDir}/${d}.md`)
  }

  // 重写信箱（只留今天的）
  const body = [preamble.trimEnd(), '', '---', '', keptBody, ''].join('\n')
  await fs.writeFile(abs, body, 'utf8')
  const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)
  console.log(`  ✅ ${boxFile} 瘦身到 ${kb} KB`)
}

// ── 命令行 ──────────────────────────────────────────────────
const apply = process.argv.includes('--apply')
const whoArg = process.argv.find((a) => a.startsWith('--who='))
const who = whoArg ? whoArg.slice('--who='.length) : 'big-fish'

if (!BOX_BY_WHO[who]) {
  console.log(`❌ 不认识的 --who=${who}，只支持 ${Object.keys(BOX_BY_WHO).join(' / ')}`)
  process.exit(1)
}

await main(apply, who)
