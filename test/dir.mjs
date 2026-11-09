/**
 * `dir` 模式 —— 目录下所有文件，不看文件名，递归。
 *
 * ## 为什么加这个测试
 *
 * 2026-10-26 早上，小肥鱼把三份文档搬进 `$DSH_HOME/知识库/写作/`：
 *   `视频模板.md` / `判据集-今晚撞出来的.md` / `我回复得好的是什么样.md`
 * `ls` 看得见、字节数对得上，但两端 manifest 里都是 **0 个**。
 *
 * 我们两个人猜了一小时：「是不是没提提案」「是不是 manifest 缓存没重建」
 * 「是不是服务端已同步列表没刷」。真相在 `manifest.js` 第 103 行：
 *
 *   if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
 *
 * `dir-recent` 只收「文件名是日期」的。普通文档永远进不了清单。
 *
 * ## 这个测试在守什么
 *
 * ① **正向**：`dir` 模式下任意文件名的文件都能进清单
 * ② **阴性对照**：`dir-recent` 模式**仍然**拒同名文件（证明是新增了模式，
 *    不是把老模式放宽了 —— 放宽会破坏日记那种「一天一个」的语义）
 * ③ **边界**：递归但深度有上限、隐藏文件不收、软链不跟、DENY 命中不收
 * ④ **鉴权对称**：`resolveAllowedKey` 的口径必须跟清单一致，
 *    否则「清单里有、拉的时候 403」或者反过来「清单里没有、对端能塞进来」
 *
 * ⚠️ 第 ③ 和第 ④ 是 2026-10-26 10:54 改的（小肥鱼指出两边口径不一致）：
 *    第一版我写「只一层」，她的清单是递归的 → 清单能列、鉴权拒 → 推送 403。
 *    现在两边都递归，深度上限对齐 `MAX_DIR_DEPTH = 8`。
 *
 * 跑：node test/dir.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTargetFiles, buildManifest, resolveAllowedKey } from '../lib/manifest.js'
import { normalizeProposal } from '../lib/targets.js'
import { normalizeConfig } from '../lib/identity.js'

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
    failures.push({ name, error })
    process.stdout.write(`  ❌ ${name}\n     ${String(error?.message ?? error).split('\n')[0]}\n`)
  }
}

/**
 * 造一个临时的 dsh home，里面放测试文件。
 *
 * 结构：
 *   <home>/知识库/写作/视频模板.md
 *   <home>/知识库/写作/判据集.md
 *   <home>/知识库/写作/.隐藏.md              ← 应被跳过
 *   <home>/知识库/写作/旧文件.md.bak          ← 应被 DENY 跳过
 *   <home>/知识库/写作/2026-10-26.md         ← 日期名，两种模式都收
 *   <home>/知识库/写作/子目录/里面的.md       ← 递归：**收**
 *   <home>/知识库/写作/子目录/更深/再深.md    ← 递归：**收**（2 层，未超限）
 *   <home>/知识库/写作/子目录/.藏起来的.md    ← 应被跳过（子目录里的隐藏文件）
 *   <home>/知识库/写作/软链.md → 视频模板.md  ← 应被跳过（不跟软链）
 *   <home>/知识库/别的/不在范围内.md          ← 应被跳过（不在 target.rel 下）
 *
 * @returns {Promise<string>} home 绝对路径。
 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-dir-test-'))
  const dir = join(home, '知识库', '写作')
  await mkdir(join(dir, '子目录', '更深'), { recursive: true })
  await mkdir(join(home, '知识库', '别的'), { recursive: true })

  await writeFile(join(dir, '视频模板.md'), '# 视频模板\n十五节。\n')
  await writeFile(join(dir, '判据集.md'), '# 判据集\n19 条。\n')
  await writeFile(join(dir, '2026-10-26.md'), '# 日记\n')
  await writeFile(join(dir, '.隐藏.md'), '不该出现')
  await writeFile(join(dir, '旧文件.md.bak'), '不该出现（DENY）')
  await writeFile(join(dir, '子目录', '里面的.md'), '递归应该收')
  await writeFile(join(dir, '子目录', '更深', '再深.md'), '递归应该收（2 层）')
  await writeFile(join(dir, '子目录', '.藏起来的.md'), '不该出现（子目录里的隐藏）')
  await writeFile(join(home, '知识库', '别的', '不在范围内.md'), '不该出现')

  // 软链：指向一个真实文件。dir 模式必须**不跟**（否则一条链指到 /etc 就逃出白名单）
  try {
    await symlink(join(dir, '视频模板.md'), join(dir, '软链.md'))
  } catch {
    // Windows 上非管理员可能建不了软链 —— 跳过这条，下面用条件断言
  }

  return home
}

/** target 的公共部分。 */
const baseTarget = { id: 't', rel: '知识库/写作', label: '写作目录' }

