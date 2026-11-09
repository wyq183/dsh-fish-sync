#!/usr/bin/env node
/**
 * 手动跑一次同步（绕开插件里那个有 bug 的 fish_sync_now 工具）。
 *
 * 为什么要有这个：fish_sync_now 的 execute 里判断对端只看 cfg.peer，
 * 而扫码配对得来的地址存在 runtime.peer 里，cfg.peer 一直是空串
 * → 明明配对过、自动同步也在跑，手动触发却说「没有配置对端地址」。
 * 2026-10-22 已修 lib/index.js，但改代码要重启 DSH 才生效。
 * 在那之前，用这个脚本直接调 syncOnce()。
 *
 * 用法：node sync-now.mjs
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from './identity.js'
import { syncOnce } from './sync.js'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const paired = JSON.parse(await readFile(join(home, 'fish-sync', 'paired.json'), 'utf8'))

const cfg = normalizeConfig({
  identity: 'big-fish',
  peer: paired.peer,
  token: paired.secret,
  autoSync: false,
}, home)

const report = await syncOnce(cfg, { log: () => {} })

console.log('ok:', report.ok)
console.log('对端:', report.peer, '(' + report.peerSource + ')')
console.log('耗时:', report.durationMs, 'ms')
console.log('推送', report.pushed.length, ':', report.pushed.map(x => x.key).join(', ') || '无')
console.log('拉取', report.pulled.length, ':', report.pulled.map(x => x.key).join(', ') || '无')
console.log('跳过:', report.skipped)
console.log('冲突:', JSON.stringify(report.conflicts, null, 2))
if (report.errors.length) console.log('错误:', report.errors.join(' | '))
