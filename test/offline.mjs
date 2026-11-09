/**
 * 离线自检 —— 不开 DSH，直接把同步逻辑跑一遍。
 *
 * 覆盖三件事（每件都是「不测就会静默坏掉」的）：
 *  ① 路径穿越必须被拒（安全边界）
 *  ② 白名单外的路径必须被拒（服务端不能变成任意文件读写）
 *  ③ 端到端：两个目录当两端，同步后内容一致、sha256 对得上
 *
 * 跑：node test/offline.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, normalizeRelPath, isNightWindow } from '../lib/identity.js'
import { buildManifest, resolveAllowedKey } from '../lib/manifest.js'
import { startServer } from '../lib/server.js'
import { syncOnce, pullFile } from '../lib/sync.js'
import { readOutbox, writeOutbox, mergeOutbox } from '../lib/wakeup.js'
import { sha256 } from '../lib/manifest.js'

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

/** 建一个临时的假 dsh home。 */
async function makeHome(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `fish-${prefix}-`))
  await mkdir(join(dir, 'yiqi-pending'), { recursive: true })
  await mkdir(join(dir, 'yiqishard', 'memory'), { recursive: true })
  return dir
}

process.stdout.write('\n── ① 路径安全 ──\n')

await check('拒绝 ../ 穿越', () => {
  assert.equal(normalizeRelPath('../../etc/passwd'), null)
  assert.equal(normalizeRelPath('a/../../b'), null)
})

await check('拒绝绝对路径与盘符', () => {
  assert.equal(normalizeRelPath('/etc/passwd'), null)
  assert.equal(normalizeRelPath('C:/Windows/win.ini'), null)
})

await check('拒绝空与控制字符', () => {
  assert.equal(normalizeRelPath(''), null)
  assert.equal(normalizeRelPath('a/\u0000b'), null)
})

await check('正常路径规范化', () => {
  assert.equal(normalizeRelPath('yiqishard/memory/2026-10-21.md'), 'yiqishard/memory/2026-10-21.md')
  assert.equal(normalizeRelPath('./yiqi-pending/pending.json'), 'yiqi-pending/pending.json')
  assert.equal(normalizeRelPath('a\\b'), 'a/b')
})

process.stdout.write('\n── ② 白名单 ──\n')

await check('白名单内放行（pending）', async () => {
  const home = await makeHome('wl1')
  const cfg = normalizeConfig({}, home)
  assert.equal(await resolveAllowedKey(cfg, 'yiqi-pending/pending.json'), 'yiqi-pending/pending.json')
  await rm(home, { recursive: true, force: true })
})

await check('白名单内放行（memory 日期文件）', async () => {
  const home = await makeHome('wl2')
  const cfg = normalizeConfig({}, home)
  assert.equal(await resolveAllowedKey(cfg, 'yiqishard/memory/2026-10-21.md'), 'yiqishard/memory/2026-10-21.md')
  await rm(home, { recursive: true, force: true })
})

await check('白名单外拒绝（其他记忆文件）', async () => {
  const home = await makeHome('wl3')
  const cfg = normalizeConfig({}, home)
  assert.equal(await resolveAllowedKey(cfg, 'yiqishard/个人档案.md'), null)
  assert.equal(await resolveAllowedKey(cfg, 'yiqishard/MEMORY.md'), null)
  assert.equal(await resolveAllowedKey(cfg, 'yiqishard/memory/notes.md'), null)
  assert.equal(await resolveAllowedKey(cfg, 'yiqishard/memory/sub/2026-10-21.md'), null)
  await rm(home, { recursive: true, force: true })
})

process.stdout.write('\n── ③ 端到端同步 ──\n')

