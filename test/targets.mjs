/**
 * 同步范围提案与投票 —— 2026-10-23 主人要的「方便性」。
 *
 * ## 主人原话（这是全部需求的来源）
 *
 * > 「插件本身应该多一点拓展也就是方便性更新，���如我要新增一个让你们同步的条目，
 * >  比如哪天我要出门玩，要你们做个临时同步，关于今天我去哪玩了的记录分享，
 * >  总不能这么简单还要大费周章的更新插件吧」
 * >
 * > 「顶层白名单你们可以商量下，允许你们自己加同步内容，但是**你们得商量投票来**」
 *
 * ## 这个测试在守什么
 *
 * 核心不变量只有三条：
 *   ① **一个人不能自己扩边界** —— 一票不生效，两票才生效
 *   ② **白名单是安全边界** —— 提案里的 rel 必须落在允许的顶层目录里，
 *      且 `fish-sync/paired.json`（长期密钥）永远不许同步
 *   ③ **合并是并集，不是覆盖** —— 两端各提一个，两个都得在
 *
 * 每条都配了「反向用例」：不只验「该过的过了」，也验「该拒的拒了」。
 *
 * 跑：node test/targets.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sanitizeTargetRel,
  normalizeProposal,
  proposalState,
  mergeProposals,
  resolveActiveTargets,
  addProposal,
  castVote,
  readTargetsFile,
  writeTargetsFile,
  withdrawProposal,
  ALLOWED_ROOTS,
  DENY_PATTERNS,
} from '../lib/targets.js'
import { normalizeConfig, attachDynamicTargets } from '../lib/identity.js'
import { resolveAllowedKey, isDeniedKey } from '../lib/manifest.js'

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

process.stdout.write('\n── ① 白名单是安全边界（该拒的必须拒）──\n')

await check('🔴 顶层目录不在白名单 → 拒绝', () => {
  // 这是攻击面：提案来自网络，写个 ../.ssh 或者系统目录就完了
  assert.equal(sanitizeTargetRel('.ssh/id_rsa'), null)
  assert.equal(sanitizeTargetRel('AppData/Local/x.md'), null)
  assert.equal(sanitizeTargetRel('随便一个目录/x.md'), null)
})

await check('🔴 目录穿越 → 拒绝', () => {
  assert.equal(sanitizeTargetRel('yiqishard/../../etc/passwd'), null)
  assert.equal(sanitizeTargetRel('../yiqishard/x.md'), null)
  assert.equal(sanitizeTargetRel('/etc/passwd'), null)
  assert.equal(sanitizeTargetRel('C:/Windows/x.md'), null)
})

await check('🔴 密钥文件永远不许同步（即使在白名单目录下）', () => {
  // fish-sync 在白名单里，但 paired.json 是**长期密钥**
  assert.equal(sanitizeTargetRel('fish-sync/paired.json'), null)
  assert.equal(sanitizeTargetRel('fish-sync/diag.json'), null)
  // 但 targets.json 本身要能同步（不然两端投票投不到一起）
  assert.equal(sanitizeTargetRel('fish-sync/targets.json'), 'fish-sync/targets.json')
})

await check('白名单内的正常路径 → 通过', () => {
  assert.equal(sanitizeTargetRel('yiqishard/出门'), 'yiqishard/出门')
  assert.equal(sanitizeTargetRel('yiqishard/出门/2026-10-24.md'), 'yiqishard/出门/2026-10-24.md')
  assert.equal(sanitizeTargetRel('yiqi-pending/pending.json'), 'yiqi-pending/pending.json')
  assert.equal(sanitizeTargetRel('知识库/x.md'), '知识库/x.md')
  assert.equal(sanitizeTargetRel('梗库/y.md'), '梗库/y.md')
})

await check('白名单根目录数量受控（别悄悄加）', () => {
  // 这个断言是给未来的自己看的：加新根目录 = 放宽安全边界，
  // 应该是**显式的、有理由的**，不是顺手加的。
  assert.deepEqual(ALLOWED_ROOTS, ['yiqishard', 'yiqi-pending', '知识库', '梗库', 'fish-sync'])
})

process.stdout.write('\n── ② 投票：一个人不能自己扩边界 ──\n')

await check('🔴 只有一票 → 不生效', () => {
  const p = normalizeProposal({
    id: 'trip-1',
    rel: 'yiqishard/出门',
    mode: 'dir-recent',
    days: 2,
    label: '出门记录',
    proposedBy: 'big-fish',
    proposedAt: new Date().toISOString(),
  })
  assert.ok(p !== null)
  // 提出方自动有一票
  assert.deepEqual(p.votes, { 'big-fish': 'yes' })
  // 但一票不够
  assert.equal(proposalState(p), 'pending')
})

await check('🔴 两票 → 生效', () => {
  const p = normalizeProposal({
    id: 'trip-2',
    rel: 'yiqishard/出门',
    mode: 'dir-recent',
    days: 2,
    label: '出门记录',
    proposedBy: 'big-fish',
    proposedAt: new Date().toISOString(),
    votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  })
  assert.equal(proposalState(p), 'active')
})

await check('投票是幂等的（重复投不报错、不改变结果）', () => {
  const p = normalizeProposal({
    id: 'trip-3', rel: 'yiqishard/出门', mode: 'file',
    proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
    votes: { 'big-fish': 'yes' },
  })
  const r1 = castVote([p], 'trip-3', 'small-fish')
  assert.equal(r1.changed, true)
  assert.equal(proposalState(r1.proposals[0]), 'active')

  // 再投一次
  const r2 = castVote(r1.proposals, 'trip-3', 'small-fish')
  assert.equal(r2.changed, false)
  assert.ok(typeof r2.error === 'string')
})

await check('🔴 过期提案自动失效（「临时」就该是临时的）', () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const p = normalizeProposal({
    id: 'trip-exp',
    rel: 'yiqishard/出门',
    mode: 'file',
    proposedBy: 'big-fish',
    proposedAt: new Date().toISOString(),
    expiresAt: past,
    votes: { 'big-fish': 'yes', 'small-fish': 'yes' },  // 两票也救不回来
  })
  assert.equal(proposalState(p), 'expired')

  // 生效目标里不该有它
  const active = resolveActiveTargets([p])
  assert.equal(active.length, 0, '过期提案不该出现在生效目标里')
})

await check('没写 expiresAt = 长期有效', () => {
  const p = normalizeProposal({
    id: 'perm-1', rel: 'yiqishard/知识', mode: 'file',
    proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
    votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  })
  assert.equal(p.expiresAt, null)
  assert.equal(proposalState(p), 'active')
})

process.stdout.write('\n── ③ 合并：并集，不是覆盖 ──\n')

await check('🔴 两端各提一个不同提案 → 两个都在', () => {
  // 这是最容易做错的地方：按 mtime 谁新谁赢会**整个覆盖**掉对方，
  // 两端的提案互相打架，永远投不齐票。（和 2026-10-22 单文件交接板丢两条同源）
  const mine = [{
    id: 'trip-a', rel: 'yiqishard/出门', mode: 'dir-recent', days: 2,
    label: '我的', proposedBy: 'big-fish', proposedAt: '2026-10-23T10:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes' },
  }]
  const theirs = [{
    id: 'trip-b', rel: 'yiqishard/旅行', mode: 'file',
    label: '她的', proposedBy: 'small-fish', proposedAt: '2026-10-23T11:00:00Z',
    expiresAt: null, votes: { 'small-fish': 'yes' },
  }]
  const merged = mergeProposals(mine, theirs)
  assert.equal(merged.length, 2, `两条提案都该在，实际 ${merged.length} 条`)
  assert.ok(merged.some((p) => p.id === 'trip-a'))
  assert.ok(merged.some((p) => p.id === 'trip-b'))
})

await check('🔴 同一个提案两端各投一票 → 合并后变成两票、生效', () => {
  const mine = [{
    id: 'trip-c', rel: 'yiqishard/出门', mode: 'file', label: '出门',
    proposedBy: 'big-fish', proposedAt: '2026-10-23T10:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes' },
  }]
  const theirs = [{
    id: 'trip-c', rel: 'yiqishard/出门', mode: 'file', label: '出门',
    proposedBy: 'big-fish', proposedAt: '2026-10-23T10:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  }]
  const merged = mergeProposals(mine, theirs)
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].votes, { 'big-fish': 'yes', 'small-fish': 'yes' })
  assert.equal(proposalState(merged[0]), 'active')
})

await check('🔴 同 id 但路径不同 → 标成冲突，不生效（别悄悄覆盖）', () => {
  const mine = [{
    id: 'dup', rel: 'yiqishard/出门', mode: 'file', label: 'A',
    proposedBy: 'big-fish', proposedAt: '2026-10-23T10:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  }]
  const theirs = [{
    id: 'dup', rel: 'yiqishard/旅行', mode: 'file', label: 'B',
    proposedBy: 'small-fish', proposedAt: '2026-10-23T11:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  }]
  const merged = mergeProposals(mine, theirs)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].conflict, true, '同名不同路径必须标冲突')
  // 即使两票也不该生效 —— 因为不知道该同步哪个路径
  const active = resolveActiveTargets(merged)
  assert.equal(active.length, 0, '冲突提案不许生效')
})

await check('合并是幂等的（来回同步会收敛）', () => {
  const a = [{
    id: 'x', rel: 'yiqishard/出门', mode: 'file', label: 'x',
    proposedBy: 'big-fish', proposedAt: '2026-10-23T10:00:00Z',
    expiresAt: null, votes: { 'big-fish': 'yes' },
  }]
  const once = mergeProposals(a, a)
  const twice = mergeProposals(once, a)
  assert.deepEqual(once, twice, '重复合并结果必须一样，否则两端永远收敛不了')
})

await check('🔴 两端各自合并同一提案 → 字节必须完全相同', () => {
  // 2026-10-23 抓到的真 bug：
  //
  //   votes 是对象，`{ ...prev.votes, ...p.votes }` 的键顺序**取决于合并顺序**。
  //   我这边先 absorb 我的 → {big-fish, small-fish}
  //   她那边先 absorb 她的 → {small-fish, big-fish}
  //
  //   内容等价，但 JSON.stringify 出来的**字节不同 → sha256 不同**
  //   → 每次同步都认为 targets.json 变了，来回推，可能永远不收敛。
  //
  // 判据：模拟两端各自合并，落盘字节必须一致。
  const base = {
    id: 'trip-x', rel: 'yiqishard/出门', mode: 'dir-recent', days: 3,
    label: '出门', proposedBy: 'big-fish', proposedAt: '2026-10-23T12:55:00.000Z',
    expiresAt: null,
  }
  // 我这边：本地有我的票，从对端拉到她的票
  const mergedByMe = mergeProposals(
    [{ ...base, votes: { 'big-fish': 'yes' } }],
    [{ ...base, votes: { 'small-fish': 'yes' } }],
  )
  // 她那边：本地有她的票，从对端拉到我的票
  const mergedByHer = mergeProposals(
    [{ ...base, votes: { 'small-fish': 'yes' } }],
    [{ ...base, votes: { 'big-fish': 'yes' } }],
  )

  const me = JSON.stringify({ version: 1, proposals: mergedByMe }, null, 2)
  const her = JSON.stringify({ version: 1, proposals: mergedByHer }, null, 2)

  assert.equal(
    me, her,
    '两端合并后字节必须完全相同，否则同步永远收敛不了。\n'
    + `  我这边 votes: ${JSON.stringify(mergedByMe[0].votes)}\n`
    + `  她那边 votes: ${JSON.stringify(mergedByHer[0].votes)}`,
  )
  // 顺带确认键确实排了序
  assert.deepEqual(Object.keys(mergedByMe[0].votes), ['big-fish', 'small-fish'])
})

process.stdout.write('\n── ④ 加提案 / 撤销 ──\n')

await check('加提案：提出方自动投一票，状态是待投票', () => {
  const r = addProposal([], {
    id: 'trip-new', rel: 'yiqishard/出门', mode: 'dir-recent', days: 2, label: '出门',
  }, 'big-fish')
  assert.ok(r.proposal !== null)
  assert.deepEqual(r.proposal.votes, { 'big-fish': 'yes' })
  assert.equal(proposalState(r.proposal), 'pending')
})

await check('加提案：id 重复要拒', () => {
  const r1 = addProposal([], { id: 'dup2', rel: 'yiqishard/出门', mode: 'file' }, 'big-fish')
  const r2 = addProposal(r1.proposals, { id: 'dup2', rel: 'yiqishard/旅行', mode: 'file' }, 'small-fish')
  assert.equal(r2.proposal, null)
  assert.ok(typeof r2.error === 'string')
})

await check('🔴 加提案：rel 不在白名单要拒（错误信息要说清）', () => {
  const r = addProposal([], { id: 'bad', rel: '.ssh/id_rsa', mode: 'file' }, 'big-fish')
  assert.equal(r.proposal, null)
  assert.ok(r.error.includes('顶层目录'), `错误信息应说清原因，实际：${r.error}`)
})

await check('加提案：days 超范围会被夹到 1-30', () => {
  const r1 = addProposal([], { id: 'd1', rel: 'yiqishard/x', mode: 'dir-recent', days: 99999 }, 'big-fish')
  assert.equal(r1.proposal.days, 30, 'days 上限 30')
  const r2 = addProposal([], { id: 'd2', rel: 'yiqishard/y', mode: 'dir-recent', days: -5 }, 'big-fish')
  assert.equal(r2.proposal.days, 1, 'days 下限 1')
})

process.stdout.write('\n── ⑤ 落盘与读回（含坏文件容错）──\n')

await check('写进去能读回来', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-'))
  try {
    const p = normalizeProposal({
      id: 'rt', rel: 'yiqishard/出门', mode: 'file', label: '往返',
      proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
    })
    await writeTargetsFile(home, { proposals: [p] })
    const back = await readTargetsFile(home)
    assert.equal(back.proposals.length, 1)
    assert.equal(back.proposals[0].id, 'rt')
    assert.equal(back.proposals[0].rel, 'yiqishard/出门')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('🔴 文件坏了 → 返回空清单，不抛（同步不能因为坏文件停摆）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-bad-'))
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })
    await writeFile(join(home, 'fish-sync', 'targets.json'), '{ 这不是 JSON', 'utf8')
    const back = await readTargetsFile(home)
    assert.deepEqual(back.proposals, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('🔴 文件里混着非法提案 → 丢弃非法的，保留合法的', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-mix-'))
  try {
    await mkdir(join(home, 'fish-sync'), { recursive: true })
    await writeFile(join(home, 'fish-sync', 'targets.json'), JSON.stringify({
      version: 1,
      proposals: [
        { id: 'good', rel: 'yiqishard/出门', mode: 'file', proposedBy: 'big-fish' },
        { id: 'evil', rel: '.ssh/id_rsa', mode: 'file', proposedBy: 'big-fish' },  // 越权
        { id: 'BAD ID!!', rel: 'yiqishard/x', mode: 'file' },                       // id 非法
        'not-an-object',
      ],
    }), 'utf8')
    const back = await readTargetsFile(home)
    assert.equal(back.proposals.length, 1, `只该留 1 条合法提案，实际 ${back.proposals.length}`)
    assert.equal(back.proposals[0].id, 'good')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ⑥ 生效目标真的能变成同步范围 ──\n')

await check('🔴 提案生效后，resolveAllowedKey 认得那个路径', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-active-'))
  try {
    const cfg = normalizeConfig({ identity: 'big-fish' }, home)

    // 没提案时：出门目录不该被允许
    assert.equal(await resolveAllowedKey(cfg, 'yiqishard/出门/2026-10-24.md'), null,
      '没提案时不该允许')

    // 造一条已生效的提案
    const p = normalizeProposal({
      id: 'trip', rel: 'yiqishard/出门', mode: 'dir-recent', days: 2, label: '出门',
      proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
      votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
    })
    cfg.targets = [...cfg.targets, ...resolveActiveTargets([p])]

    // 现在应该认得
    const key = await resolveAllowedKey(cfg, 'yiqishard/出门/2026-10-24.md')
    assert.equal(key, 'yiqishard/出门/2026-10-24.md', '生效提案的路径应被允许')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('🔴 就算提案生效了，paired.json 依然被拒（密钥不许出门）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-key-'))
  try {
    const cfg = normalizeConfig({ identity: 'big-fish' }, home)
    // 模拟有人恶意提案要同步整个 fish-sync 目录
    const evil = normalizeProposal({
      id: 'evil-dir', rel: 'fish-sync', mode: 'dir-recent', days: 30, label: '恶意',
      proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
      votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
    })
    // 注意：'fish-sync' 本身在 ALLOWED_ROOTS 里，所以提案能过
    assert.ok(evil !== null, '（前提）fish-sync 在根白名单里，提案本身能过')

    cfg.targets = [...cfg.targets, ...resolveActiveTargets([evil])]

    // 但 paired.json 必须依然被拒 —— 这是最后一道闸
    const key = await resolveAllowedKey(cfg, 'fish-sync/paired.json')
    assert.equal(key, null, '🔴 长期密钥永远不许同步，哪怕提案生效了')

    // diag.json 同理
    assert.equal(await resolveAllowedKey(cfg, 'fish-sync/diag.json'), null)

    // 而 targets.json 本身要能过（不然两端投票投不到一起）
    assert.equal(await resolveAllowedKey(cfg, 'fish-sync/targets.json'), 'fish-sync/targets.json')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('isDeniedKey 直接判（给测试与审计用）', () => {
  assert.equal(isDeniedKey('fish-sync/paired.json'), true)
  assert.equal(isDeniedKey('fish-sync/diag.json'), true)
  assert.equal(isDeniedKey('yiqishard/交接/大肥鱼.md.bak-20261022'), true)
  assert.equal(isDeniedKey('yiqishard/memory/.history/2026-10-23.md'), true)
  assert.equal(isDeniedKey('node_modules/x/index.js'), true)
  assert.equal(isDeniedKey('yiqishard/信箱/大肥鱼.md'), false)
})

process.stdout.write('\n── ⑦ getter 不许被展开成快照（2026-10-23 真 bug）──\n')

await check('🔴 `{ ...cfg }` 之后动态目标还能不能跟着变', async () => {
  // ## 这个 bug 怎么来的
  //
  // `attachDynamicTargets` 把 `cfg.targets` 装成 **getter**
  // （返回「内置 + 当前生效的提案」）。
  //
  // 但 server 启动时写的是：
  //
  //     const serverCfg = { ...cfg, get token() { ... } }
  //
  // **`{ ...cfg }` 会把 getter 展开成快照数组！**
  // 而 server 启动时 proposals 还是空的（`reloadProposals` 异步，apply 末尾才读盘），
  // 于是 `serverCfg.targets` 被**冻结成「只有内置目标」**。
  //
  // 后果：提案在 server 侧永远不生效，`resolveAllowedKey` 永远拒 → 推文件 403。
  //
  // 表现特别迷惑：`/api/state` 里 `targets` 明明显示了提案来的目标
  // （state() 读的是原 cfg.targets，getter 有效），但实际推文件 403。
  // **「显示有、实际没有」** —— 比直接报错更难查。
  //
  // 修法：serverCfg 也要显式包一层 getter 转发到原 cfg。
  const home = await mkdtemp(join(tmpdir(), 'fish-tg-getter-'))
  try {
    const cfg = normalizeConfig({ identity: 'big-fish' }, home)

    // 模拟「运行时才有提案」：一开始是空的
    let proposals = []
    attachDynamicTargets(cfg, () => resolveActiveTargets(proposals))

    // 错误写法：展开成快照（server 原来就是这样）
    const snapshotCfg = { ...cfg }

    // 正确写法：显式转发 getter
    const liveCfg = { ...cfg, get targets() { return cfg.targets } }

    // 此刻还没有提案，两者都只看到内置目标
    assert.equal(snapshotCfg.targets.length, cfg.targets.length)
    assert.equal(liveCfg.targets.length, cfg.targets.length)

    // ── 现在「运行时」加了一条已生效的提案 ──
    proposals = [normalizeProposal({
      id: 'trip-late', rel: 'yiqishard/出门', mode: 'dir-recent', days: 3,
      label: '出门', proposedBy: 'big-fish', proposedAt: new Date().toISOString(),
      votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
    })]

    // 原 cfg 看得到（getter 有效）
    assert.ok(
      cfg.targets.some((t) => t.id === 'trip-late'),
      '原 cfg.targets 应该看到新提案',
    )
    // 正确写法也看得到
    assert.ok(
      liveCfg.targets.some((t) => t.id === 'trip-late'),
      '🔴 显式转发 getter 的 cfg 必须看到新提案',
    )
    // 错误写法看不到 —— 这就是 bug 的形态
    assert.equal(
      snapshotCfg.targets.some((t) => t.id === 'trip-late'), false,
      '（这是 bug 的形态）展开成快照的 cfg 看不到后加的提案 —— 所以才要 getter',
    )

    // ── 端到端：用正确写法，resolveAllowedKey 要能放行 ──
    const allowed = await resolveAllowedKey(liveCfg, 'yiqishard/出门/2026-10-23.md')
    assert.equal(allowed, 'yiqishard/出门/2026-10-23.md', '运行时加的提案必须能同步')

    // 用错误写法，必须被拒 —— 证明这个 bug 是真的会挡住同步
    const denied = await resolveAllowedKey(snapshotCfg, 'yiqishard/出门/2026-10-23.md')
    assert.equal(denied, null, '（这是 bug 的形态）快照版会拒掉运行时加的提案')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

process.stdout.write('\n── ⑨ 撤回是「立碑」，不是删除（2026-10-24 修）──\n')

/**
 * 这一节守的是 2026-10-24 当天真实踩到的坑。
 *
 * ## 事故经过
 *
 * 主人让小肥鱼和大肥鱼「日记先别互相看」，两边都要撤掉那两条用过的提案。
 * 结果：**两边各撤一半，四条提案全部复活，而且没有任何报错。**
 *
 * ## 根因（三条，都在这一节被判据钉住）
 *
 * ① **撤回是「删除」而不是「立碑」** —— 合并是纯并集，删了本端那份，
 *    对端那份下次同步又带回来。**删除不可传播。**
 * ② **只有提出方能撤** —— 方向反了。扩边界要两端同意，收缩不该被卡住。
 * ③ 撤回的提案还能被投票、还能被 `resolveActiveTargets` 收进去。
 *
 * 每条都配反向用例：**修复不许把正常（没撤过的）提案搞坏。**
 */

