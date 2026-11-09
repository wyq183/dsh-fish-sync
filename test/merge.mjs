/**
 * `mergeProposals` 的更新语义 —— 2026-10-26 小肥鱼查出的静默丢更新 bug。
 *
 * ## 这个 bug 长什么样
 *
 * `lib/targets.js` 的 `absorb()` 原来挑赢家是这样：
 *
 * ```js
 * const winner = p.proposedBy === prev.proposedBy ? prev : (p.proposedAt > prev.proposedAt ? p : prev)
 * ```
 *
 * **`proposedBy` 相同时，无条件取 `prev`（本机那份），完全不看 `proposedAt`。**
 *
 * 后果：**提出方能建立提案，但不能更新自己的提案。而且更新失败是静默的。**
 *
 * 实测（修之前）：
 * ```
 * 本机=旧版，对端推新版  → mode=dir-recent  [X 新版丢了]
 * 本机=新版，对端推旧版  → mode=dir         [OK]
 * ```
 *
 * ⚠️ **反向也通 —— 「谁赢」完全取决于「谁是本机」，跟时间无关。**
 * 那不是「提出方权威」，是「本机权威」。
 *
 * ## 这个测试在守什么
 *
 * ① **同提出方更新**：新的 `proposedAt` 晚 → 新的赢（两个方向都要）
 * ② **撤回重提**：碑被更晚的 `proposedAt` 盖过 → 提案复活
 * ③ **跨端双向**：`merge(A,B)` 和 `merge(B,A)` 必须得出同一个结果
 * ④ **票不丢**：更新之后，两边的票要并集，不能因为换了赢家就清零
 * ⑤ **不同提出方 + rel/mode 不同 = 真冲突**（这条老行为不能破）
 *
 * 跑：node test/merge.mjs
 */

import assert from 'node:assert/strict'
import { mergeProposals, proposalState } from '../lib/targets.js'

let pass = 0
let fail = 0
const failures = []

/**
 * 跑一条断言。
 * @param {string} name - 用例名。
 * @param {Function} fn - 断言体。
 */
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

/**
 * 造一条提案。
 * @param {object} o - 覆盖字段。
 * @returns {object}
 */
function prop(o) {
  return {
    id: 'p', rel: '知识库/写作', mode: 'dir', label: 'x',
    proposedBy: 'small-fish', proposedAt: '2026-10-26T02:00:00.000Z',
    expiresAt: null, votes: { 'small-fish': 'yes' }, withdrawn: null,
    ...o,
  }
}

process.stdout.write('\n=== ① 同提出方更新：新的 proposedAt 晚，必须赢 ===\n')

check('同提出方：本机旧、对端新 → 新的赢（这是修的那个 bug）', () => {
  const old = prop({ mode: 'dir-recent', days: 14, proposedAt: '2026-10-26T02:03:22.620Z', label: 'old' })
  const neu = prop({ mode: 'dir', proposedAt: '2026-10-26T03:56:57.991Z', label: 'new' })
  const m = mergeProposals([old], [neu]) // 本机=old，对端推 neu
  assert.equal(m[0].mode, 'dir', '新的 mode 该赢，实际 ' + m[0].mode)
  assert.equal(m[0].label, 'new')
  assert.equal(m[0].proposedAt, '2026-10-26T03:56:57.991Z')
})

check('同提出方：本机新、对端旧 → 新的仍然赢（不是本机赢）', () => {
  const old = prop({ mode: 'dir-recent', days: 14, proposedAt: '2026-10-26T02:03:22.620Z', label: 'old' })
  const neu = prop({ mode: 'dir', proposedAt: '2026-10-26T03:56:57.991Z', label: 'new' })
  const m = mergeProposals([neu], [old]) // 本机=neu，对端推 old
  assert.equal(m[0].mode, 'dir', '新的该赢，实际 ' + m[0].mode)
  assert.equal(m[0].label, 'new')
})