await check('两端同步后内容一致', async () => {
  const homeA = await makeHome('A')
  const homeB = await makeHome('B')
  const token = 'test-token-123'

  // A 有：pending + 今天 + 昨天的记忆
  await writeFile(join(homeA, 'yiqi-pending', 'pending.json'),
    JSON.stringify({ version: 1, items: [{ id: 'x', title: '同步插件' }] }), 'utf8')
  const today = new Date()
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  await writeFile(join(homeA, 'yiqishard', 'memory', `${fmt(today)}.md`), '# 今天\n大肥鱼写的\n', 'utf8')
  // B 有：另一天的记忆
  const yesterday = new Date(today.getTime() - 86400000)
  await writeFile(join(homeB, 'yiqishard', 'memory', `${fmt(yesterday)}.md`), '# 昨天\n小肥鱼写的\n', 'utf8')

  // B 起服务
  const cfgB = normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB)
  const server = await startServer({ ...cfgB, port: 0 }, {})
  // port 0 → 系统分配，要读实际端口
  const realPort = server.port

  // A 作为客户端去同步
  const cfgA = normalizeConfig({ identity: 'big-fish', token, peer: `127.0.0.1:${realPort}` }, homeA)
  const report = await syncOnce(cfgA, {})

  assert.equal(report.ok, true, `同步应成功：${report.errors.join('; ')}`)
  assert.ok(report.pushed.length >= 2, `应推送至少 2 个，实际 ${report.pushed.length}`)
  assert.ok(report.pulled.length >= 1, `应拉取至少 1 个，实际 ${report.pulled.length}`)

  // 内容一致
  const aPending = await readFile(join(homeA, 'yiqi-pending', 'pending.json'), 'utf8')
  const bPending = await readFile(join(homeB, 'yiqi-pending', 'pending.json'), 'utf8')
  assert.equal(aPending, bPending, 'pending.json 应一致')

  const aToday = await readFile(join(homeA, 'yiqishard', 'memory', `${fmt(today)}.md`), 'utf8')
  const bToday = await readFile(join(homeB, 'yiqishard', 'memory', `${fmt(today)}.md`), 'utf8')
  assert.equal(aToday, bToday, '今日记忆应一致')

  const bYest = await readFile(join(homeB, 'yiqishard', 'memory', `${fmt(yesterday)}.md`), 'utf8')
  const aYest = await readFile(join(homeA, 'yiqishard', 'memory', `${fmt(yesterday)}.md`), 'utf8')
  assert.equal(aYest, bYest, '昨天记忆应同步过来')

  // 再跑一次：应该全部跳过（内容相同）
  const report2 = await syncOnce(cfgA, {})
  assert.equal(report2.pushed.length, 0, '第二次不该再推')
  assert.equal(report2.pulled.length, 0, '第二次不该再拉')
  assert.ok(report2.skipped >= 3, `第二次应全部跳过，实际跳过 ${report2.skipped}`)

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

await check('token 不对 → 401', async () => {
  const homeB = await makeHome('T')
  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token: 'right', port: 0 }, homeB), port: 0 }, {})
  const res = await fetch(`http://127.0.0.1:${server.port}/api/manifest`, {
    headers: { 'x-fish-token': 'wrong' },
  })
  assert.equal(res.status, 401)
  await server.close()
  await rm(homeB, { recursive: true, force: true })
})

await check('没配 token → 503（fail closed）', async () => {
  const homeB = await makeHome('T2')
  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token: '', port: 0 }, homeB), port: 0 }, {})
  const res = await fetch(`http://127.0.0.1:${server.port}/api/manifest`, {
    headers: { 'x-fish-token': 'anything' },
  })
  assert.equal(res.status, 503)
  await server.close()
  await rm(homeB, { recursive: true, force: true })
})

await check('服务端拒绝白名单外路径', async () => {
  const homeB = await makeHome('T3')
  await writeFile(join(homeB, 'yiqishard', '个人档案.md'), 'secret', 'utf8')
  const server = await startServer({ ...normalizeConfig({ identity: 'small-fish', token: 't', port: 0 }, homeB), port: 0 }, {})
  const res = await fetch(`http://127.0.0.1:${server.port}/api/file?key=${encodeURIComponent('yiqishard/个人档案.md')}`, {
    headers: { 'x-fish-token': 't' },
  })
  assert.equal(res.status, 403, '不该让对端读到个人档案')
  await server.close()
  await rm(homeB, { recursive: true, force: true })
})

process.stdout.write('\n── ④ 夜间时段 ──\n')

await check('夜间判定（跨零点）', () => {
  const at = (h) => new Date(2026, 9, 21, h, 0, 0)
  assert.equal(isNightWindow(at(23), 23, 7), true, '23 点算夜间')
  assert.equal(isNightWindow(at(3), 23, 7), true, '3 点算夜间')
  assert.equal(isNightWindow(at(6), 23, 7), true, '6 点算夜间')
  assert.equal(isNightWindow(at(7), 23, 7), false, '7 点不算')
  assert.equal(isNightWindow(at(14), 23, 7), false, '14 点不算')
})

