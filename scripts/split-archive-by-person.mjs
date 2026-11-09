#!/usr/bin/env node
/**
 * 一次性迁移 —— 把「混在一起」的旧归档拆成按人分目录。
 *
 * ## 背景（2026-10-25）
 *
 * 第一版归档把两个来源混在一个文件里：
 *
 * ```
 * 知识库/信箱存档/2026-10-24.md
 *   <!-- 来自 大肥鱼.md -->  ← 我写的
 *   ... 21 块
 *   <!-- 来自 小肥鱼.md -->  ← 她写的
 *   ... 18 块
 * ```
 *
 * 主人指出：
 * > 「还有还给小肥鱼她的信箱备份，你全存电脑端了」
 *
 * **她的信凭什么存在我这边？** 而且更要命的是：
 * 我瘦身之后同步会把瘦身版推给她 → **她的原文被她那边的瘦身版覆盖了**
 * （实测 205.7 KB → 137.2 KB）。要不是归档里还有全量，那些信就真没了。
 *
 * 这个脚本把旧混合归档拆成：
 *
 * ```
 * 知识库/信箱存档/大肥鱼/YYYY-MM-DD.md
 * 知识库/信箱存档/小肥鱼/YYYY-MM-DD.md
 * ```
 *
 * **只读旧文件、只写新目录 —— 不删旧文件。** 旧文件留着当保险，
 * 确认新目录完整后再手动删。
 *
 * 跑：
 *   node scripts/split-archive-by-person.mjs            # 预演
 *   node scripts/split-archive-by-person.mjs --apply    # 真写
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const ROOT_REL = '知识库/信箱存档'

/** 来源标记 → 目标子目录。 */
const SOURCE_MAP = {
  '大肥鱼.md': '大肥鱼',
  '小肥鱼.md': '小肥鱼',
}

/**
 * 把一个混合归档文件的正文，按来源拆开。
 *
 * 格式是：
 * ```
 * <!-- 来自 大肥鱼.md -->
 * ## 标题…
 * 正文…
 * <!-- 来自 小肥鱼.md -->
 * # 标题…
 * 正文…
 * ```
 *
 * @param {string} text - 文件全文（含表头）。
 * @returns {{ preamble: string, bySource: Map<string, string[]> }}
 */
function splitBySource(text) {
  const lines = text.split('\n')
  /** @type {Map<string, string[]>} */
  const bySource = new Map()
  /** 表头（第一个来源标记之前）。 */
  let preambleEnd = lines.length
  let current = null

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^<!-- 来自 (.+?) -->$/)
    if (m) {
      if (current === null) preambleEnd = i
      current = m[1]
      if (!bySource.has(current)) bySource.set(current, [])
      // 来源标记本身不写进新文件（新文件表头会说明）
      continue
    }
    if (current !== null) {
      bySource.get(current).push(lines[i])
    }
  }

  return { preamble: lines.slice(0, preambleEnd).join('\n'), bySource }
}

async function main(apply) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const root = path.join(home, ROOT_REL)

  console.log(`\n=== 拆分归档 ${apply ? '（真写）' : '（预演）'} ===`)
  console.log(`  目录: ${ROOT_REL}/`)
  console.log('')

  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    console.log('  ⚠️  归档目录不存在')
    return
  }

  // 只处理根目录下的 .md（子目录里的已经是拆好的）
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
  if (files.length === 0) {
    console.log('  根目录没有混合归档文件（可能已经拆过了）')
    return
  }

  /** @type {Map<string, Map<string, string[]>>} 子目录 → 日期 → 行 */
  const plan = new Map()
  let totalBig = 0
  let totalSmall = 0

  for (const name of files.sort()) {
    const date = name.replace(/\.md$/, '')
    const text = await fs.readFile(path.join(root, name), 'utf8')
    const { bySource } = splitBySource(text)

    for (const [src, lines] of bySource) {
      const sub = SOURCE_MAP[src]
      if (!sub) {
        console.log(`  ⚠️  ${name}: 不认识的来源「${src}」，跳过（原样留着）`)
        continue
      }
      if (!plan.has(sub)) plan.set(sub, new Map())
      plan.get(sub).set(date, lines)
      if (sub === '大肥鱼') totalBig += 1
      else totalSmall += 1
    }
  }

  console.log('  拆分计划：')
  for (const [sub, byDate] of [...plan].sort()) {
    console.log(`    ${sub}/`)
    for (const [date, lines] of [...byDate].sort()) {
      const kb = (Buffer.byteLength(lines.join('\n'), 'utf8') / 1024).toFixed(1)
      console.log(`      ${date}.md  ${kb} KB  ${lines.length} 行`)
    }
  }
  console.log('')
  console.log(`  合计：大肥鱼 ${totalBig} 个文件 / 小肥鱼 ${totalSmall} 个文件`)

  if (!apply) {
    console.log('')
    console.log('  这是预演。要真写加 --apply')
    return
  }

  for (const [sub, byDate] of [...plan].sort()) {
    const dir = path.join(root, sub)
    await fs.mkdir(dir, { recursive: true })
    for (const [date, lines] of [...byDate].sort()) {
      const header = [
        `# ${sub} · 信箱存档 · ${date}`,
        '',
        '> 从 `yiqishard/信箱/` 归档过来的。**原文一字未改。**',
        '> 归档规则见 `projects/dsh-fish-sync/scripts/archive-letters.mjs`。',
        '',
        '---',
        '',
      ].join('\n')
      const target = path.join(dir, `${date}.md`)
      await fs.writeFile(target, header + lines.join('\n') + '\n', 'utf8')
      console.log(`  ✅ ${ROOT_REL}/${sub}/${date}.md`)
    }
  }

  console.log('')
  console.log('  ⚠️ 旧的混合文件没删（留着当保险）。确认新目录完整后再手动删。')
}

const apply = process.argv.includes('--apply')
await main(apply)
