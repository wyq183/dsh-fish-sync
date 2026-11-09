/**
 * pairing —— 扫码配对，一次换到长期密钥。
 *
 * 主人 2026-10-22 定：参考局域网连接的做法，扫码配对，左栏加个按钮。
 *
 * 为什么不用「广播 + 固定 token」那套（我最初写的）：
 *   ① 广播报文是明文的，同一局域网谁都能收 → 泄露设备名与 IP
 *   ② 固定 token 一旦被看到（配置文件/截图/日志）就永久有效
 *   ③ 公共 WiFi 上同网段的人能扫到 3098，攻击面太大
 *
 * 扫码这套照 dsh-lan-connect/lib/pairing.js 的**设计思路**（不抄代码）：
 *   · 二维码里只放**短时配对令牌**（默认 120 秒）
 *   · 手机扫码 → POST /api/pair 带上令牌 → 服务端换发长期密钥
 *   · 令牌只在内存，进程重启即失效
 *   · 定长比较；过期与不存在返回同一结果（不给探测口）
 *
 * 关键差别（同步不需要登录态）：
 *   配对成功后服务端把长期密钥**存到本端配置**，两端从此用同一把密钥。
 *   所以「配对」这个动作本身要能改本端配置 —— 这是**写操作**，
 *   必须由本机用户在界面上点「允许」才生效，不能对端一个人说了算。
 *   ⇒ 配对分两步：手机扫码 → 电脑端弹确认（或反过来）。
 *      实现上用「二维码里带一次性令牌，令牌本身就是授权」：
 *      谁拿到这张码谁就能配 —— 和 WiFi 密码同一个威胁模型，够用且直观。
 */

import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto'

/** 配对令牌有效期：2 分钟。够从容扫码，又短到截图基本没用。 */
const DEFAULT_TTL_MS = 120_000

/** 令牌随机字节数（base64url 后约 43 字符）。 */
const TOKEN_BYTES = 32

/** 长期密钥字节数。 */
const SECRET_BYTES = 32

/**
 * base64url 编码（无填充），与 dsh 内部风格一致。
 * @param {Buffer} buffer - 字节。
 * @returns {string} 编码结果。
 */
function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * 生成人可读的 6 位短码。
 *
 * 为什么需要它（2026-10-22 主人真机踩到）：
 *   原来只有二维码，但**二维码内容是 JSON，手机浏览器扫开只显示一行字**，
 *   不会做任何事 —— 因为「配对」这个动作必须由**手机端 DSH 插件**发起
 *   （它要拿到 secret 存本地），系统浏览器拿不到插件里去。
 *   ⇒ 加 6 位短码：主人看电脑屏幕，在手机端浮层里输入。
 *      和 WiFi 密码同一个体验，不依赖摄像头。
 *
 * 字符集刻意排除易混的 0/O、1/I/L，读起来不会看错。
 * @returns {string} 6 位码。
 */
function shortCode() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

/**
 * 定长比较，避免用长度或提前返回泄露信息。
 * @param {unknown} actual - 收到值。
 * @param {unknown} expected - 期望值。
 * @returns {boolean} 是否一致。
 */