const mkP = (over = {}) => normalizeProposal({
  id: 't-demo',
  rel: 'yiqishard/出门',
  mode: 'dir-recent',
  days: 3,
  label: '出门',
  proposedBy: 'big-fish',
  proposedAt: new Date('2026-10-24T10:00:00.000Z').toISOString(),
  votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  ...over,
})

await check('🔴 撤回 = 立碑（数组长度不变，状态转 withdrawn）', () => {
  const p = mkP()
  assert.equal(proposalState(p), 'active', '前提：没撤之前是生效的')

  const r = withdrawProposal([p], 't-demo', 'big-fish')
  assert.equal(r.changed, true)
  assert.equal(r.proposals.length, 1, '撤回不是删除 —— 数组长度必须不变，碑得留着')
  assert.equal(proposalState(r.proposals[0]), 'withdrawn')
})

await check('🔴🔴 撤回能传播：对端那份没碑，也不许把它救回来', () => {
  const mine = withdrawProposal([mkP()], 't-demo', 'big-fish').proposals
  const theirs = [mkP()]   // 对端还没收到碑（正是当天的情况）

  const merged = mergeProposals(mine, theirs)
  assert.equal(merged.length, 1)
  assert.notEqual(
    merged[0].withdrawn ?? null, null,
    '🔴 碑必须活下来 —— 这就是「删除不可传播」的修法',
  )
  assert.equal(proposalState(merged[0]), 'withdrawn', '合并之后仍然不生效')

  // 反向：没碑的那份单独合并，必须还是 active（别把正常路径搞坏）
  const normal = mergeProposals([mkP()], [mkP()])
  assert.equal(proposalState(normal[0]), 'active')
})

