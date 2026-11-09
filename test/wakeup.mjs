/**
 * 唤醒机制自检 —— 五条安全规则逐条验，外加「游标不被覆盖」。
 *
 * 每一条都带**阴性对照**：不光是"该唤醒时唤醒了"，
 * 还要验"不该唤醒时没唤醒"。
 *
 * 跑：node test/wakeup.mjs
 */

import assert from 'node:assert/strict'

import {
  appendOutbox,
  buildWakePrompt,
  decideWake,
  mergeOutbox,
  readLocalState,
  readOutbox,
  recordWake,
  writeLocalState,
  writeOutbox,
  DEFAULT_COOLDOWN_MS,
} from '../lib/wakeup.js'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
const failures = []

function t(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail += 1
    failures.push({ name, error: e })
    console.log(`  ✗ ${name}`)
    console.log(`      ${e?.message ?? e}`)
  }
}

async function ta(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail += 1
    failures.push({ name, error: e })
    console.log(`  ✗ ${name}`)
    console.log(`      ${e?.message ?? e}`)
  }
}

const T0 = Date.parse('2026-10-25T03:00:00.000Z')

/** 造一条 outbox 消息。 */
function msg(i, over = {}) {
  return {
    id: `m${i}`,
    to: 'big-fish',
    from: 'small-fish',
    kind: 'letter',
    createdAt: new Date(T0 + i * 1000).toISOString(),
    ...over,
  }
}

/** 造一个空的本机状态。 */
function emptyState(over = {}) {
  return { lastSeenAt: null, lastWakeAt: null, lastWakeError: null, lastCheckedIds: [], ...over }
}

console.log('\n=== 唤醒机制自检 ===\n')

console.log('① 规则1：绝不唤醒自己（防回环）')