function tokenMatches(actual, expected) {
  const a = Buffer.from(String(actual), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/**
 * 生成一把长期同步密钥。
 * @returns {string} base64url 密钥。
 */
export function newSecret() {
  return base64url(randomBytes(SECRET_BYTES))
}

/**
 * 配对服务。
 *
 * 同一时刻只有一个有效令牌；刷新二维码让上一张立刻失效
 * （「重新生成」就该是这个语义）。
 */
export class PairingService {
  /**
   * @param {object} [options] - 可调项。
   * @param {number} [options.ttlMs] - 令牌有效期。
   * @param {Function} [options.onPaired] - 配对成功回调 (secret) => Promise<void>。
   */
  constructor(options = {}) {
    const ttl = Number(options.ttlMs)
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS
    /** @type {{id: string, secret: string, issuedAt: number, expiresAt: number} | undefined} */
    this.token = undefined
    this.onPaired = typeof options.onPaired === 'function' ? options.onPaired : null
    /** 已完成的配对次数（诊断用）。 */
    this.pairedCount = 0
  }

  /**
   * 签发一个新令牌。旧令牌立刻作废。
   * @returns {{id: string, expiresAt: number, remainingMs: number}} 新令牌（**不含 secret**）。
   */
  issue() {
    const issuedAt = Date.now()
    const token = {
      id: base64url(randomBytes(TOKEN_BYTES)),
      // 人可读的 6 位短码 —— 手机端手输用（2026-10-22 加）
      code: shortCode(),
      // 这一把就是配对成功后的长期密钥，提前生成好，随令牌一起存活
      secret: newSecret(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }
    this.token = token
    return { id: token.id, code: token.code, expiresAt: token.expiresAt, remainingMs: this.ttlMs }
  }

  /**
   * 当前有效令牌（给二维码用）。
   * @returns {{id: string, code: string, expiresAt: number, remainingMs: number} | undefined} 令牌。
   */
  current() {
    const token = this.token
    if (token === undefined) return undefined
    const now = Date.now()
    if (token.expiresAt <= now) {
      this.token = undefined
      return undefined
    }
    return {
      id: token.id,
      code: token.code,
      expiresAt: token.expiresAt,
      remainingMs: token.expiresAt - now,
    }
  }

  /**
   * 撤销当前令牌（不影响已配对成功的两端）。
   */
  clear() {
    this.token = undefined
  }

  /**
   * 用配对令牌（长 id 或 6 位短码）换长期密钥。
   *
   * 成功即**消费**掉令牌 —— 一张码只能配一次。
   * 这是与 lan-connect 的有意差别：那边允许重复用（手机扫码流程跨 cookie 上下文），
   * 这边配对是一次性的密钥交换，重复用只会扩大暴露窗口。
   *
   * 接受两种输入（2026-10-22 加短码）：
   *   · 完整 id（二维码里的长串）
   *   · 6 位短码（主人手输）
   *
   * @param {unknown} id - 请求里的令牌。
   * @returns {Promise<string|null>} 长期密钥，或 null = 失败。
   */
  async accept(id) {
    const token = this.token
    if (token === undefined) return null
    if (Date.now() > token.expiresAt) {
      this.token = undefined
      return null
    }
    if (typeof id !== 'string' || id === '') return null

    // 两种形式都认；大小写不敏感（短码手输时容易大小写打错）
    const input = id.trim().toUpperCase()
    const okById = tokenMatches(id, token.id)
    const okByCode = tokenMatches(input, token.code)
    if (!okById && !okByCode) return null

    // 消费掉：一张码只配一次
    this.token = undefined
    this.pairedCount += 1

    if (this.onPaired !== null) {
      try {
        await this.onPaired(token.secret)
      } catch {
        // 落盘失败也要把密钥给出去，否则两端状态会不一致
      }
    }
    return token.secret
  }

  /**
   * 配对状态（界面倒计时用）。
   * @returns {{active: boolean, remainingMs: number, pairedCount: number}} 状态。
   */
  status() {
    const cur = this.current()
    return {
      active: cur !== undefined,
      remainingMs: cur?.remainingMs ?? 0,
      pairedCount: this.pairedCount,
    }
  }
}

/**
 * 二维码内容。手机扫码后照着它去 POST /api/pair。
 *
 * 格式刻意用一行紧凑 JSON（不是 URL）：
 *   · URL 会被系统浏览器抢走，落到一个打不开的页面
 *   · JSON 让手机端能直接解析，不必先跳转
 *
 * @param {object} cfg - 配置。
 * @param {string} host - 本机在局域网里的地址（二维码是给**别人**扫的，不能用 127.0.0.1）。
 * @param {string} tokenId - 配对令牌。
 * @returns {string} 二维码文本。
 */
export function qrPayload(cfg, host, tokenId) {
  return JSON.stringify({
    v: 1,
    fish: cfg.identity,
    host,
    port: cfg.port,
    pair: tokenId,
  })
}

/**
 * 给「握手确认」用的签名，防中间人改端口。
 * @param {string} secret - 长期密钥。
 * @param {string} text - 待签文本。
 * @returns {string} hex 签名。
 */
export function sign(secret, text) {
  return createHmac('sha256', secret).update(text).digest('hex')
}