process.stdout.write('\n=== ① normalizeProposal 接受 dir ===\n')

await check('mode=dir 被保留（不被降级成 file）', () => {
  const p = normalizeProposal({
    id: 'write-dir', rel: '知识库/写作', mode: 'dir',
    label: '写作目录', proposedBy: 'big-fish',
  })
  assert.ok(p, '应该返回提案，实际 null')
  assert.equal(p.mode, 'dir')
})

await check('mode=dir 不传 days → days 是 undefined（不限天数）', () => {
  const p = normalizeProposal({
    id: 'write-dir', rel: '知识库/写作', mode: 'dir', proposedBy: 'big-fish',
  })
  assert.equal(p.days, undefined, '不传 days 时应该是不限，实际 ' + String(p.days))
})

await check('⚠️ mode=dir 传 days=7 → days 被丢弃（不是 7）', () => {
  const p = normalizeProposal({
    id: 'write-dir', rel: '知识库/写作', mode: 'dir', days: 7, proposedBy: 'big-fish',
  })
  assert.equal(p.days, undefined,
    'dir 不该接受 days（小肥鱼 10:54 指出：提案是两端共享的语义契约），实际 ' + String(p.days))
})

/**
 * ⚠️ 这一组是 2026-10-26 11:40 加的，起因是小肥鱼 11:35 的一个提醒：
 *
 * > 「如果你的 `dir` 保留了 `days: undefined`，而我的是『字段不存在』——
 * >   `JSON.stringify({a:1, days:undefined})` = `{"a":1}`，看起来一样，
 * >   但 `'days' in obj` 一个 true 一个 false。」
 *
 * **我实测了：这不影响 `mergeProposals`**（它的 `sameRel` 只比 rel 和 mode）。
 *
 * **但她还是对的** —— 因为**对象形状不同**，下次谁写 `if ('days' in p)` 就会分叉。
 *
 * 所以改成用条件展开 `...(days === undefined ? {} : { days })`，
 * 让 `Object.keys()` 里根本没有 `days`。
 *
 * ⚠️ 这两条测试就是钉住这个的：以后谁改回 `days: undefined`，当场挂。
 */
await check('⚠️ mode=dir 的 days 字段**根本不存在**（不是 undefined）', () => {
  const p = normalizeProposal({
    id: 'd', rel: '知识库/写作', mode: 'dir', proposedBy: 'big-fish',
  })
  assert.equal('days' in p, false,
    'dir 的对象里不该有 days 键 —— 有就是形状跟对端不一样')
  assert.ok(!Object.keys(p).includes('days'),
    'Object.keys 里不该有 days，实际：' + Object.keys(p).join(','))
})

await check('⚠️ mode=file 的 days 字段也不存在（形状跟 dir 一致）', () => {
  const p = normalizeProposal({
    id: 'd', rel: '知识库/写作', mode: 'file', proposedBy: 'big-fish',
  })
  assert.equal('days' in p, false, 'file 模式也不该有 days 键')
})

await check('mode=dir-recent 的 days 字段**必须存在**（它有实际值）', () => {
  const p = normalizeProposal({
    id: 'd', rel: '知识库/写作', mode: 'dir-recent', proposedBy: 'big-fish',
  })
  assert.equal('days' in p, true, 'dir-recent 必须有 days')
  assert.equal(p.days, 3, '不传时默认 3')
})

await check('⚠️ dir 和 dir-recent 的对象形状必须不同（一个有 days 一个没有）', () => {
  const a = normalizeProposal({ id: 'd', rel: '知识库/写作', mode: 'dir', proposedBy: 'big-fish' })
  const b = normalizeProposal({ id: 'd', rel: '知识库/写作', mode: 'dir-recent', proposedBy: 'big-fish' })
  assert.equal('days' in a, false)
  assert.equal('days' in b, true)
  // 除了 days，其它键必须一致 —— 不一致说明还有别的形状差异
  const ka = Object.keys(a).filter((k) => k !== 'days')
  const kb = Object.keys(b).filter((k) => k !== 'days')
  assert.deepEqual(ka, kb, '除 days 外，两种模式的键必须完全一致')
})

await check('mode=dir-recent 不传 days → 仍然默认 3（老行为不变）', () => {
  const p = normalizeProposal({
    id: 'd', rel: 'yiqishard/memory', mode: 'dir-recent', proposedBy: 'big-fish',
  })
  assert.equal(p.days, 3)
})

