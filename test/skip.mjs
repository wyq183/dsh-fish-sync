/**
 * 「跳过 N 个（内容相同）」这句话会撒谎 —— 2026-10-26 小肥鱼查出，我实测复现并修。
 *
 * ## 这个 bug 长什么样
 *
 * `lib/sync.js` 四处 `report.skipped += 1`，最后统一输出「跳过 N 个（内容相同）」。
 * **但四处里只有一处是真的「内容相同」：**
 *
 * | 行 | 条件 | 真实含义 | 是「内容相同」吗 |
 * |---|---|---|---|
 * | L298 | 对端有、本端没有、`theirs.sha256 === null` | 对端文件太大，没拉 | ❌ |
 * | L330 | 对端有、本端没有、本端不认路径 | 本端拒绝 | ❌ |
 * | L344 | 本端有、对端没有、`mine.sha256 === null` | 本端太大，没推 | ❌ |
 * | L356 | 两边都有、sha256 相等 | 真的相同 | ✅ |
 *
 * ## 实测（修之前，我亲手跑的）
 *
 * ```
 * 往 知识库/主人/ 放一个 9MB 文件（上限 8MB）
 *   放之前  跳过 81
 *   放之后  跳过 82      ← +1
 *   推送 0 · 拉取 0
 * 对端 manifest：81 个，没有那个文件
 * ```
 * **一个「对端根本没有」的文件，被报成了「内容相同」。**
 *
 * ## 这个测试在守什么
 *
 * ① `noteSkip` 三分类各记各的（不能混）
 * ② 总数 `skipped` 仍然等于三者之和（老调用方读它还得出对）
 * ③ `skippedDetail` 里每条都带 reason（能按文件列出来）
 * ④ ⚠️ 两边都超限（`null === null`）不许判成 `same`
 *
 * ## ⚠️ 为什么不依赖真实目录
 *
 * 判据集第 3 条：**测试不许依赖外部 fixture。每次跑，自己造、自己删。**
 *
 * 第一版我用了真实 `~/.dsh/知识库/主人/` —— 结果目录里有个 9MB 残留文件，
 * 第一阶段就多出一个 `too-large`，三条断言全挂。
 * **那不是代码错，是测试在依赖一个会变的世界。**
 *
 * 现在用临时目录，跑完自己删。
 *
 * 跑：node test/skip.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncOnce } from '../lib/sync.js'
import { buildManifest } from '../lib/manifest.js'

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass += 1
    process.stdout.write(`  ✅ ${name}\n`)
  } catch (error) {
    fail += 1
    failures.push({ name, error })
    process.stdout.write(`  ❌ ${name}\n     ${String(error?.message ?? error).split('\n')[0]}\n`)
  }
}

// ── 造一个临时 home，跑完删 ──────────────────────────────
const HOME = await mkdtemp(join(tmpdir(), 'fish-skip-'))
const REL = '知识库/主人'
const ABS = join(HOME, REL)
await mkdir(ABS, { recursive: true })

// 三个普通小文件
for (const [name, body] of [
  ['a.md', 'aaa'],
  ['b.md', 'bbb'],
  ['c.md', 'ccc'],
]) {
  await writeFile(join(ABS, name), body, 'utf8')
}

// 一个超限文件（9MB，MAX_FILE_BYTES 是 8MB）
const TOOBIG_BYTES = 9 * 1024 * 1024
await writeFile(join(ABS, 'toobig.md'), Buffer.alloc(TOOBIG_BYTES, 1))

// ── 假对端 ──────────────────────────────────────────────
const REMOTE = new Map()

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url)
  if (u.pathname === '/api/manifest') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        identity: 'small-fish',
        label: '小肥鱼',
        generatedAt: new Date().toISOString(),
        files: [...REMOTE.values()],
      }),
    }
  }
  if (u.pathname === '/api/file') {
    const key = u.searchParams.get('key')
    if (opts.method === 'POST') {
      REMOTE.set(key, { key, size: 1, mtimeMs: Date.now(), sha256: 'x' })
    }
    return {
      ok: true,
      status: 200,
      // ⚠️ headers 必须有 —— pullFile 会 `res.headers.get('x-fish-sha256')`。
      //    第一版漏了，pullFile 抛 TypeError，被外层 catch 吃掉，
      //    表现是「该拉的没拉」，看起来像同步逻辑坏了。
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(1),
    }
  }
  return { ok: false, status: 404 }
}

const cfg = {
  identity: 'big-fish',
  label: '大肥鱼',
  home: HOME,
  peer: '127.0.0.1:1',
  token: 'test',
  targets: [{ id: 'test', rel: REL, mode: 'dir' }],
  protectMs: 0,
  discovery: false,
}

/**
 * 跑一次 syncOnce。
 * ⚠️ `resolvePeer` 必须给 —— 否则 `probePeer('127.0.0.1:1')` 真的去连端口，
 *    失败后走自动发现，最后返回 null，`syncOnce` 直接 `ok=false` 什么也不做。
 *    （第一版我就踩了这个，报告里 skipped 全是 0，看起来像代码没生效。）
 */
async function run() {
  return await syncOnce(cfg, {
    now: new Date(),
    log: () => {},
    resolvePeer: () => ({ address: '127.0.0.1', port: 9999, label: 'fake' }),
  })
}

