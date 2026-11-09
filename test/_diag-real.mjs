/**
 * 重启前最后一验：用真实的 dsh home 跑 dir 模式。
 *
 * 单元测试用的是临时目录；这个用的是真 home、真文件、真路径，
 * 验的是「重启后到底能不能用」。
 */
import { buildManifest, resolveAllowedKey, listTargetFiles } from "../lib/manifest.js"
import { normalizeConfig } from "../lib/identity.js"

const home = "C:\\Users\\you\\.dsh"

const cfg = normalizeConfig({
  identity: "big-fish",
  home,
  targets: [
    { id: "t-write", rel: "知识库/写作", mode: "dir", label: "写作" },
    { id: "t-learn", rel: "知识库/学习资料", mode: "dir", label: "学习资料" },
  ],
}, home)

console.log("=== 1. 知识库/写作（真实目录）===")
const w = await listTargetFiles(home, { id: "t-write", rel: "知识库/写作", mode: "dir" }, new Date())
console.log("  扫到 " + w.length + " 个文件")
for (const f of w) console.log("    " + f.key)

console.log("")
console.log("=== 2. 知识库/学习资料（真实目录）===")
const l = await listTargetFiles(home, { id: "t-learn", rel: "知识库/学习资料", mode: "dir" }, new Date())
console.log("  扫到 " + l.length + " 个文件")
for (const f of l) console.log("    " + f.key)

console.log("")
console.log("=== 3. 鉴权：扫到的每一个都必须放行 ===")
let bad = 0
for (const f of [...w, ...l]) {
  const k = await resolveAllowedKey(cfg, f.key, new Date())
  if (k !== f.key) { console.log("  [X] 清单有但鉴权拒: " + f.key); bad += 1 }
}
console.log(bad === 0 ? "  全部放行 [OK]" : "  有 " + bad + " 个被拒 [X]")

console.log("")
console.log("=== 4. buildManifest 端到端 ===")
const m = await buildManifest(cfg, new Date())
console.log("  清单共 " + m.files.length + " 项")

console.log("")
console.log("=== 5. 阴性对照：dir-recent 扫同一目录 ===")
const r = await listTargetFiles(home, { id: "t", rel: "知识库/写作", mode: "dir-recent", days: 14 }, new Date())
console.log("  dir-recent 扫到 " + r.length + " 个（只认日期名，应该 0）")