await check('不认识的 mode → 降级成 file（老行为不变）', () => {
  const p = normalizeProposal({
    id: 'd', rel: '知识库/写作', mode: 'nonsense', proposedBy: 'big-fish',
  })
  assert.equal(p.mode, 'file')
})

process.stdout.write('\n=== ② listTargetFiles：dir 收任意文件名 ===\n')

const home = await makeHome()

/**
 * ⚠️ 清理兜底（2026-10-26 11:15 加，小肥鱼的坑 2 教训）。
 *
 * 原来只在文件最后 `await rm(home)`。
 * 问题是：如果中间某个 `await` 抛了非断言错误（不是 `check()` 能兜住的），
 * 最后那行就执行不到 → 临时目录残留。
 *
 * 小肥鱼踩的是 `process.on('exit')` 里用异步 `rm()` —— 那个不会跑完。
 * 这里用同步 `rmSync`，而且只在还没正常清理时才动。
 */
let homeCleaned = false
process.on('exit', () => {
  if (homeCleaned) return
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // exit 阶段兜不住就兜不住，别抛（抛了会盖掉真正的失败原因）
  }
})

await check('dir 收到 视频模板.md（这就是修的那个 bug）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/视频模板.md'),
    '没收到 视频模板.md，实际：' + keys.join(', '))
})

await check('dir 收到 判据集.md', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/判据集.md'))
})

await check('dir 也收日期名的 2026-10-26.md', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/2026-10-26.md'))
})

await check('dir 跳过隐藏文件 .隐藏.md', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.includes('知识库/写作/.隐藏.md'), '隐藏文件不该进清单')
})

await check('dir 跳过 .bak（DENY_PATTERNS）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.some((k) => k.endsWith('.bak')), '.bak 不该进清单')
})

await check('dir 递归（子目录里的文件要收 —— 这是 10:54 改的）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/子目录/里面的.md'),
    '子目录里的文件该收（递归），实际：' + keys.join(', '))
})

await check('dir 递归 2 层也收', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/子目录/更深/再深.md'), '2 层子目录该收')
})

await check('dir 跳过子目录里的隐藏文件', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.some((k) => k.includes('.藏起来的')), '子目录里的隐藏文件不该收')
})

await check('dir 不跟软链（安全边界：软链能指到 /etc）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  // ⚠️ Windows 非管理员可能建不了软链 —— 建不了就跳过（不是失败）
  const hasLink = keys.some((k) => k.includes('软链'))
  assert.ok(!hasLink, '软链不该进清单，实际：' + keys.filter((k) => k.includes('软链')).join(', '))
})

await check('dir 不越界（知识库/别的/ 下的不收）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.some((k) => k.includes('别的')), 'target.rel 之外的不该进清单')
})

await check('dir 目录不存在 → 空清单，不抛', async () => {
  const files = await listTargetFiles(
    home, { ...baseTarget, rel: '知识库/不存在', mode: 'dir' }, new Date())
  assert.deepEqual(files, [])
})

process.stdout.write('\n=== ③ 阴性对照：dir-recent 仍然拒普通文件名 ===\n')

await check('dir-recent 拒 视频模板.md（老行为没被放宽）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir-recent' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.includes('知识库/写作/视频模板.md'),
    'dir-recent 不该收普通文件名 —— 收了说明我改坏了老模式')
})

await check('dir-recent 只收日期名的 2026-10-26.md', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir-recent' }, new Date())
  const keys = files.map((f) => f.key)
  assert.deepEqual(keys, ['知识库/写作/2026-10-26.md'])
})

await check('dir-recent 也不递归（老行为）', async () => {
  const files = await listTargetFiles(home, { ...baseTarget, mode: 'dir-recent' }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(!keys.some((k) => k.includes('子目录')), 'dir-recent 不该递归')
})

process.stdout.write('\n=== ④ dir 不接受 days（10:54 改的语义）===\n')

await check('dir 传 days=1：10 天前的**照样收**（days 被忽略）', async () => {
  const oldFile = join(home, '知识库', '写作', '十天前.md')
  await writeFile(oldFile, '老文件')
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await utimes(oldFile, tenDaysAgo, tenDaysAgo)

  const files = await listTargetFiles(
    home, { ...baseTarget, mode: 'dir', days: 1 }, new Date())
  const keys = files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/十天前.md'),
    'dir 不该按 mtime 筛（days 是 dir-recent 的语义，别混）')
})

process.stdout.write('\n=== ⑤ resolveAllowedKey：鉴权口径必须跟清单一致 ===\n')