t('自己发给自己的消息 → 不唤醒', () => {
  const outboxData = { outbox: [msg(1, { from: 'big-fish', to: 'big-fish' })] }
  const r = decideWake({ outboxData, localState: emptyState(), identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r.wake, false)
  assert.equal(r.reason, 'no-message-for-me')
})

t('发给对方的（不是我的）→ 不唤醒', () => {
  const outboxData = { outbox: [msg(1, { from: 'big-fish', to: 'small-fish' })] }
  const r = decideWake({ outboxData, localState: emptyState(), identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r.wake, false)
})

t('阳性对照：对方发给我的 → 唤醒', () => {
  const outboxData = { outbox: [msg(1)] }
  const r = decideWake({ outboxData, localState: emptyState(), identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r.wake, true)
  assert.equal(r.reason, 'new-message')
  assert.equal(r.pending.length, 1)
})

console.log('\n② 规则2：游标（同一条只唤醒一次）')

t('已经看过的消息 → 不再唤醒', () => {
  const outboxData = { outbox: [msg(1)] }
  const localState = emptyState({ lastSeenAt: new Date(T0 + 2000).toISOString() })
  const r = decideWake({ outboxData, localState, identity: 'big-fish', now: T0 + 120000 })
  assert.equal(r.wake, false)
  assert.equal(r.reason, 'already-seen')
})

t('阳性对照：比游标新的消息 → 唤醒', () => {
  const outboxData = { outbox: [msg(1), msg(5)] }
  const localState = emptyState({ lastSeenAt: new Date(T0 + 2000).toISOString() })
  const r = decideWake({ outboxData, localState, identity: 'big-fish', now: T0 + 120000 })
  assert.equal(r.wake, true)
  assert.equal(r.pending.length, 1)
  assert.equal(r.pending[0].id, 'm5')
})

console.log('\n②b 规则2b：批记忆（同一批不为它反复唤醒）')

t('🔴 这批 id 都判过了 → 不再唤醒（即使游标被外部改动）', () => {
  const outboxData = { outbox: [msg(1), msg(2)] }
  const localState = emptyState({ lastSeenAt: null, lastCheckedIds: ['m1', 'm2'] })
  const r = decideWake({ outboxData, localState, identity: 'big-fish', now: T0 + 600000 })
  assert.equal(r.wake, false)
  assert.equal(r.reason, 'batch-already-checked')
})

t('阳性对照：出现了新 id → 仍然唤醒', () => {
  const outboxData = { outbox: [msg(1), msg(2), msg(3)] }
  const localState = emptyState({ lastSeenAt: null, lastCheckedIds: ['m1', 'm2'] })
  const r = decideWake({ outboxData, localState, identity: 'big-fish', now: T0 + 600000 })
  assert.equal(r.wake, true)
  assert.equal(r.pending.length, 3)
})

console.log('\n③ 规则3：冷却（防互相刷爆）')

t('刚唤醒过，冷却期内 → 不再唤醒', () => {
  const outboxData = { outbox: [msg(1)] }
  const localState = emptyState({ lastWakeAt: new Date(T0 + 10000).toISOString() })
  const r = decideWake({ outboxData, localState, identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r.wake, false)
  assert.match(r.reason, /^cooldown/)
})

t('阳性对照：冷却期过了 → 唤醒', () => {
  const outboxData = { outbox: [msg(1)] }
  const localState = emptyState({ lastWakeAt: new Date(T0 + 10000).toISOString() })
  const r = decideWake({
    outboxData,
    localState,
    identity: 'big-fish',
    now: T0 + 10000 + DEFAULT_COOLDOWN_MS + 1000,
  })
  assert.equal(r.wake, true)
})

console.log('\n④ 规则4：一次唤醒就够（多条积压只唤醒一次）')

t('积了 3 条新消息 → 只唤醒一次，pending 是 3 条', () => {
  const outboxData = { outbox: [msg(1), msg(2), msg(3)] }
  const r = decideWake({ outboxData, localState: emptyState(), identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r.wake, true)
  assert.equal(r.pending.length, 3)
})

console.log('\n⑤ 规则5：失败不吞')

t('唤醒成功 → lastSeenAt 推进，lastWakeError 清空，id 进批记忆', () => {
  const state = emptyState({ lastWakeError: 'old-error' })
  const pending = [msg(1), msg(5)]
  recordWake(state, { ok: true, now: T0 + 60000, pending })
  assert.equal(state.lastSeenAt, new Date(T0 + 5000).toISOString())
  assert.equal(state.lastWakeError, null)
  assert.deepEqual(state.lastCheckedIds, ['m1', 'm5'])
})

t('唤醒失败 → 游标不动，错误留痕，id 不进批记忆', () => {
  const state = emptyState()
  const pending = [msg(1)]
  recordWake(state, { ok: false, now: T0 + 60000, pending, error: 'session not found' })
  assert.equal(state.lastSeenAt, null, '失败时游标必须不动，否则这条消息永远丢了')
  assert.equal(state.lastWakeError, 'session not found')
  assert.deepEqual(state.lastCheckedIds, [], '失败不算「判过」，下次还要再试')
})

console.log('\n⑥ appendOutbox / mergeOutbox')

t('正常追加一条', () => {
  const data = { outbox: [] }
  appendOutbox(data, { to: 'small-fish', from: 'big-fish', kind: 'letter', payload: { note: 'x' } }, T0)
  assert.equal(data.outbox.length, 1)
  assert.equal(data.outbox[0].payload.note, 'x')
})

t('同一条重复追加 → 去重', () => {
  const data = { outbox: [] }
  const m = { to: 'small-fish', from: 'big-fish', kind: 'letter' }
  appendOutbox(data, m, T0)
  appendOutbox(data, m, T0)
  assert.equal(data.outbox.length, 1)
})

t('缺 to 或 from → 拒绝', () => {
  const data = { outbox: [] }
  appendOutbox(data, { from: 'big-fish' }, T0)
  appendOutbox(data, { to: 'small-fish' }, T0)
  assert.equal(data.outbox.length, 0)
})

t('🔴 mergeOutbox 是纯并集（不丢任何一端）', () => {
  const mine = [msg(1), msg(2)]
  const theirs = [msg(2), msg(3)]
  const merged = mergeOutbox(mine, theirs)
  assert.equal(merged.length, 3, '并集应该有 3 条（m1/m2/m3）')
  assert.deepEqual(merged.map((m) => m.id), ['m1', 'm2', 'm3'])
})

t('🔴 mergeOutbox 阴性：一方为空 → 保留另一方全部', () => {
  assert.equal(mergeOutbox([msg(1)], []).length, 1)
  assert.equal(mergeOutbox([], [msg(2)]).length, 1)
  assert.equal(mergeOutbox([], []).length, 0)
})

console.log('\n⑦ 持久化（读 / 写 / 损坏容错）')

await ta('outbox 写进去再读出来，内容一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakeup-test-'))
  const file = path.join(dir, 'wakeup-outbox.json')
  const data = { outbox: [] }
  appendOutbox(data, { to: 'small-fish', from: 'big-fish', kind: 'letter' }, T0)
  await writeOutbox(file, data)
  const back = await readOutbox(file)
  assert.equal(back.outbox.length, 1)
  assert.equal(back.outbox[0].from, 'big-fish')
  await fs.rm(dir, { recursive: true, force: true })
})

await ta('本机状态写进去再读出来，内容一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakeup-test-'))
  const file = path.join(dir, 'wakeup-state-big-fish.json')
  const state = emptyState({ lastSeenAt: new Date(T0).toISOString(), lastCheckedIds: ['m1'] })
  await writeLocalState(file, state)
  const back = await readLocalState(file)
  assert.equal(back.lastSeenAt, new Date(T0).toISOString())
  assert.deepEqual(back.lastCheckedIds, ['m1'])
  await fs.rm(dir, { recursive: true, force: true })
})

