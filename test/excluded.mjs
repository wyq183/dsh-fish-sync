/**
 * 主人排除列表（`USER_EXCLUDED`）—— 2026-10-26 14:47 主人定「这份不同步」之后加的。
 *
 * ## 为什么要有这个
 *
 * 主人说「撤」，但两端同步的决策表只有三行：
 * ```
 * 本端 | 对端 | 动作
 * 无   | 有   | 拉
 * 有   | 无   | 推
 * 有   | 有   | 比 sha256
 * ```
 * **没有「本端故意不要」这一行。**
 *
 * 于是「改名让它不同步」不成立：
 * · 我改名 → 本端清单没有 → 判「缺」→ **拉回来**
 * · 她改名 → 她清单没有 → 判「对端没有」→ **推给她**
 *
 * **两种顺序都会把文件恢复。今天实测被拉回来 4 次。**
 *
 * ## 这个列表怎么解决它
 *
 * `isDeniedKey` 在 `resolveAllowedKey` 的**第一步**就被调用（manifest.js L338）。
 * 所以进了这个列表的文件：
 * · **清单里没有它**（`listTargetFiles` 也查 `isDeniedKey`）
 * · **鉴权拒收**（`resolveAllowedKey` 返回 null）
 * · 同步走到 L330 → `noteSkip('out-of-scope')` → **不拉**
 *
 * **⚠️ 这才是「单方面能生效」的唯一办法。**
 *
 * ## ⚠️ 但它跟安全边界是两回事
 *
 * | | `DENY_PATTERNS` | `USER_EXCLUDED` |
 * |---|---|---|
 * | 是什么 | 安全边界（密钥/备份/依赖） | 主人的偏好 |
 * | 删了会怎样 | 漏洞 | 只是「又开始同步了」 |
 * | 写法 | 正则 | **精确路径** |
 *
 * **⚠️ 混在一起，以后看到的人会以为「抑郁那份是安全风险」—— 它不是。**
 *
 * ## 这个测试在守什么
 *
 * ① 列表里的文件 → 清单没有、鉴权拒
 * ② **同目录其他文件不许误伤**
 * ③ **相似文件名不许误伤**（`-副本` / `.bak` 之类）
 * ④ 精确匹配，不是子串匹配
 *
 * 跑：node test/excluded.mjs
 */

import assert from 'node:assert/strict'
import { isDeniedKey, buildManifest, resolveAllowedKey } from '../lib/manifest.js'
import { USER_EXCLUDED, isUserExcluded } from '../lib/targets.js'

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

const TARGET = '知识库/主人/主人-关于抑郁这件事.md'

process.stdout.write('\n=== ① 列表本身 ===\n')

check('列表里有那份文件', () => {
  assert.ok(USER_EXCLUDED.includes(TARGET),
    '列表里没有 ' + TARGET + '，实际：' + JSON.stringify(USER_EXCLUDED))
})

check('列表里每一项都是完整路径（不是正则、不是子串）', () => {
  for (const k of USER_EXCLUDED) {
    assert.equal(typeof k, 'string')
    assert.ok(k.includes('/'), '不是路径：' + k)
    assert.ok(!k.startsWith('/'), '不该是绝对路径：' + k)
    assert.ok(!/[\\^$*+?()[\]{}|]/.test(k), '看着像正则，不该有元字符：' + k)
  }
})

process.stdout.write('\n=== ② isUserExcluded 精确匹配 ===\n')

check('精确命中 → true', () => {
  assert.equal(isUserExcluded(TARGET), true)
})

check('⚠️ 子串不算（前面加东西）', () => {
  assert.equal(isUserExcluded('xx' + TARGET), false)
})

check('⚠️ 子串不算（后面加东西）', () => {
  assert.equal(isUserExcluded(TARGET + '-副本'), false)
})

check('⚠️ 子串不算（同名不同目录）', () => {
  assert.equal(isUserExcluded('知识库/别的/主人-关于抑郁这件事.md'), false)
})

process.stdout.write('\n=== ③ isDeniedKey 会检查它 ===\n')

check('列表里的 → isDeniedKey 为 true', () => {
  assert.equal(isDeniedKey(TARGET), true)
})

check('同目录其他文件 → 不许误伤', () => {
  for (const k of [
    '知识库/主人/主人语录.md',
    '知识库/主人/主人教过我的.md',
    '知识库/主人/README.md',
    '知识库/主人/洛粉改造笔记.md',
  ]) {
    assert.equal(isDeniedKey(k), false, '误伤了：' + k)
  }
})

check('⚠️ 相似文件名 → 不许误伤', () => {
  for (const k of [
    '知识库/主人/主人-关于抑郁这件事-副本.md',
    '知识库/主人/主人-关于抑郁.md',
    '知识库/主人/关于抑郁这件事.md',
  ]) {
    assert.equal(isDeniedKey(k), false, '误伤了：' + k)
  }
})

check('.bak 还是被 DENY_PATTERNS 挡（跟排除列表无关）', () => {
  assert.equal(isDeniedKey(TARGET + '.bak'), true)
  assert.equal(isDeniedKey(TARGET + '.bak-移出同步-20261026'), true)
})

process.stdout.write('\n=== ④ 真目录：清单和鉴权都拒 ===\n')

const HOME = process.env.USERPROFILE + '\\.dsh'
const cfg = {
  home: HOME,
  targets: [{ id: 'master-notes', rel: '知识库/主人', mode: 'dir' }],
}

const manifest = await buildManifest(cfg)

// ⚠️ 先 await 出来再断言 —— check() 是同步的，传 async 函数它不会等，
//    断言失败会被吞掉（第一版我就这么写的，测试「全过」但实际没验）。
const allowExcluded = await resolveAllowedKey(cfg, TARGET)
const allowOther = await resolveAllowedKey(cfg, '知识库/主人/主人语录.md')

check('清单里没有那份文件', () => {
  const hit = manifest.files.find((f) => f.key === TARGET)
  assert.equal(hit, undefined, '清单里还有它：' + JSON.stringify(hit))
})

check('清单里还有别的文件（不是整个目录都没了）', () => {
  assert.ok(manifest.files.length > 0, '主人区整个空了，不对')
  const hasOthers = manifest.files.some((f) => f.key.includes('主人语录'))
  assert.ok(hasOthers, '别的文件也没了，排除列表写宽了')
})

check('⚠️ 鉴权也拒它（这条决定「拉不拉」）', () => {
  assert.equal(allowExcluded, null, '鉴权放行了，同步会把它拉回来')
})

check('鉴权放行同目录其他文件', () => {
  assert.equal(allowOther, '知识库/主人/主人语录.md')
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