const cfg = normalizeConfig({
  identity: 'big-fish',
  home,
  targets: [{ ...baseTarget, mode: 'dir' }],
}, home)

await check('dir：允许 知识库/写作/视频模板.md', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/视频模板.md', new Date())
  assert.equal(k, '知识库/写作/视频模板.md')
})

await check('dir：允许 知识库/写作/子目录/里面的.md（递归 —— 10:54 改的）', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/子目录/里面的.md', new Date())
  assert.equal(k, '知识库/写作/子目录/里面的.md',
    '清单能列出来的，鉴权就必须放行 —— 否则「清单说有、推送 403」')
})

await check('dir：允许 2 层 知识库/写作/a/b/c.md', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/a/b/c.md', new Date())
  assert.equal(k, '知识库/写作/a/b/c.md')
})

await check('dir：拒超深路径（9 层，超过 MAX_DIR_DEPTH=8）', async () => {
  const deep = '知识库/写作/' + Array.from({ length: 9 }, (_, i) => `d${i}`).join('/') + '/x.md'
  const k = await resolveAllowedKey(cfg, deep, new Date())
  assert.equal(k, null, '超过深度上限该拒（跟清单口径对齐）')
})

await check('dir：拒隐藏文件', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/.隐藏.md', new Date())
  assert.equal(k, null, '隐藏文件不该放行')
})

await check('dir：拒子目录里的隐藏段（知识库/写作/.git/config）', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/.git/config', new Date())
  assert.equal(k, null, '路径里任何一段都不能是点开头')
})

await check('dir：拒 dir 本身（知识库/写作，没有文件名）', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作', new Date())
  assert.equal(k, null, '目录本身不是文件')
})

await check('dir：拒目录外的 知识库/别的/x.md', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/别的/x.md', new Date())
  assert.equal(k, null)
})

await check('dir：拒前缀攻击 知识库/写作-evil/x.md', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作-evil/x.md', new Date())
  assert.equal(k, null, 'startsWith(rel + "/") 必须挡住 rel-xxx 这种')
})

await check('dir：拒 .bak', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/旧文件.md.bak', new Date())
  assert.equal(k, null, '.bak 该被 DENY 挡')
})

await check('dir：拒目录穿越 知识库/写作/../../etc/passwd', async () => {
  const k = await resolveAllowedKey(cfg, '知识库/写作/../../etc/passwd', new Date())
  assert.equal(k, null)
})

process.stdout.write('\n=== ⑥ 端到端：buildManifest 带上 dir 模式 ===\n')

await check('buildManifest 里出现 视频模板.md', async () => {
  const m = await buildManifest(cfg, new Date())
  const keys = m.files.map((f) => f.key)
  assert.ok(keys.includes('知识库/写作/视频模板.md'),
    '清单里没有 视频模板.md，实际：' + keys.join(', '))
})

await check('清单里每一项都有 sha256 和 size', async () => {
  const m = await buildManifest(cfg, new Date())
  for (const f of m.files) {
    assert.equal(typeof f.size, 'number', f.key + ' 缺 size')
    assert.ok(typeof f.sha256 === 'string' && f.sha256.length === 64,
      f.key + ' 的 sha256 不对：' + String(f.sha256))
  }
})

await check('清单里没有 .bak / 隐藏 / 越界', async () => {
  const m = await buildManifest(cfg, new Date())
  const keys = m.files.map((f) => f.key)
  for (const bad of ['.bak', '.隐藏', '.藏起来的', '别的', '软链']) {
    assert.ok(!keys.some((k) => k.includes(bad)), '清单里不该有 ' + bad)
  }
})

await check('⚠️ 清单里有子目录（递归）—— 鉴权和清单口径一致', async () => {
  const m = await buildManifest(cfg, new Date())
  const keys = m.files.map((f) => f.key)
  const sub = keys.filter((k) => k.includes('子目录'))
  assert.ok(sub.length > 0, '递归该收到子目录里的文件，实际一个都没有')
  // 而且每一个都必须能被 resolveAllowedKey 放行 —— 否则就是「清单说有、推送 403」
  for (const k of sub) {
    const allowed = await resolveAllowedKey(cfg, k, new Date())
    assert.equal(allowed, k,
      '清单列了 ' + k + ' 但鉴权拒了 —— 这就是口径不一致')
  }
})

process.stdout.write('\n=== ⑦ 深度上限：清单和鉴权必须两侧对齐 ===\n')

