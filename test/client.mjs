/**
 * 客户端半侧自检 —— 在 Node 里模拟浏览器环境跑 client.js。
 *
 * 为什么必须有这一关：
 *   dsh 的 **web boot 是「全或无」** —— 只要有一个客户端 entry 的 factory 抛错，
 *   整个页面就白屏，而宿主是活的（引擎好好的、日志没报错）。
 *   真机上白屏时**看不到任何有用的错误**（logcat 里也没有），
 *   所以必须在本地先跑一遍，把错拦在这里。
 *
 * 跑：node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

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

/**
 * 造一个够用的假 DOM。
 * @returns {object} 假 document。
 */
function makeFakeDocument() {
  const created = []

  /**
   * 造一个假元素。
   * @param {string} tag - 标签名。
   * @returns {object} 元素。
   */
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      innerHTML: '',
      style: {},
      children: [],
      attributes: {},
      parentNode: null,
      setAttribute(k, v) { this.attributes[k] = v },
      getAttribute(k) { return this.attributes[k] },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child },
      removeChild(child) {
        const i = this.children.indexOf(child)
        if (i >= 0) this.children.splice(i, 1)
        child.parentNode = null
        return child
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null },
      querySelectorAll() { return [] },
      insertBefore(newNode, ref) {
        const i = this.children.indexOf(ref)
        if (i >= 0) this.children.splice(i, 0, newNode)
        else this.children.push(newNode)
        newNode.parentNode = this
        return newNode
      },
    }
    created.push(el)
    return el
  }

  const head = makeEl('head')
  const body = makeEl('body')

  return {
    head,
    body,
    createElement: makeEl,
    getElementById(id) {
      for (const el of created) if (el.id === id) return el
      return null
    },
    querySelector(sel) {
      // 侧边栏选择器：默认返回 null（模拟「还没渲染出侧边栏」）
      return null
    },
    querySelectorAll() { return [] },
    _created: created,
  }
}

/**
 * 在沙箱里跑 client.js，返回它注册的插件定义。
 * @returns {Promise<{registered: object, factoryResult: object}>} 注册信息。
 */
async function runClient() {
  const source = await readFile(CLIENT, 'utf8')
  const fakeDoc = makeFakeDocument()

  /** 记录 load() 收到了什么。 */
  const registered = {}

  /** 假的模块加载器。 */
  const moduleLoader = {
    /**
     * 插件注册入口。
     * @param {object} def - 插件定义。
     */
    load(def) {
      registered.id = def.id
      registered.factory = def.factory
    },
  }

  // 用 Function 构造器造一个隔离作用域，把 window / document 塞进去
  const runner = new Function(
    'window', 'document', 'navigator', 'setInterval', 'clearInterval', 'fetch', 'alert',
    `"use strict";\n${source}\n;return window.__ModuleLoader__ ? "loaded" : "no-loader";`,
  )

  const intervals = []
  const fakeWindow = { __ModuleLoader__: moduleLoader }
  const fakeNavigator = { clipboard: undefined }

  const result = runner(
    fakeWindow,
    fakeDoc,
    fakeNavigator,
    // 不让真定时器跑起来（只记录）
    (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    () => {},
    // 不发真网络请求
    () => Promise.resolve({ json: () => Promise.resolve({}) }),
    () => {},
  )

  // 现在跑 factory
  let factoryResult = null
  if (typeof registered.factory === 'function') {
    factoryResult = registered.factory(() => ({}))
  }

  return { registered, factoryResult, fakeDoc, fakeWindow, result, intervals }
}

process.stdout.write('\n── ① 顶层执行 ──\n')

let ctxRun = null

await check('client.js 顶层不抛，且注册了 __ModuleLoader__', async () => {
  ctxRun = await runClient()
  // 🔴 id 必须是**完整包名**（与 package.json 的 name 一致）。
  //    写短名会静默失败：脚本执行了但宿主找不到注册 → 整页白屏。
  //    2026-10-22 真机上因为这个白屏，报错是
  //    `loaded without registering "..." via __ModuleLoader__.load`。
  assert.equal(ctxRun.registered.id, '@dsh-external/dsh-fish-sync',
    `id 必须是完整包名，实际 ${ctxRun.registered.id}`)
  assert.equal(typeof ctxRun.registered.factory, 'function', 'factory 必须是函数')
})

await check('id 与 package.json 的 name 逐字一致', async () => {
  const pkg = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'))
  const source = await readFile(CLIENT, 'utf8')
  const m = source.match(/id:\s*["']([^"']+)["']/)
  assert.ok(m, '找不到 id 声明')
  assert.equal(m[1], pkg.name, `client.js 的 id (${m[1]}) 必须等于 package.json 的 name (${pkg.name})`)
})

process.stdout.write('\n── ② factory 执行（白屏就死在这一步）──\n')

await check('factory 不抛，导出 apply', () => {
  assert.ok(ctxRun.factoryResult, 'factory 应有返回值')
  assert.equal(typeof ctxRun.factoryResult.apply, 'function', 'factory 结果应有 apply')
})

await check('apply 不抛（没有侧边栏时也不能炸）', () => {
  const fakeCtx = { }
  // 侧边栏找不到 → mountEntry 返回 false，不该抛
  const dispose = ctxRun.factoryResult.apply(fakeCtx)
  assert.equal(typeof dispose, 'function', 'apply 应返回 disposer')
  // 再调一次 disposer，不能抛
  dispose()
})

await check('有侧边栏时能挂上按钮', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const fakeDoc = makeFakeDocument()

  // 造一个侧边栏列
  const col = fakeDoc.createElement('div')
  col.className = 'xxx_sidebarCol_yyy'
  fakeDoc.body.appendChild(col)
  fakeDoc.querySelector = (sel) => {
    if (sel.includes('sidebarCol')) return col
    return null
  }

  let registered = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(def) { registered = def },
    },
  }

  const runner = new Function(
    'window', 'document', 'navigator', 'setInterval', 'clearInterval', 'fetch', 'alert',
    `"use strict";\n${source}\n;`,
  )
  runner(fakeWindow, fakeDoc, {}, () => 1, () => {}, () => Promise.resolve({ json: () => Promise.resolve({}) }), () => {})

  const mod = registered.factory(() => ({}))
  const dispose = mod.apply({})
  // 应该已经插进侧边栏了
  const hasButton = col.children.some((c) => String(c.className).includes('dfs-entry'))
  assert.ok(hasButton, `侧边栏里应有 dfs-entry 按钮，实际子节点 ${col.children.length} 个`)
  dispose()
})