await ta('文件不存在 → 返回空骨架，不抛', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakeup-test-'))
  const ob = await readOutbox(path.join(dir, 'nope.json'))
  const st = await readLocalState(path.join(dir, 'nope2.json'))
  assert.deepEqual(ob.outbox, [])
  assert.equal(st.lastSeenAt, null)
  await fs.rm(dir, { recursive: true, force: true })
})

await ta('文件损坏（半截 JSON）→ 返回空骨架，不抛', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakeup-test-'))
  const f1 = path.join(dir, 'broken1.json')
  const f2 = path.join(dir, 'broken2.json')
  await fs.writeFile(f1, '{"outbox": [{"id":', 'utf8')
  await fs.writeFile(f2, '{"lastSeenAt":', 'utf8')
  assert.deepEqual((await readOutbox(f1)).outbox, [])
  assert.equal((await readLocalState(f2)).lastSeenAt, null)
  await fs.rm(dir, { recursive: true, force: true })
})

console.log('\n⑧ prompt 文本')

t('单方来信 → prompt 里有对方名字', () => {
  const p = buildWakePrompt({ pending: [{ from: 'small-fish' }] })
  assert.match(p, /small-fish/)
  assert.match(p, /fish_sync_now/)
})

t('多方来信 → 名字都列出来', () => {
  const p = buildWakePrompt({ pending: [{ from: 'small-fish' }, { from: 'big-fish' }] })
  assert.match(p, /small-fish/)
  assert.match(p, /big-fish/)
})

console.log('\n⑨ 端到端：来信 → 唤醒 → 回信 循环')

t('A 写信给 B → B 被唤醒 → 游标推进 → 再判不重复唤醒', () => {
  const dataA = { outbox: [] }
  appendOutbox(dataA, { to: 'small-fish', from: 'big-fish', kind: 'letter' }, T0)

  const dataB = { outbox: mergeOutbox([], dataA.outbox) }
  const stateB = emptyState()

  const r1 = decideWake({ outboxData: dataB, localState: stateB, identity: 'small-fish', now: T0 + 60000 })
  assert.equal(r1.wake, true, 'B 应该被唤醒')

  recordWake(stateB, { ok: true, now: T0 + 60000, pending: r1.pending })

  const r2 = decideWake({ outboxData: dataB, localState: stateB, identity: 'small-fish', now: T0 + 600000 })
  assert.equal(r2.wake, false, '同一条消息不能唤醒两次')
  assert.equal(r2.reason, 'already-seen')

  const rA = decideWake({ outboxData: dataA, localState: emptyState(), identity: 'big-fish', now: T0 + 60000 })
  assert.equal(rA.wake, false, 'A 不能被自己发的消息唤醒')
})

console.log('\n⑩ 🔴 死循环回归（2026-10-25 小肥鱼抓到的那次）')

t('同步覆盖 outbox 后，不能因为老消息再次唤醒', () => {
  // 场景复现：
  //  1. B 收到 A 的消息，被唤醒，游标推进
  //  2. B 再跑同步，outbox 被对端版本合并（并集，内容不变）
  //  3. 关键：游标在**独立文件**里，同步动不到它
  //  4. 所以再判一次，仍然是 already-seen
  const dataB = { outbox: [msg(1)] }
  const stateB = emptyState()

  const r1 = decideWake({ outboxData: dataB, localState: stateB, identity: 'big-fish', now: T0 + 60000 })
  assert.equal(r1.wake, true)
  recordWake(stateB, { ok: true, now: T0 + 60000, pending: r1.pending })

  const dataBAfterSync = { outbox: mergeOutbox(dataB.outbox, dataB.outbox) }
  assert.equal(dataBAfterSync.outbox.length, 1, '并集后还是 1 条')

  const r2 = decideWake({
    outboxData: dataBAfterSync,
    localState: stateB,
    identity: 'big-fish',
    now: T0 + 600000,
  })
  assert.equal(r2.wake, false, '🔴 游标在独立文件里，同步动不到它 → 不该重复唤醒')
})

t('极端情况：游标被外力重置成 null，批记忆仍然兜住', () => {
  const dataB = { outbox: [msg(1), msg(2)] }
  const stateB = emptyState()

  const r1 = decideWake({ outboxData: dataB, localState: stateB, identity: 'big-fish', now: T0 + 60000 })
  recordWake(stateB, { ok: true, now: T0 + 60000, pending: r1.pending })

  // 模拟游标被抹掉（比如文件被删了）
  stateB.lastSeenAt = null

  const r2 = decideWake({ outboxData: dataB, localState: stateB, identity: 'big-fish', now: T0 + 600000 })
  assert.equal(r2.wake, false, '批记忆应该拦住重复唤醒')
  assert.equal(r2.reason, 'batch-already-checked')
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`)

if (fail > 0) {
  for (const f of failures) {
    console.log(`FAIL: ${f.name}`)
    console.log(f.error?.stack ?? f.error)
  }
  process.exit(1)
}