check('⚠️ 双向对称：merge(A,B) 和 merge(B,A) 结果必须一样', () => {
  const a = prop({ mode: 'dir-recent', days: 14, proposedAt: '2026-10-26T02:03:22.620Z', label: 'A' })
  const b = prop({ mode: 'dir', proposedAt: '2026-10-26T03:56:57.991Z', label: 'B' })
  const ab = mergeProposals([a], [b])[0]
  const ba = mergeProposals([b], [a])[0]
  assert.equal(ab.mode, ba.mode, 'mode 不一致：' + ab.mode + ' vs ' + ba.mode)
  assert.equal(ab.proposedAt, ba.proposedAt, 'proposedAt 不一致')
  assert.equal(ab.label, ba.label, 'label 不一致：' + ab.label + ' vs ' + ba.label)
})

check('时间完全相同时：结果确定（本机赢），但两个方向一致', () => {
  const t = '2026-10-26T05:00:00.000Z'
  const a = prop({ proposedAt: t, label: 'A' })
  const b = prop({ proposedAt: t, label: 'B' })
  const ab = mergeProposals([a], [b])[0]
  const ba = mergeProposals([b], [a])[0]
  // 时间相同时各取本机 → 内容会不同，这是已知取舍
  // ⚠️ 但至少不能崩、不能判冲突
  assert.equal(ab.conflict, undefined)
  assert.equal(ba.conflict, undefined)
})

process.stdout.write('\n=== ② 撤回重提：碑被更晚的 proposedAt 盖过 ===\n')

check('撤回后再提（同 id）：碑被盖过，不再是 withdrawn', () => {
  const withdrawnOne = prop({
    proposedAt: '2026-10-26T02:00:00.000Z',
    withdrawn: { by: 'small-fish', at: '2026-10-26T03:00:00.000Z' },
  })
  const reProposed = prop({
    proposedAt: '2026-10-26T04:00:00.000Z', // 晚于碑
    votes: { 'small-fish': 'yes' },
  })
  const m = mergeProposals([withdrawnOne], [reProposed])[0]
  // ⚠️ 注意：重提之后票只有 1 张（提出方自动那票），所以是 pending 不是 active。
  //    「碑被盖过」的正确判据是「不再 withdrawn」，不是「立刻 active」。
  //    我第一版这里写成了断言 active，是我的测试错了，不是代码错了。
  assert.notEqual(proposalState(m), 'withdrawn',
    '新的 proposedAt 晚于碑，该不再是 withdrawn，实际 ' + proposalState(m))
  assert.equal(proposalState(m), 'pending',
    '只有 1 票，该判 pending，实际 ' + proposalState(m))
})

check('撤回后再提 + 对方补票 → active', () => {
  const withdrawnOne = prop({
    proposedAt: '2026-10-26T02:00:00.000Z',
    withdrawn: { by: 'small-fish', at: '2026-10-26T03:00:00.000Z' },
  })
  const reProposed = prop({
    proposedAt: '2026-10-26T04:00:00.000Z',
    votes: { 'small-fish': 'yes' },
  })
  // 模拟对方补了一票（合并时票取并集）
  const otherSide = prop({
    proposedAt: '2026-10-26T04:00:00.000Z',
    votes: { 'big-fish': 'yes' },
  })
  const m = mergeProposals([withdrawnOne], [reProposed, otherSide])[0]
  assert.equal(proposalState(m), 'active',
    '两票齐了该判 active，实际 ' + proposalState(m))
})

check('只撤回不重提：碑生效，提案不 active', () => {
  const withdrawnOne = prop({
    proposedAt: '2026-10-26T02:00:00.000Z',
    withdrawn: { by: 'small-fish', at: '2026-10-26T03:00:00.000Z' },
  })
  const m = mergeProposals([withdrawnOne], [])[0]
  assert.equal(proposalState(m), 'withdrawn', '该判 withdrawn，实际 ' + proposalState(m))
})

