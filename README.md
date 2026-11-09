# dsh-fish-sync · 小鲸鱼同步

大肥鱼（电脑）与小肥鱼（手机）之间的记忆同步。**只同步「任务」与「今日记忆」**。

---

## 一句话

两端都在同一局域网、都开着 DSH，**扫一次码**就成。之后自动同步，白天每 5 分钟、夜里每 2 分钟。

---

## 同步什么

| 目标 | 路径 | 说明 |
|---|---|---|
| 任务 | `~/.dsh/yiqi-pending/pending.json` | 挂起板 |
| 今日记忆 | `~/.dsh/yiqishard/memory/YYYY-MM-DD.md` | 最近 3 天的日记 |

**别的记忆文件一律不传**（个人记忆 / 日记 / 编年 / 调研等）。
白名单写死在 `lib/identity.js` 的 `DEFAULT_TARGETS`，服务端按白名单校验路径——
对端就算伪造请求，也读不到名单外的东西。

---

## 怎么用

### 1. 重启 DSH（只做一次）

插件装了之后要重启一次宿主才加载。

### 2. 配对（输 6 位码，不是扫码）

**A 端**点左侧栏的「🐋 小鲸鱼同步」→ 点「生成配对码」→ 屏幕上出现一串 **6 位码**，如 7K3M9P。

**B 端**也打开「小鲸鱼同步」浮层 → 在「输入对方的配对码」里填这 6 位 → 地址填 A 端的 IP:3098 → 点「配对」。

配对成功后，两端各自记下密钥，之后自动同步。

> ⚠️ **为什么不是扫码**：二维码里是一段 JSON 文本，手机浏览器扫开只会显示一行字，
> 它没法把密钥交回 DSH 插件里 —— 配对必须由插件自己发起。
> 所以走「输码」这条路，和 WiFi 密码同一个体验。

> ⚠️ 配对码 **120 秒过期**，且**一码只能用一次**。
> 拿到它的人可以和本端配对，别截图外传。

### 3. 之后

- **自动同步**：白天每 5 分钟，23:00–07:00 每 2 分钟
- **手动同步**：对任意一端说「同步一下」，或点浮层里的「立刻同步」

两端都能发起，不分主次。

---

## 安全设计

### 为什么不用「广播 + 固定 token」

最初写的是这版，后来改了（2026-10-22 主人问「有信息泄露安全问题吗」之后）：

| 问题 | 后果 |
|---|---|
| UDP 广播是明文 | 同一局域网谁都能收，泄露设备名与 IP |
| token 固定不变 | 一旦被看到（配置/截图/日志）就永久有效 |
| 3098 全网段可达 | 公共 WiFi 上攻击面太大 |

### 现在这套

| 机制 | 作用 |
|---|---|
| 配对码只有**短时一次性令牌** | 2 分钟后就作废 |
| 一码一用（配对即消费） | 重复用不了，暴露窗口更小 |
| 令牌只在内存 | 进程重启即失效 |
| 定长比较 + 过期/不存在同一结果 | 不给探测口 |
| 长期密钥存本地 `fish-sync/paired.json` | 之后不再经过网络 |
| 路径白名单 | 读不到名单外的东西 |
| 管理面**只对回环放行** | 局域网设备连不到 dsh 本体端口 |
| 广播**默认关** | 想开才开（`discovery: true`） |

### 管理面的认证为什么是「回环放行」

桌面端页面源是 `dsh-app://app`，对 `http://127.0.0.1:PORT` 属于**跨源** ——
fetch 不会带上 dsh 的会话 cookie（`SameSite=Strict`），
于是 `requestRejection` 一律 401 → 前端白条。

放行的依据是：管理面挂在 **dsh 本体**上，而本体绑的是 `127.0.0.1`，
**只有本机进程能连**。局域网设备根本连不到这个端口。

> 对照：`dsh-lan-connect` 的管理面需要登录，是因为它另开了 `0.0.0.0:3099`
> 暴露在局域网上 —— 我们情况不同。

### 配对状态存哪

```
~/.dsh/fish-sync/paired.json
```

里面是 `secret`（长期密钥）与 `peer`（对端地址）。

**删掉这个文件 = 解除配对。** 删完重新扫一次码就成。

---

## 冲突怎么处理

同一文件两边 sha256 不一样时：