try {
  // ── ① 本端 4 个，对端全都有（含超限那个）────────────────
  process.stdout.write('\n=== ① 两边完全一样（含一个超限文件）===\n')

  const local = await buildManifest(cfg)
  for (const f of local.files) {
    REMOTE.set(f.key, { key: f.key, size: f.size, mtimeMs: f.mtimeMs, sha256: f.sha256 })
  }
  process.stdout.write(`  本端 ${local.files.length} 个文件（其中 1 个超限）\n`)

  const r1 = await run()

  check('总数 = 三类之和', () => {
    const sum = r1.skippedSame + r1.skippedTooLarge + r1.skippedOutOfScope
    assert.equal(r1.skipped, sum, `skipped=${r1.skipped} 但三类和=${sum}`)
  })

  check('三个普通文件 → same', () => {
    assert.equal(r1.skippedSame, 3, `期望 3，实际 ${r1.skippedSame}`)
  })

  check('⚠️ 两边都超限 → too-large（不是 same）', () => {
    assert.equal(r1.skippedTooLarge, 1, `期望 1，实际 ${r1.skippedTooLarge}`)
  })

  check('⚠️ 这就是那个 null===null 的 bug：超限文件不许记成 same', () => {
    const d = r1.skippedDetail.find((x) => x.key.includes('toobig'))
    assert.ok(d, 'skippedDetail 里应该有它')
    assert.equal(d.reason, 'too-large',
      '⚠️ 它被记成了 ' + d.reason + ' —— null===null 判成了内容相同')
  })

  check('skippedDetail 每条都带合法 reason', () => {
    assert.equal(r1.skippedDetail.length, r1.skipped)
    for (const d of r1.skippedDetail) {
      assert.ok(typeof d.key === 'string' && d.key !== '')
      assert.ok(['same', 'too-large', 'out-of-scope'].includes(d.reason),
        '未知 reason：' + String(d.reason))
    }
  })

  // ── ② 对端多一个超限文件（本端没有）──────────────────────
  process.stdout.write('\n=== ② 对端多一个超限文件 ===\n')

  REMOTE.set('知识库/主人/remote-toobig.md', {
    key: '知识库/主人/remote-toobig.md',
    size: TOOBIG_BYTES,
    mtimeMs: Date.now(),
    sha256: null,
    skipped: 'too-large',
  })

  const r2 = await run()

  check('对端超限文件 → tooLarge 从 1 变 2', () => {
    assert.equal(r2.skippedTooLarge, 2, `期望 2，实际 ${r2.skippedTooLarge}`)
  })

  check('对端超限文件 → 不会拉下来', () => {
    assert.equal(r2.pulled.find((p) => p.key.includes('remote-toobig')), undefined)
  })

  check('⚠️ 它也不许被算进 same', () => {
    const d = r2.skippedDetail.find((x) => x.key.includes('remote-toobig'))
    assert.ok(d)
    assert.equal(d.reason, 'too-large')
  })

  check('same 数量没被超限文件污染（还是 3）', () => {
    assert.equal(r2.skippedSame, 3, `期望 3，实际 ${r2.skippedSame}`)
  })

  // ── ③ 对端多一个「不在范围」的文件 ───────────────────────
  process.stdout.write('\n=== ③ 对端多一个本端不认的路径 ===\n')

  REMOTE.set('知识库/别的目录/x.md', {
    key: '知识库/别的目录/x.md',
    size: 10,
    mtimeMs: Date.now(),
    sha256: 'deadbeef',
  })

  const r3 = await run()

  check('本端不认的路径 → outOfScope', () => {
    assert.equal(r3.skippedOutOfScope, 1, `期望 1，实际 ${r3.skippedOutOfScope}`)
  })

  check('⚠️ 它也不许被算进 same', () => {
    const d = r3.skippedDetail.find((x) => x.key.includes('别的目录'))
    assert.ok(d, 'skippedDetail 里应该有它')
    assert.equal(d.reason, 'out-of-scope')
  })

  // ── ④ 对端多一个正常新文件 ──────────────────────────────
  process.stdout.write('\n=== ④ 对端多一个正常新文件（该拉）===\n')

  REMOTE.set('知识库/主人/new.md', {
    key: '知识库/主人/new.md',
    size: 5,
    mtimeMs: Date.now(),
    sha256: 'cafebabe',
  })

  const r4 = await run()

  check('正常新文件 → 真的拉（不算跳过）', () => {
    const hit = r4.pulled.find((p) => p.key.includes('new.md'))
    assert.ok(hit, '应该被拉下来')
  })

  check('拉完之后它不在 skippedDetail 里', () => {
    const hit = r4.skippedDetail.find((x) => x.key.includes('new.md'))
    assert.equal(hit, undefined, '被拉的文件不该出现在跳过明细里')
  })

  // ── ⑤ 报告字段齐全 ──────────────────────────────────────
  process.stdout.write('\n=== ⑤ 报告字段 ===\n')

  check('报告里四个分类字段都在', () => {
    for (const k of ['skipped', 'skippedSame', 'skippedTooLarge', 'skippedOutOfScope']) {
      assert.ok(k in r4, '缺字段 ' + k)
      assert.equal(typeof r4[k], 'number', k + ' 不是数字')
    }
    assert.ok(Array.isArray(r4.skippedDetail))
  })

  check('老调用方读 r.skipped 仍然得到数字（向后兼容）', () => {
    assert.equal(typeof r1.skipped, 'number')
    assert.ok(r1.skipped > 0)
  })
} finally {
  await rm(HOME, { recursive: true, force: true })
}

process.stdout.write(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`)
if (fail > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const f of failures) {
    process.stdout.write(`  ❌ ${f.name}\n     ${String(f.error?.stack ?? f.error).split('\n').slice(0, 3).join('\n     ')}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write('全部通过。\n')
}