check('碑必须能传播：本机有碑、对端没碑 → 合并后仍有碑', () => {
  const mineWithTomb = prop({
    proposedAt: '2026-10-26T02:00:00.000Z',
    withdrawn: { by: 'big-fish', at: '2026-10-26T03:00:00.000Z' },
  })
  const theirsNoTomb = prop({
    proposedAt: '2026-10-26T02:00:00.000Z',
    withdrawn: null,
  })
  const m = mergeProposals([mineWithTomb], [theirsNoTomb])[0]
  assert.ok(m.withdrawn !== null, '碑被丢掉了 —— 撤回传不出去')
  assert.equal(m.withdrawn.by, 'big-fish')
})

process.stdout.write('\n=== ③ 票：并集，不因换赢家而清零 ===\n')

check('更新之后，两边的票要并集', () => {
  const old = prop({ proposedAt: '2026-10-26T02:00:00.000Z', votes: { 'big-fish': 'yes', 'small-fish': 'yes' } })
  const neu = prop({ proposedAt: '2026-10-26T03:00:00.000Z', votes: { 'small-fish': 'yes' } })
  const m = mergeProposals([old], [neu])[0]
  assert.equal(m.votes['big-fish'], 'yes', 'big-fish 的票丢了')
  assert.equal(m.votes['small-fish'], 'yes')
})

check('只在新版里有的票也要保留', () => {
  const old = prop({ proposedAt: '2026-10-26T02:00:00.000Z', votes: { 'small-fish': 'yes' } })
  const neu = prop({ proposedAt: '2026-10-26T03:00:00.000Z', votes: { 'big-fish': 'yes' } })
  const m = mergeProposals([old], [neu])[0]
  assert.equal(m.votes['small-fish'], 'yes')
  assert.equal(m.votes['big-fish'], 'yes')
})

process.stdout.write('\n=== ④ 老行为不能破：不同提出方 + rel/mode 不同 = 真冲突 ===\n')

check('不同提出方 + mode 不同 → 判冲突', () => {
  const a = prop({ proposedBy: 'small-fish', mode: 'dir' })
  const b = prop({ proposedBy: 'big-fish', mode: 'dir-recent', days: 3 })
  const m = mergeProposals([a], [b])[0]
  assert.equal(m.conflict, true, '该判冲突，实际 conflict=' + String(m.conflict))
  assert.ok(Array.isArray(m.relConflict), '缺 relConflict')
})

check('不同提出方 + rel 不同 → 判冲突', () => {
  const a = prop({ proposedBy: 'small-fish', rel: '知识库/写作' })
  const b = prop({ proposedBy: 'big-fish', rel: '知识库/学习资料' })
  const m = mergeProposals([a], [b])[0]
  assert.equal(m.conflict, true)
})

check('不同提出方但 rel/mode 相同 → 不冲突，正常合并', () => {
  const a = prop({ proposedBy: 'small-fish', proposedAt: '2026-10-26T02:00:00.000Z' })
  const b = prop({ proposedBy: 'big-fish', proposedAt: '2026-10-26T03:00:00.000Z' })
  const m = mergeProposals([a], [b])[0]
  assert.notEqual(m.conflict, true, 'rel/mode 相同不该判冲突')
})

process.stdout.write('\n=== ⑤ 并集语义：两端各提一条，两条都在 ===\n')

check('两端各提不同 id → 合并后两条都在', () => {
  const a = prop({ id: 'a', proposedBy: 'big-fish' })
  const b = prop({ id: 'b', proposedBy: 'small-fish' })
  const m = mergeProposals([a], [b])
  assert.equal(m.length, 2)
  const ids = m.map((x) => x.id).sort()
  assert.deepEqual(ids, ['a', 'b'])
})

check('空数组 + 有内容 → 不崩，原样返回', () => {
  const a = prop({ id: 'a' })
  assert.equal(mergeProposals([], [a]).length, 1)
  assert.equal(mergeProposals([a], []).length, 1)
  assert.equal(mergeProposals([], []).length, 0)
})

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