1. **比 mtime**，新的赢
2. 但如果**本地文件在 90 秒内改过** → 保护本地，记一条冲突，本次不覆盖

为什么不用「时间戳变了就传」：cp / 解压 / 换时区都会改 mtime 而不改内容，
那会变成每次全量传输。**内容哈希才是「一样不一样」的判据**，mtime 只判「谁后改的」。

---

## 工具

| 工具 | 干什么 |
|---|---|
| `fish_sync_now` | 立刻同步，返回推/拉/跳过/冲突明细 |
| `fish_sync_status` | 看身份、端口、发现到的对端、上次同步结果 |

## 接口

| 端点 | 认证 | 作用 |
|---|---|---|
| `GET /ext/fish-sync/` | 要登录 | 管理页（二维码 + 状态） |
| `GET /ext/fish-sync/api/state` | 要登录 | 状态 JSON |
| `POST /ext/fish-sync/api/pair` | 要登录 + `X-DSH-Fish-Sync: 1` | 签发新二维码 |
| `POST /ext/fish-sync/api/sync` | 要登录 + `X-DSH-Fish-Sync: 1` | 立刻同步 |
| `POST /api/pair`（3098） | **免认证**，靠配对令牌 | 换长期密钥 |
| `GET /api/status` / `/api/manifest` / `/api/file` | 要密钥 | 同步用 |

---

## 自动发现（可选）

默认**关**。想要「完全不碰界面也能自动连」时打开：

```yaml
- id: fish-sync
  config:
    identity: big-fish
    port: 3098
    discovery: true
```

它用 UDP 组播（`239.255.42.98:3097`）+ 广播互相喊「我在哪」。

**注意**：报文是明文的（含身份名与 IP），同一局域网谁都能收。
所以默认关，扫码够用了。

> 为什么不用标准 mDNS（`bonjour-service` / `multicast-dns`）：
> ① 手机上装 npm 包会撞 EACCES（上游 issue #57）
> ② Android 组播需要 `CHANGE_WIFI_MULTICAST_STATE` 权限，本 App 没申请
> ③ 我们不需要完整 DNS-SD 协议栈，只需要「两端互相知道对方在哪」
> ⇒ 用内置 `dgram`，零依赖、零权限。

---

## 配置

```yaml
- insert:
    - id: fish-sync
      name: '@dsh-external/dsh-fish-sync'
      config:
        identity: big-fish        # big-fish（电脑）/ small-fish（手机）
        port: 3098
        autoSync: true
        intervalMs: 300000        # 白天 5 分钟
        nightFrom: 23             # 夜间时段起
        nightTo: 7                # 夜间时段止
        nightIntervalMs: 120000   # 夜间 2 分钟
        # peer / token 不写死 —— 走扫码配对
```

**两端 `identity` 必须不同**，否则分不清谁是谁。

---

## 卸载

1. 删掉 `cordis.patch.yml` 里的 `fish-sync` 那段
2. 移除 `node_modules/@dsh-external/dsh-fish-sync`
3. 可选：删 `~/.dsh/fish-sync/`（解除配对）

---

## 自检

```sh
node test/offline.mjs    # 路径安全 + 白名单 + 端到端同步（12 项）
node test/load.mjs       # 导出契约 + 假 ctx 跑 apply（7 项）
node test/pairing.mjs    # 配对安全性质（11 项）
node test/discovery.mjs  # 自动发现（9 项）
```

全绿才算能用。**改代码后必须跑一遍**，别「写完就报完成」。

---

## 踩过的坑（改代码前先看）

| 坑 | 症状 | 修法 |
|---|---|---|
| 工具缺 `output` | `TypeError: tool "X" must declare output`，且工具一个都不注册 | 每个工具都要 `output: { schema, render }`，`execute` 返回 `{ text }` 对象 |
| 导出 `Config` | apply 一次都不被调用，不报错、不留痕 | **绝不导出 `Config`** |
| 发送 socket 绑 3097 | `bind EADDRINUSE`，广播发不出去 | 发送 socket 绑**端口 0** |
| `dsh.bundle` 缺 | `declares no dsh.bundle in its package.json` | package.json 里加 `"dsh": { "bundle": {} }` |
| CLI 用 `process.exit()` | `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | 改 `process.exitCode`，让事件循环自己收尾 |

---

*2026-10-21 建立 · 2026-10-22 改为扫码配对*