/**
 * ⚠️ 这一组是 2026-10-26 11:10 加的，起因是小肥鱼指出的一个真缺陷。
 *
 * 她那边的 `resolveAllowedKey` 第一版**没有任何深度判断**：
 *   清单最多扫 8 层（`depth > MAX_DIR_DEPTH` 就 return）
 *   但鉴权不限层 → 手工构造一条 21 层的 key 去 POST，**能写进来**
 *
 * 她说：
 * > 「口径不一致有两个方向：
 * >   你那边：清单有、鉴权拒   → 推送 403（看起来像网络问题）
 * >   我这边：清单没有、鉴权放行 → 能写进来（看起来一切正常）
 * >   后者更危险 —— 因为它绕过了清单这道门。」
 *
 * ⚠️ 我原来只测了第一个方向（清单有→鉴权必须放行），
 *    **没测第二个方向（鉴权不许比清单宽）**。
 *    只测一侧，另一侧漏了也发现不了。
 *
 * 所以这一组造一个真实的 12 层目录，逐层核对两侧。
 */
await check('深度对齐：1~8 层清单有且鉴权放行，9~12 层两边都拒', async () => {
  const deepHome = await mkdtemp(join(tmpdir(), 'dsh-depth-'))
  try {
    const root = join(deepHome, '知识库', '深')
    await mkdir(root, { recursive: true })
    let cur = root
    for (let d = 1; d <= 12; d += 1) {
      cur = join(cur, `d${d}`)
      await mkdir(cur, { recursive: true })
      await writeFile(join(cur, `f${d}.md`), 'x')
    }

    const deepTarget = { id: 't-deep', rel: '知识库/深', mode: 'dir' }
    const deepCfg = normalizeConfig({
      identity: 'big-fish', home: deepHome, targets: [deepTarget],
    }, deepHome)

    const files = await listTargetFiles(deepHome, deepTarget, new Date())
    const listed = new Set(files.map((f) => f.key))

    for (let d = 1; d <= 12; d += 1) {
      const segs = Array.from({ length: d }, (_, i) => `d${i + 1}`)
      const key = `知识库/深/${segs.join('/')}/f${d}.md`
      const inList = listed.has(key)
      const allowed = (await resolveAllowedKey(deepCfg, key, new Date())) !== null
      assert.equal(inList, allowed,
        `第 ${d} 层不一致：清单=${inList ? '有' : '无'}，鉴权=${allowed ? '放行' : '拒'}`)
      // 再明确边界：8 层以内必须收，9 层起必须拒
      assert.equal(inList, d <= 8, `第 ${d} 层的收录判定不对（应 ${d <= 8 ? '收' : '拒'}）`)
    }
  } finally {
    await rm(deepHome, { recursive: true, force: true })
  }
})

await check('深度上限：纯路径（文件不存在）也按 8 层卡住', async () => {
  const deepHome = await mkdtemp(join(tmpdir(), 'dsh-depth2-'))
  try {
    const deepTarget = { id: 't', rel: '知识库/深', mode: 'dir' }
    const deepCfg = normalizeConfig({
      identity: 'big-fish', home: deepHome, targets: [deepTarget],
    }, deepHome)

    for (const d of [1, 8, 9, 12, 21]) {
      const segs = Array.from({ length: d }, (_, i) => `p${i + 1}`)
      const key = `知识库/深/${segs.join('/')}/x.md`
      const allowed = (await resolveAllowedKey(deepCfg, key, new Date())) !== null
      assert.equal(allowed, d <= 8,
        `${d} 层纯路径：鉴权=${allowed ? '放行' : '拒'}，应为 ${d <= 8 ? '放行' : '拒'}`)
    }
  } finally {
    await rm(deepHome, { recursive: true, force: true })
  }
})

await check('⚠️ 鉴权不比清单宽：除深度外的其它维度也一致', async () => {
  // 「鉴权放行但清单没有」在「新文件推送」场景下是必须的（对端还没这个文件）。
  // 所以这里不测「放行必须在清单里」，而是测「被排除的类别，鉴权也必须排除」。
  const excluded = [
    '知识库/写作/.隐藏.md',
    '知识库/写作/旧文件.md.bak',
    '知识库/写作/.git/config',
    '知识库/别的/不在范围内.md',
    '知识库/写作-evil/x.md',
  ]
  for (const k of excluded) {
    const allowed = await resolveAllowedKey(cfg, k, new Date())
    assert.equal(allowed, null, k + ' 清单排除它，鉴权也必须排除')
  }
})

// 清理（正常路径；异常路径由上面的 process.on('exit') 兜）
await rm(home, { recursive: true, force: true })
homeCleaned = true

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