process.stdout.write('\n── ③ 渲染不炸（真机踩过两次）──\n')

await check('🔴 渲染路径里没有「裸 querySelector 直接用」', async () => {
  // 2026-10-22 真机报 `Cannot set properties of null (setting 'className')`：
  // 改版删掉了 #dfs-qr 节点，但 paintQr 还在用 querySelector 的结果。
  // 这类 bug 只有真机点开浮层才暴露，所以用静态检查兜住：
  // 除了赋值给变量后判空的情况，不允许 `panel.querySelector("...").xxx` 直接链式调用。
  const source = await readFile(CLIENT, 'utf8')
  const bad = []
  const lines = source.split('\n')
  for (const [i, line] of lines.entries()) {
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//')) continue // 注释里的示例不算
    // 形如 xxx.querySelector("...").  —— 点号后面直接接东西
    if (/\.querySelector\([^)]*\)\.\w/.test(t)) {
      // 允许 on(root, sel, ...) 这种已经包了判空的写法（它内部才用 querySelector）
      bad.push(`第 ${i + 1} 行：${t.slice(0, 90)}`)
    }
  }
  assert.equal(bad.length, 0, `发现裸链式调用（节点不存在会抛）：\n${bad.join('\n')}`)
})

await check('paintQr 有 null 保护', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const fnStart = source.indexOf('function paintQr(')
  assert.ok(fnStart > 0, '找不到 paintQr')
  const fnBody = source.slice(fnStart, fnStart + 600)
  assert.ok(fnBody.includes('if (!box)'), 'paintQr 开头应判空 box')
})

await check('on() 工具函数存在且做了判空', async () => {
  const source = await readFile(CLIENT, 'utf8')
  assert.ok(source.includes('function on(root, sel, ev, fn)'), '应有 on() 安全绑定函数')
  const idx = source.indexOf('function on(root, sel, ev, fn)')
  const body = source.slice(idx, idx + 400)
  assert.ok(body.includes('el &&'), 'on() 应判空 el')
})

process.stdout.write('\n── ④ 关键约束 ──\n')

await check('用了 __ModuleLoader__.load（不是别的方式注册）', async () => {
  const source = await readFile(CLIENT, 'utf8')
  assert.ok(source.includes('__ModuleLoader__.load'), '必须用 __ModuleLoader__.load')
})

await check('没有顶层 await / import（浏览器 classic script 不支持）', async () => {
  const source = await readFile(CLIENT, 'utf8')
  // 只看顶层：去掉注释后，不该有以 import/export 开头的行
  const lines = source.split('\n')
  for (const [i, line] of lines.entries()) {
    const t = line.trim()
    if (t.startsWith('import ') || t.startsWith('export ')) {
      throw new Error(`第 ${i + 1} 行有 ESM 语法，浏览器 classic script 不支持：${t.slice(0, 60)}`)
    }
  }
})

process.stdout.write(`\n────────────────────────\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  process.stdout.write(`\n失败明细：\n${failures.map((f) => `  · ${f}`).join('\n')}\n`)
  process.exit(1)
}