process.stdout.write('\n── ④ 拉取也要过本端白名单（2026-10-24 修）──\n')

/**
 * 这一节守的是**安全边界**：`targets` 在「推」的方向管用，
 * 但「拉」的方向原来是空的。
 *
 * ## 事故经过（实际踩到，不是推演）
 *
 * 2026-10-24 撤日记提案时：
 *   · 本端已经把那个目标删了 —— 向自己 3098 要它 → **403**
 *   · 但同步**照样把它拉进来了** —— 因为对端还认
 *
 * ## 根因
 *
 * `allKeys` = 本端清单 ∪ **对端清单（直接用，没过滤）**；
 * 判据是「对端有、本端没有 → 拉」，**本端允许什么在这条路径上完全没参与**。
 *
 * ## 这一节怎么判
 *
 * 造一个「对端认、本端不认」的路径，跑真实 `syncOnce`：
 *   · 阴性：本端不认 → **文件不该出现在本端**
 *   · 阳性（对照）：本端也认 → **文件应该拉过来**
 *
 * 两条一起过才算数 —— 只验阴性可能只是「整个同步挂了」。
 */

/** 造一条「出差记录」目标（dir-recent）。 */
const tripTarget = () => ({
  id: 'trip-test', rel: 'yiqishard/出门', mode: 'dir-recent', days: 3, label: '出门',
})

const todayStr = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

/**
 * 跑一个「对端认 / 本端认不认」的对照。
 * @param {boolean} localKnows - 本端 targets 里要不要也加这条。
 * @returns {Promise<{report: object, existsLocally: boolean}>} 结果。
 */
async function tryPullDynamic(localKnows) {
  const homeA = await makeHome('pullA')
  const homeB = await makeHome('pullB')
  const token = 'tk'

  // 两端都建出门目录（B 写文件，A 空着 —— 模拟「对端有、本端没有」）
  await mkdir(join(homeB, 'yiqishard', '出门'), { recursive: true })
  await mkdir(join(homeA, 'yiqishard', '出门'), { recursive: true })
  await writeFile(join(homeB, 'yiqishard', '出门', `${todayStr}.md`), '# 今天出门了\n', 'utf8')

  const cfgB = normalizeConfig({ identity: 'small-fish', token, port: 0 }, homeB)
  cfgB.targets = [...cfgB.targets, tripTarget()]          // 对端认得
  const server = await startServer({ ...cfgB, port: 0 }, {})

  const cfgA = normalizeConfig(
    { identity: 'big-fish', token, peer: `127.0.0.1:${server.port}` }, homeA,
  )
  if (localKnows) cfgA.targets = [...cfgA.targets, tripTarget()]   // 本端认不认，就在这一行

  const report = await syncOnce(cfgA, {})

  let existsLocally = false
  try {
    await readFile(join(homeA, 'yiqishard', '出门', `${todayStr}.md`), 'utf8')
    existsLocally = true
  } catch { /* 不在就是不在 —— 正是阴性用例期望的 */ }

  await server.close()
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
  return { report, existsLocally }
}

await check('🔴 对端认、本端不认 → 不拉（白名单在拉的方向也要管用）', async () => {
  const { report, existsLocally } = await tryPullDynamic(false)
  assert.equal(report.ok, true, `同步本身要成功：${report.errors.join('; ')}`)
  assert.equal(
    existsLocally, false,
    '🔴 本端 targets 里没有这条 → 对端有也不许拉进来（这就是修的那个洞）',
  )
  assert.equal(
    report.pulled.some((p) => p.key.includes('出门')), false,
    'pulled 列表里也不该出现它',
  )
})

await check('🟢 对照（阳性）：两端都认 → 正常拉过来', async () => {
  const { report, existsLocally } = await tryPullDynamic(true)
  assert.equal(report.ok, true)
  assert.equal(existsLocally, true, '本端也认这条 → 必须能拉到（否则上面那条阴性是假绿）')
  assert.equal(
    report.pulled.some((p) => p.key.includes('出门')), true,
    'pulled 列表里应该有它',
  )
})

