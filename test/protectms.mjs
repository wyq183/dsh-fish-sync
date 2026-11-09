/**
 * protectMs 语义回归 —— 2026-10-23 修的那个 bug 的守卫。
 *
 * ## 背景
 *
 * `protectMs` 的原意是「本地文件刚改过，**别被对端覆盖**」。
 * 它只该管「拉取」这一个动作 —— 因为只有拉取会覆盖本端。
 *
 * 但旧代码在「本端较新 → 推送」那条分支里也套了这个判断：
 *
 * ```js
 * if (mineIsNewer) {
 *   if (recentlyTouched) {          // ← 错！推送不会覆盖本端
 *     report.conflicts.push({ reason: '本端刚改过，本次保护不覆盖' })
 *     continue                       // ← 不推了
 *   }
 *   await pushFile(...)
 * }
 * ```
 *
 * 后果：**刚写完文件立刻同步 → 被拦下、干等 90 秒，报告还写着「冲突」**，
 * 看着像出错了。实际上推送根本不会覆盖本端，这个保护在这里是纯伤害。
 *
 * ## 这个 bug 为什么能活这么久
 *
 * 因为 `offline.mjs` 那条「两端同步后内容一致」的用例**测不到它**：
 * 那条用例里两端文件都刚创建，mtime 相近，走的是「对端较新 → 拉取」分支，
 * 根本进不到「本端较新 → 推送」这个分支。
 *
 * **→ 通用教训：测试全绿不代表修复正确。要专门造出「刚改完立刻同步」的场景。**
 *
 * 跑：node test/protectms.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/identity.js'
import { startServer } from '../lib/server.js'
import { syncOnce } from '../lib/sync.js'

let pass = 0
let fail = 0
const failures = []

/**
 * 跑一条断言。
 * @param {string} name - 用例名。
 * @param {Function} fn - 断言体。
 */
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    process.stdout.write(`  ✅ ${name}\n`)
  } catch (error) {
    fail += 1
    failures.push(`${name}: ${error?.message ?? error}`)
    process.stdout.write(`  ❌ ${name}\n     ${error?.message ?? error}\n`)
  }
}

/**
 * 造一个带白名单目录的临时 dsh home。
 * @param {string} tag - 后缀。
 * @returns {Promise<string>} home 路径。
 */