await check('🔴 谁能撤：任一端单方面都能撤（不被提出方卡住）', () => {
  const p = mkP({ proposedBy: 'big-fish' })
  // 小肥鱼不是提出方，当天她撤不掉，只能写信求人
  const r = withdrawProposal([p], 't-demo', 'small-fish')
  assert.equal(r.changed, true, '收缩边界是安全方向，不该被对方卡住')
  assert.equal(r.proposals[0].withdrawn.by, 'small-fish', '碑要记是谁立的')
})

await check('撤回的提案不能再投票', () => {
  const r = withdrawProposal([mkP()], 't-demo', 'big-fish')
  const v = castVote(r.proposals, 't-demo', 'small-fish')
  assert.equal(v.changed, false)
  assert.match(v.error ?? '', /已撤回/)
})

await check('撤回的提案不进 resolveActiveTargets', () => {
  const r = withdrawProposal([mkP()], 't-demo', 'big-fish')
  const active = resolveActiveTargets(r.proposals)
  assert.equal(active.length, 0, '碑立了就不该再产生同步目标')
})

await check('🪦 两边都立碑 → 取更晚的那块（后撤的覆盖先撤的）', () => {
  const early = { by: 'big-fish', at: '2026-10-24T11:00:00.000Z' }
  const late = { by: 'small-fish', at: '2026-10-24T12:00:00.000Z' }
  const merged = mergeProposals([mkP({ withdrawn: late })], [mkP({ withdrawn: early })])
  assert.equal(merged[0].withdrawn.at, late.at, '碑要取时间更晚的')
  assert.equal(merged[0].withdrawn.by, 'small-fish')
})

await check('🪦 撤回后「重新提议」→ 新的提议时间盖过碑，重新生效', () => {
  const withdrawn = withdrawProposal([mkP()], 't-demo', 'big-fish').proposals
  // 重新 add 同一个 id（时间更晚）
  const re = addProposal(withdrawn, {
    id: 't-demo', rel: 'yiqishard/出门', mode: 'dir-recent', days: 3, label: '出门',
  }, 'small-fish')
  assert.equal(re.proposal !== null, true, '墓碑上的 id 应该允许重新提议')

  const again = normalizeProposal({
    ...re.proposals[0],
    proposedAt: new Date(Date.now() + 3600000).toISOString(),  // 晚于碑（动态，不会过期）
    votes: { 'big-fish': 'yes', 'small-fish': 'yes' },
  })
  assert.equal(proposalState(again), 'active', '新提议时间晚于碑 → 重新生效')

  // 反向：如果提议时间**早于**碑，仍然算撤回
  const old = normalizeProposal({
    ...again,
    proposedAt: new Date('2026-10-24T09:00:00.000Z').toISOString(),  // 早于碑
  })
  assert.equal(proposalState(old), 'withdrawn', '早于碑的提议盖不过碑')
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