// ── ⑤ 插件自有文件必须进清单（2026-10-25 加）──────────────────
//
// 🔴 这一节的来历：唤醒机制要同步 `fish-sync/wakeup-outbox.json`。
//    我在 `resolveAllowedKey` 里放行了它（HTTP 能读写），
//    但 `buildManifest` **只遍历 targets** —— 它不在任何 target 里，
//    所以**永远进不了清单，也就永远同步不出去**。
//
//    表现：`fish_sync_notify` 报「已同步过去」，对端 GET 返 404。
//
//    教训：**「能读写」和「在清单里」是两件事。** 同步靠的是清单。
process.stdout.write('\n── ⑤ 插件自有文件必须进清单 ──\n')

await check('🔴 wakeup-outbox.json 存在时，必须出现在 manifest 里', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-manifest-'))
  try {
    // 造一个最小 home：只需要 fish-sync/wakeup-outbox.json
    await mkdir(join(home, 'fish-sync'), { recursive: true })
    await writeFile(
      join(home, 'fish-sync', 'wakeup-outbox.json'),
      JSON.stringify({ version: 1, outbox: [], lastSeenAt: null }),
      'utf8',
    )

    const cfg = {
      identity: 'big-fish',
      label: '测试',
      home,
      targets: [], // 故意空 —— 证明它不靠 targets 也能进清单
    }

    const manifest = await buildManifest(cfg)
    const keys = manifest.files.map((f) => f.key)
    assert.ok(
      keys.includes('fish-sync/wakeup-outbox.json'),
      `manifest 里必须有 fish-sync/wakeup-outbox.json，实际有：${keys.join(', ') || '(空)'}`,
    )

    // 而且它要有真实的 sha256（不是 null）
    const entry = manifest.files.find((f) => f.key === 'fish-sync/wakeup-outbox.json')
    assert.equal(typeof entry.sha256, 'string')
    assert.equal(entry.sha256.length, 64)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('阴性：wakeup-outbox.json 不存在时，不能凭空出现在清单里', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-manifest2-'))
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })
    // 故意不写 wakeup.json

    const cfg = { identity: 'big-fish', label: '测试', home, targets: [] }
    const manifest = await buildManifest(cfg)
    const keys = manifest.files.map((f) => f.key)
    assert.equal(
      keys.includes('fish-sync/wakeup-outbox.json'), false,
      '文件不存在就不该出现在清单里（否则对端会来拉一个空的）',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('阴性：paired.json（长期密钥）绝不能进清单', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-manifest3-'))
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })
    await writeFile(join(home, 'fish-sync', 'paired.json'), '{"secret":"x"}', 'utf8')
    await writeFile(join(home, 'fish-sync', 'wakeup-outbox.json'), '{"version":1}', 'utf8')

    const cfg = { identity: 'big-fish', label: '测试', home, targets: [] }
    const manifest = await buildManifest(cfg)
    const keys = manifest.files.map((f) => f.key)
    assert.equal(
      keys.some((k) => k.includes('paired')), false,
      '密钥绝不能进清单 —— 那是把钥匙贴到局域网上',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── ⑥ outbox 拉取必须是并集，不是覆盖（2026-10-25 加）──────────
//
// 🔴 来历：小肥鱼 14:12 实测 —— 她推过来的 outbox 版本把我的通知盖掉了。
//    这是「按 mtime 比新旧」对「两端都写的共同数据」用错了。
//
//    跟她 10-22 那次「同步把我本地两条覆盖了」是同一个病根。
process.stdout.write('\n── ⑥ outbox 拉取是并集，不是覆盖 ──\n')

await check('🔴 两端各有自己的消息，拉取后两边都在（一条都不能丢）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-outbox-'))
  const file = join(home, 'fish-sync', 'wakeup-outbox.json')
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })

    // 本端：我发给她的两条
    const mine = [
      { id: 'mine-1', to: 'small-fish', from: 'big-fish', kind: 'letter', createdAt: '2026-10-25T01:00:00.000Z' },
      { id: 'mine-2', to: 'small-fish', from: 'big-fish', kind: 'letter', createdAt: '2026-10-25T02:00:00.000Z' },
    ]
    await writeOutbox(file, { version: 1, outbox: mine })

    // 模拟 pullFile 的合并分支（不跑真 HTTP，直接验合并逻辑）
    const theirs = [
      { id: 'theirs-1', to: 'big-fish', from: 'small-fish', kind: 'letter', createdAt: '2026-10-25T03:00:00.000Z' },
    ]
    const merged = mergeOutbox(mine, theirs)
    await writeOutbox(file, { version: 1, outbox: merged })

    const back = await readOutbox(file)
    const ids = back.outbox.map((m) => m.id).sort()
    assert.deepEqual(ids, ['mine-1', 'mine-2', 'theirs-1'], `并集应保留三条，实际：${ids.join(',')}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('阴性：如果直接覆盖（不合并），本端消息会丢 —— 证明合并是必要的', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-outbox2-'))
  const file = join(home, 'fish-sync', 'wakeup-outbox.json')
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })

    const mine = [
      { id: 'mine-1', to: 'small-fish', from: 'big-fish', kind: 'letter', createdAt: '2026-10-25T01:00:00.000Z' },
    ]
    await writeOutbox(file, { version: 1, outbox: mine })

    // ❌ 错误做法：直接覆盖
    const theirs = [
      { id: 'theirs-1', to: 'big-fish', from: 'small-fish', kind: 'letter', createdAt: '2026-10-25T03:00:00.000Z' },
    ]
    await writeOutbox(file, { version: 1, outbox: theirs })

    const back = await readOutbox(file)
    assert.equal(back.outbox.length, 1, '直接覆盖只剩一条')
    assert.equal(back.outbox[0].id, 'theirs-1', '本端那条（mine-1）被盖掉了 —— 这就是要修的问题')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── ⑦ 真跑 pullFile：验「outbox 走并集分支」（2026-10-25 加）────
//
// 上面 ⑥ 只验了 mergeOutbox 这个纯函数。
// 但真正的风险在 sync.js 的 pullFile 里 —— 如果那个 `if` 分支写错/没生效，
// 纯函数再对也没用。所以这里起一个假对端 HTTP 服务，真跑一遍。
process.stdout.write('\n── ⑦ 真跑 pullFile（假对端 HTTP 服务）──\n')

await check('🔴 pullFile 拉 outbox 时走并集，本端消息不丢', async () => {
  const http = await import('node:http')
  const home = await mkdtemp(join(tmpdir(), 'fish-pull-'))
  const file = join(home, 'fish-sync', 'wakeup-outbox.json')

  // 本端：我发的两条
  const mine = [
    { id: 'mine-1', to: 'small-fish', from: 'big-fish', kind: 'letter', createdAt: '2026-10-25T01:00:00.000Z' },
    { id: 'mine-2', to: 'small-fish', from: 'big-fish', kind: 'letter', createdAt: '2026-10-25T02:00:00.000Z' },
  ]
  // 对端：她发的一条
  const theirs = [
    { id: 'theirs-1', to: 'big-fish', from: 'small-fish', kind: 'letter', createdAt: '2026-10-25T03:00:00.000Z' },
  ]

  await mkdir(join(home, 'fish-sync'), { recursive: true })
  await writeOutbox(file, { version: 1, outbox: mine })

  const theirBody = Buffer.from(JSON.stringify({ version: 1, outbox: theirs }), 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-fish-sha256': sha256(theirBody),
    })
    res.end(theirBody)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const cfg = {
      home,
      peer: `127.0.0.1:${port}`,
      token: 'test-token',
    }
    await pullFile(cfg, 'fish-sync/wakeup-outbox.json')

    const back = await readOutbox(file)
    const ids = back.outbox.map((m) => m.id).sort()
    assert.deepEqual(
      ids, ['mine-1', 'mine-2', 'theirs-1'],
      `并集应保留三条，实际：${ids.join(',')}（少了就是被覆盖了）`,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})

await check('阴性：普通文件仍然走覆盖（不能被并集逻辑误伤）', async () => {
  const http = await import('node:http')
  const home = await mkdtemp(join(tmpdir(), 'fish-pull2-'))
  const key = 'yiqishard/信箱/测试.md'
  const file = join(home, 'yiqishard', '信箱', '测试.md')

  await mkdir(join(home, 'yiqishard', '信箱'), { recursive: true })
  await writeFile(file, '本端旧内容', 'utf8')

  const theirBody = Buffer.from('对端新内容', 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-fish-sha256': sha256(theirBody),
    })
    res.end(theirBody)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const cfg = { home, peer: `127.0.0.1:${port}`, token: 'test-token' }
    await pullFile(cfg, key)
    const content = await readFile(file, 'utf8')
    assert.equal(content, '对端新内容', '普通文件必须被覆盖（这是同步的本意）')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