async function makeHome(tag) {
  const home = await mkdtemp(join(tmpdir(), `fish-pms-${tag}-`))
  await mkdir(join(home, 'yiqi-pending'), { recursive: true })
  await mkdir(join(home, 'yiqishard', 'memory'), { recursive: true })
  await mkdir(join(home, 'yiqishard', '交接'), { recursive: true })
  await writeFile(join(home, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[]}', 'utf8')
  return home
}

process.stdout.write('\n── protectMs 只该拦「拉取」，不该拦「推送」──\n')

await check('🔴 本端刚改过（protectMs 内）+ 对端是旧版 → 必须推送，不许报冲突', async () => {
  // 这是修之前的 bug：刚写完文件立刻同步会被拦下，要干等 90 秒。
  const homeA = await makeHome('A')
  const homeB = await makeHome('B')
  const token = 'pms-token-123456789'

  // B 端先有一份旧内容，并且**时间调早**（让 A 成为「较新」的一方）
  const oldText = JSON.stringify({ version: 1, items: [{ id: 'old', title: '旧内容' }] })
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), oldText, 'utf8')
  const past = new Date(Date.now() - 60_000)
  await utimes(join(homeB, 'yiqi-pending', 'pending.json'), past, past)

  // A 端**刚刚**写了一份新内容 —— 落在 protectMs 窗口内（默认 90 秒）
  const newText = JSON.stringify({ version: 1, items: [{ id: 'new', title: '刚改的新内容' }] })
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), newText, 'utf8')

  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB), port: 0 }, {})
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: `127.0.0.1:${server.port}`,
    // 默认 protectMs（90 秒）—— 故意不设 0，就是要测「刚改过」的场景
  }, homeA)

  // 自证前提：文件确实在保护窗口内
  const { stat } = await import('node:fs/promises')
  const st = await stat(join(homeA, 'yiqi-pending', 'pending.json'))
  const ageMs = Date.now() - st.mtimeMs
  assert.ok(ageMs < cfgA.protectMs, `测试前提不成立：文件年龄 ${ageMs}ms 不在 protectMs(${cfgA.protectMs}) 内`)

  try {
    const report = await syncOnce(cfgA, {})

    assert.equal(report.ok, true, `同步应成功：${report.errors.join('; ')}`)
    assert.equal(
      report.conflicts.length, 0,
      `刚改完就推送不该算冲突，实际冲突 ${report.conflicts.length} 个：${JSON.stringify(report.conflicts)}`,
    )
    assert.ok(
      report.pushed.some((x) => x.key === 'yiqi-pending/pending.json'),
      `必须推送 pending.json，实际推送了：${report.pushed.map((x) => x.key).join(', ') || '（无）'}`,
    )

    // 硬判据：对端真的收到了新内容（不是「报告说推了」）
    const bText = await readFile(join(homeB, 'yiqi-pending', 'pending.json'), 'utf8')
    assert.equal(bText, newText, '对端内容必须是 A 刚写的新内容')
  } finally {
    await server.close()
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

await check('🔴 对端较新 + 本端刚改过 → 仍然要保护本端（别把保护删过头）', async () => {
  // 反向用例：修 bug 时容易把 protectMs 整个删掉。
  // 但「对端较新、要拉下来覆盖我」时，保护是**必须保留**的 ——
  // 否则我刚写的东西会被对端覆盖掉。
  const homeA = await makeHome('C')
  const homeB = await makeHome('D')
  const token = 'pms-token-reverse-1'

  // A 端刚改过（本地内容）
  const aText = JSON.stringify({ version: 1, items: [{ id: 'mine', title: '我刚写的' }] })
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), aText, 'utf8')

  // B 端内容更新（时间更晚）→ B 是「对端较新」，A 会被要求拉取覆盖
  const bText = JSON.stringify({ version: 1, items: [{ id: 'theirs', title: '对端更新的' }] })
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), bText, 'utf8')
  const future = new Date(Date.now() + 60_000)
  await utimes(join(homeB, 'yiqi-pending', 'pending.json'), future, future)

  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB), port: 0 }, {})
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: `127.0.0.1:${server.port}`,
  }, homeA)

  try {
    const report = await syncOnce(cfgA, {})

    assert.equal(
      report.conflicts.length, 1,
      `对端较新 + 本端刚改过 → 应记 1 条冲突并保留本端，实际 ${report.conflicts.length} 条`,
    )
    assert.equal(report.pulled.length, 0, '不该拉取覆盖本端刚改的内容')

    // 硬判据：本端内容没被改掉
    const afterText = await readFile(join(homeA, 'yiqi-pending', 'pending.json'), 'utf8')
    assert.equal(afterText, aText, '本端刚改的内容必须被保住，不能被对端覆盖')
  } finally {
    await server.close()
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

await check('protectMs 设 0 时，对端较新也能正常拉取（保护可关闭）', async () => {
  const homeA = await makeHome('E')
  const homeB = await makeHome('F')
  const token = 'pms-token-zero-01'

  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[{"id":"mine"}]}', 'utf8')
  const bText = '{"version":1,"items":[{"id":"theirs"}]}'
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), bText, 'utf8')
  const future = new Date(Date.now() + 60_000)
  await utimes(join(homeB, 'yiqi-pending', 'pending.json'), future, future)

  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB), port: 0 }, {})
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: `127.0.0.1:${server.port}`,
    protectMs: 0,
  }, homeA)

  try {
    const report = await syncOnce(cfgA, {})
    assert.equal(report.conflicts.length, 0, 'protectMs=0 时不该有冲突')
    assert.ok(
      report.pulled.some((x) => x.key === 'yiqi-pending/pending.json'),
      'protectMs=0 时应正常拉取',
    )
    const afterText = await readFile(join(homeA, 'yiqi-pending', 'pending.json'), 'utf8')
    assert.equal(afterText, bText, '内容应被对端覆盖')
  } finally {
    await server.close()
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

await check('🔴 文件 mtime 在未来（负 ageMs）时，protectMs=0 仍然不保护', async () => {
  // 2026-10-23 抓到的真 bug：
  //
  //   const ageMs = Date.now() - mine.mtimeMs
  //   const recentlyTouched = ageMs < cfg.protectMs
  //
  // NTFS 的 mtime 精度比 Date.now() 细，文件刚写完时 mtime 会「稍晚」于当前时间，
  // 于是 ageMs 是**负数**（实测 -3.56ms）→ `-3.56 < 0` 成立
  // → protectMs=0（本意「完全不保护」）反而变成「永远保护」。
  //
  // 表现：同步随机报冲突，概率约 1/5 —— 测试偶发失败才暴露出来。
  //
  // 这条用例**故意**把本端 mtime 设到未来，把「负 ageMs」变成确定性的，
  // 这样 bug 一回来就必挂，不用靠运气。
  const homeA = await makeHome('G')
  const homeB = await makeHome('H')
  const token = 'pms-token-future-1'

  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'), '{"version":1,"items":[{"id":"mine"}]}', 'utf8')
  // 本端 mtime 设到未来 30 秒 → ageMs 一定是负数
  const farFuture = new Date(Date.now() + 30_000)
  await utimes(join(homeA, 'yiqi-pending', 'pending.json'), farFuture, farFuture)

  // 对端更晚（未来 60 秒）→ 对端较新，本端会被要求拉取
  const bText = '{"version":1,"items":[{"id":"theirs"}]}'
  await writeFile(join(homeB, 'yiqi-pending', 'pending.json'), bText, 'utf8')
  const evenLater = new Date(Date.now() + 60_000)
  await utimes(join(homeB, 'yiqi-pending', 'pending.json'), evenLater, evenLater)

  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB), port: 0 }, {})
  const cfgA = normalizeConfig({
    identity: 'big-fish',
    token,
    peer: `127.0.0.1:${server.port}`,
    protectMs: 0,
  }, homeA)

  try {
    // 自证前提：本端确实在「未来」
    const { stat } = await import('node:fs/promises')
    const st = await stat(join(homeA, 'yiqi-pending', 'pending.json'))
    const ageMs = Date.now() - st.mtimeMs
    assert.ok(ageMs < 0, `测试前提不成立：ageMs 应为负数，实际 ${ageMs}`)

    const report = await syncOnce(cfgA, {})
    assert.equal(
      report.conflicts.length, 0,
      `protectMs=0 + 负 ageMs 时不该保护，实际冲突 ${report.conflicts.length} 个：`
      + JSON.stringify(report.conflicts),
    )
    assert.ok(
      report.pulled.some((x) => x.key === 'yiqi-pending/pending.json'),
      'protectMs=0 时应正常拉取',
    )
  } finally {
    await server.close()
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
