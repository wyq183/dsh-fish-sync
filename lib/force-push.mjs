#!/usr/bin/env node
/**
 * 强制推送一个文件到对端（只推不拉）。
 *
 * 为什么要有它：syncOnce() 在「两端都改过」时用 mtime 比新旧，
 * 对端更新就直接覆盖本地 —— 2026-10-22 我因此丢了交接板两条。
 * 这个脚本绕过那套判断，直接 POST，适合「我这边是准的，就按我的来」。
 *
 * 用法：node force-push.mjs <key>
 *   例：node force-push.mjs yiqishard/SYNC-BOARD.md
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const key = process.argv[2]
if (!key) {
  console.error('用法：node force-push.mjs <key>')
  process.exit(2)
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const paired = JSON.parse(await readFile(join(home, 'fish-sync', 'paired.json'), 'utf8'))
const buf = await readFile(join(home, key))
const sha = createHash('sha256').update(buf).digest('hex')

const url = `http://${paired.peer}/api/file?key=${encodeURIComponent(key)}`
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'x-fish-token': paired.secret,
    'x-fish-sha256': sha,
    'content-type': 'application/octet-stream',
    connection: 'close',
  },
  body: buf,
})

console.log('HTTP', res.status)
console.log(await res.text())
console.log('推送', buf.length, '字节，sha256', sha.slice(0, 12))
