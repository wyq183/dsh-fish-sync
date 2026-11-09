#!/usr/bin/env node
/**
 * fish-sync CLI —— 不依赖 DSH 宿主，手动跑同步或起服务。
 *
 * 用途：
 *  · 本机验证同步逻辑（两个目录当两端，不用真机）
 *  · 手机端没有 DSH 插件时也能跑（Node 在 payload 里自带）
 *  · 排障：`status` 看一眼到底谁是谁、上次同步做了什么
 *
 * 用法：
 *   node lib/cli.js serve  --home DIR --port 3098 --token XXX [--identity big-fish]
 *   node lib/cli.js sync   --home DIR --peer 192.168.1.10:3098 --token XXX
 *   node lib/cli.js status --home DIR --peer ... --token XXX
 */

import { parseArgs } from 'node:util'
import { normalizeConfig, IDENTITIES } from './identity.js'
import { startServer } from './server.js'
import { syncOnce } from './sync.js'
import { buildManifest } from './manifest.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    port: { type: 'string' },
    peer: { type: 'string' },
    token: { type: 'string' },
    identity: { type: 'string' },
    once: { type: 'boolean', default: false },
  },
})

const command = positionals[0] ?? 'status'
const home = values.home ?? process.env.DSH_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE}/.dsh`

const cfg = normalizeConfig({
  identity: values.identity === IDENTITIES.SMALL ? IDENTITIES.SMALL : IDENTITIES.BIG,
  port: values.port !== undefined ? Number(values.port) : undefined,
  peer: values.peer ?? '',
  token: values.token ?? '',
  autoSync: false,
}, home)

const log = (level, msg) => {
  const stamp = new Date().toISOString().slice(11, 19)
  process.stderr.write(`[${stamp}] ${level.toUpperCase()} ${msg}\n`)
}

if (command === 'serve') {
  const handle = await startServer(cfg, { log })
  process.stdout.write(`serving ${cfg.label} on ${handle.url} (home=${home})\n`)
  if (values.once) {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', async () => {
    await handle.close()
    process.exit(0)
  })
} else if (command === 'sync') {
  const report = await syncOnce(cfg, { log })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  // 不用 process.exit()：fetch 的连接即使加了 connection:close，
  // 直接硬退仍可能撞 libuv 的 UV_HANDLE_CLOSING 断言。
  // 设 exitCode 让事件循环自己收尾，稳得多。
  process.exitCode = report.ok ? 0 : 1
} else if (command === 'manifest') {
  const m = await buildManifest(cfg)
  process.stdout.write(`${JSON.stringify(m, null, 2)}\n`)
} else {
  const lines = [
    `本端：${cfg.label}（${cfg.identity}）`,
    `home：${home}`,
    `端口：${cfg.port}`,
    `对端：${cfg.peer === '' ? '未配置' : cfg.peer}`,
    `范围：${cfg.targets.map((t) => t.label).join('、')}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
