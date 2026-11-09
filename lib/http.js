/**
 * http —— 挂在 dsh 本体上的管理面（`/ext/fish-sync/`）。
 *
 * 端点：
 *   GET  /ext/fish-sync/              管理页（配对二维码 + 状态 + 手动同步）
 *   GET  /ext/fish-sync/api/state     状态快照（JSON）
 *   POST /ext/fish-sync/api/pair      签发新配对令牌（刷新二维码）
 *   POST /ext/fish-sync/api/sync      立刻同步一次
 *
 * 认证：全部走 `ctx.connection.requestRejection(req)` ——
 * 与 dsh 自己的界面同一套会话 cookie，未登录一律 401。
 * 这样「谁能看二维码」就等于「谁能登录这台 dsh」，不用另造一套。
 *
 * ⚠️ 二维码是**授权凭据**（拿到就能配对），所以绝不能放在免认证端点上。
 */

import { qrSvg } from './qr.js'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 本插件占用的路由前缀。 */
export const ROUTE_PATH = '/ext/fish-sync'

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {object} body - 载荷。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 写 HTML 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {string} html - 页面。
 */
function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(html)
}

/**
 * 读 JSON 请求体（允许为空）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<object>} 解析结果（失败给空对象）。
 */
async function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > 64 * 1024) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 生成管理页 HTML。
 * @param {object} view - 渲染所需数据。
 * @returns {string} HTML。
 */
function renderPage(view) {
  const qr = view.qrText === null ? '' : qrSvg(view.qrText, { scale: 6, margin: 2 })
  const peers = view.discovered.length === 0
    ? '<div class="empty">还没发现对端。两端都开着 DSH、在同一局域网，并且都开过配对之后就会显示。</div>'
    : view.discovered.map((p) => `
      <div class="peer">
        <span class="dot"></span>
        <b>${escapeHtml(p.label)}</b>
        <code>${escapeHtml(p.address)}:${p.port}</code>
      </div>`).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼同步 · ${escapeHtml(view.label)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    background: var(--dsw-alias-bg-base, #0e1419); color: var(--dsw-alias-label-primary, #e6edf3);
    display: flex; justify-content: center;
  }
  .wrap { width: min(680px, 100%); }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: var(--dsw-alias-label-secondary, #8b98a9); font-size: 12.5px; margin-bottom: 22px; }
  .card {
    border: 1px solid var(--dsw-alias-border-l2, #2a3242); border-radius: 12px;
    padding: 18px; margin-bottom: 16px; background: var(--dsw-alias-bg-l1, #151b23);
  }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: var(--dsw-alias-label-secondary, #8b98a9); font-weight: 600; }
  .qrbox {
    width: 232px; height: 232px; margin: 0 auto 14px; background: #fff;
    border-radius: 10px; padding: 10px; display: flex; align-items: center; justify-content: center;
  }
  .qrbox svg { width: 100%; height: 100%; display: block; }
  .qrbox.empty {
    background: rgba(127,160,255,.06); border: 1px dashed var(--dsw-alias-border-l2, #2a3242);
    color: var(--dsw-alias-label-secondary, #8b98a9); font-size: 12.5px; text-align: center; padding: 20px;
  }
  .row { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary, #8b98a9); }
  .cd { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--dsw-alias-brand-primary, #4da3ff); }
  .cd.expired { color: #d29922; }
  button {
    font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--dsw-alias-border-l2, #2a3242);
    background: var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.08));
    color: var(--dsw-alias-label-primary, #e6edf3);
  }
  button:hover { border-color: var(--dsw-alias-brand-primary, #4da3ff); }
  button:disabled { opacity: .5; cursor: default; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .kv { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; border-bottom: 1px solid rgba(127,160,255,.07); }
  .kv:last-child { border-bottom: none; }
  .kv span:first-child { color: var(--dsw-alias-label-secondary, #8b98a9); }
  code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 12px; }
  .peer { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; flex: none; }
  .empty { color: var(--dsw-alias-label-secondary, #8b98a9); font-size: 12.5px; }
  .warn {
    margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 12.5px;
    background: rgba(210,153,34,.1); border: 1px solid rgba(210,153,34,.35); color: #d29922;
  }
  .ok { color: #3fb950; }
  .err { color: #f85149; }
  /* 同步反馈条（2026-10-23 加）：成功也要看得见，别只报错 */
  .syncmsg {
    margin-top: 10px; padding: 9px 12px; border-radius: 8px; font-size: 12.5px;
    line-height: 1.55; word-break: break-all; border: 1px solid transparent;
  }
  .syncmsg:empty { display: none; }
  .syncmsg.busy { color: #4da3ff; background: rgba(77,163,255,.1); border-color: rgba(77,163,255,.35); }
  .syncmsg.ok { color: #3fb950; background: rgba(63,185,80,.1); border-color: rgba(63,185,80,.35); }
  .syncmsg.bad { color: #f85149; background: rgba(248,81,73,.1); border-color: rgba(248,81,73,.35); }

  /* ── 信箱与投票（2026-10-23 加）── */
  .tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .tab {
    font-size: 12.5px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--dsw-alias-border-l2, #2a3242);
    background: transparent; color: var(--dsw-alias-label-secondary, #8b98a9);
  }
  .tab.active {
    background: rgba(77,163,255,.14); border-color: rgba(77,163,255,.5);
    color: var(--dsw-alias-brand-primary, #4da3ff); font-weight: 600;
  }
  .letter {
    border: 1px solid rgba(127,160,255,.14); border-radius: 10px;
    padding: 13px 15px; margin-bottom: 12px;
    background: rgba(127,160,255,.03);
  }
  .letter h3 { font-size: 13px; margin: 0 0 4px; }
  .letter .meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8b98a9); margin-bottom: 9px; }
  .letter pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font: 12.5px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    color: var(--dsw-alias-label-primary, #e6edf3);
  }
  .prop {
    border: 1px solid rgba(127,160,255,.16); border-radius: 10px;
    padding: 12px 14px; margin-bottom: 10px; background: rgba(127,160,255,.03);
  }
  .prop .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
  .prop .id { font: 600 13px/1.4 ui-monospace, Consolas, monospace; }
  .prop .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; flex: none; }
  .prop .badge.active { background: rgba(63,185,80,.16); color: #3fb950; }
  .prop .badge.pending { background: rgba(210,153,34,.16); color: #d29922; }
  .prop .badge.expired { background: rgba(139,152,169,.16); color: #8b98a9; }
  .prop .badge.conflict { background: rgba(248,81,73,.16); color: #f85149; }
  .prop .kv2 { font-size: 12px; color: var(--dsw-alias-label-secondary, #8b98a9); line-height: 1.75; }
  .prop .kv2 b { color: var(--dsw-alias-label-primary, #e6edf3); font-weight: 600; }
  .prop .why {
    margin-top: 8px; padding: 7px 10px; border-radius: 7px; font-size: 11.5px; line-height: 1.6;
    background: rgba(210,153,34,.08); color: #d29922;
  }
  .bigcode {
    font: 700 34px/1.2 ui-monospace, 'Cascadia Code', Consolas, monospace;
    letter-spacing: .24em; text-align: center; padding: 18px 0; margin-bottom: 12px;
    color: var(--dsw-alias-brand-primary, #4da3ff);
    background: rgba(77,163,255,.08);
    border: 1px dashed rgba(77,163,255,.4); border-radius: 10px;
  }
</style></head>
<body><div class="wrap">

<h1>小鲸鱼同步</h1>
<div class="sub">本端：<b>${escapeHtml(view.label)}</b> · ${escapeHtml(view.identity)}</div>

<div class="card">
  <h2>配对</h2>
  ${view.pairCode === ''
    ? '<div class="qrbox empty">还没有有效配对码<br>点下面「生成配对码」</div>'
    : `<div class="bigcode">${escapeHtml(view.pairCode)}</div>`}
  <div class="row">
    <span>有效期</span>
    <span class="cd${view.remainingMs <= 0 ? ' expired' : ''}">${view.remainingMs <= 0 ? '已过期' : `${Math.ceil(view.remainingMs / 1000)} 秒`}</span>
  </div>
  <div class="row">
    <span>已配对次数</span><span>${view.pairedCount}</span>
  </div>
  <div class="actions">
    <button id="btn-pair">生成配对码</button>
    <button id="btn-sync">立刻同步</button>
  </div>
  <div class="syncmsg" id="sync-msg"></div>
  <div class="warn">
    ⚠️ 这串码就是钥匙，拿到的人可以和本端配对。<br>
    在另一端的「小鲸鱼同步」浮层里输入它，再把上面的地址填进去。
  </div>
</div>

<div class="card">
  <h2>同步状态</h2>
  <div class="kv"><span>同步口</span><span>${view.serverPort === null ? '未启动' : `已监听 ${view.serverPort}`}</span></div>
  <div class="kv"><span>本机地址</span><span>${Array.isArray(view.lanAddresses) && view.lanAddresses.length > 0
    ? view.lanAddresses.map(escapeHtml).join(' 或 ')
    : '（没找到局域网地址）'}</span></div>
  <div class="kv"><span>对端</span><span>${view.peer === '' ? '未配对' : escapeHtml(view.peer)}</span></div>
  <div class="kv"><span>同步范围</span><span>${escapeHtml(view.targets)}</span></div>
  <div class="kv"><span>自动同步</span><span>${view.autoSyncText}</span></div>
  <div class="kv"><span>上次同步</span><span>${view.lastSyncAt === null ? '还没同步过' : escapeHtml(view.lastSyncAt)}</span></div>
  ${view.lastResult === null ? '' : `<div class="kv"><span>上次结果</span><span>${escapeHtml(view.lastResult)}</span></div>`}
  ${view.lastError === null ? '' : `<div class="kv"><span>最近错误</span><span class="err">${escapeHtml(view.lastError)}</span></div>`}
</div>

<div class="card">
  <h2>发现到的对端</h2>
  ${peers}
</div>

<div class="card">
  <h2>信箱与投票（2026-10-23 加）</h2>
  <div class="sub" style="margin-bottom:14px">
    我们俩写信的地方，以及「要同步什么」的提案投票。
    <b>两端都投 yes 才生效</b> —— 一个人不能自己扩边界。
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="letters">信箱</button>
    <button class="tab" data-tab="votes">投票（<span id="vote-count">${(view.proposals ?? []).length}</span>）</button>
  </div>
  <div id="tab-letters">
    <div id="letters-body"><div class="empty">读取中…</div></div>
  </div>
  <div id="tab-votes" style="display:none">
    <div id="votes-body">${renderProposalCards(view.proposals ?? [], view.identity)}</div>
    <div class="warn" style="margin-top:14px">
      加提案不用改代码、不用重启：在任意一端用 <code>fish_sync_targets action=add</code>，
      对端投 yes 后下次同步自动生效。<br>
      带 <code>expiresAt</code> 的到期自动失效 —— 「临时」就该是临时的。
    </div>
  </div>
</div>

<script>
(function () {
  var BASE = ${JSON.stringify(ROUTE_PATH)};
  var btnPair = document.getElementById('btn-pair');
  var btnSync = document.getElementById('btn-sync');
  var msg = document.getElementById('sync-msg');
  var poll = null;

  function post(path) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-fish-sync': '1' },
      body: '{}',
    }).then(function (r) { return r.json(); });
  }

  /**
   * 画反馈条。tone: busy / ok / bad
   * 2026-10-23 加 —— 原来成功什么都不显示，只有失败 alert。
   */
  function say(tone, text) {
    if (!msg) return;
    msg.className = 'syncmsg ' + tone;
    msg.textContent = text;
  }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  /** 轮询宿主侧的同步阶段（后端 state.syncing），让进度条真的在动。 */
  function startPoll() {
    stopPoll();
    poll = setInterval(function () {
      fetch(BASE + '/api/state', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          var sy = s && s.syncing;
          if (!sy || sy.active !== true) return;
          var secs = typeof sy.elapsedMs === 'number' ? (sy.elapsedMs / 1000).toFixed(1) : '';
          say('busy', '同步中 · ' + (sy.stage || '处理中') + (secs === '' ? '' : ' · ' + secs + ' 秒'));
        })
        .catch(function () { /* 轮询失败静默，真结果由 POST 响应报 */ });
    }, 500);
  }

  btnPair.addEventListener('click', function () {
    btnPair.disabled = true;
    post('/api/pair').then(function (j) {
      if (j && j.ok) {
        say('ok', '已生成新的配对码，刷新页面可看到');
        setTimeout(function () { location.reload(); }, 600);
      } else {
        say('bad', '生成失败：' + (j && j.error ? j.error : '未知原因'));
      }
    }).catch(function (e) { say('bad', '生成失败：' + (e.message || e)); })
      .finally(function () { btnPair.disabled = false; });
  });

  btnSync.addEventListener('click', function () {
    if (btnSync.disabled) return;
    btnSync.disabled = true;
    btnSync.textContent = '同步中…';
    say('busy', '同步中 · 准备中');
    startPoll();
    post('/api/sync').then(function (j) {
      stopPoll();
      if (j && j.ok) {
        var parts = [
          '同步完成',
          '推 ' + (j.pushed || 0) + ' 个',
          '拉 ' + (j.pulled || 0) + ' 个',
          '跳过 ' + (j.skipped || 0) + ' 个',
        ];
        if (j.conflicts > 0) parts.push('冲突 ' + j.conflicts + ' 个（已保留本端）');
        if (typeof j.durationMs === 'number') parts.push(j.durationMs + ' 毫秒');
        say('ok', parts.join(' · '));
        // 不整页刷新：刷了就把这条提示冲掉了。3 秒后自己刷一次拿最新状态。
        setTimeout(function () { location.reload(); }, 3000);
      } else {
        say('bad', '同步失败：' + (j && j.error ? j.error : '未知原因'));
      }
    }).catch(function (e) {
      stopPoll();
      say('bad', '同步失败：' + (e.message || e));
    }).finally(function () {
      btnSync.disabled = false;
      btnSync.textContent = '立刻同步';
    });
  });

  // 打开页面时如果后端正在同步，自动接上进度
  fetch(BASE + '/api/state', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s && s.syncing && s.syncing.active === true) {
        btnSync.disabled = true;
        btnSync.textContent = '同步中…';
        startPoll();
      }
    })
    .catch(function () { /* 静默 */ });

  // 倒计时
  var cd = document.querySelector('.cd');
  var left = ${Math.max(0, Math.ceil(view.remainingMs / 1000))};
  if (cd && left > 0) {
    var t = setInterval(function () {
      left -= 1;
      if (left <= 0) { cd.textContent = '已过期'; cd.className = 'cd expired'; clearInterval(t); }
      else { cd.textContent = left + ' 秒'; }
    }, 1000);
  }

  // ── 信箱与投票（2026-10-23 加）────────────────────────────
  // 主人要能「看看你们的聊天还有投票」。
  var lettersLoaded = false;

  /**
   * 加载两封信。
   * 走 /api/letters —— 服务端直接读文件，前端不做路径拼接。
   */
  function loadLetters() {
    if (lettersLoaded) return;
    lettersLoaded = true;
    var box = document.getElementById('letters-body');
    if (!box) return;
    fetch(BASE + '/api/letters', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          box.innerHTML = '<div class="empty">读信箱失败：'
            + escapeText(j && j.error ? j.error : '未知') + '</div>';
          lettersLoaded = false;
          return;
        }
        var list = j.letters || [];
        if (list.length === 0) {
          box.innerHTML = '<div class="empty">信箱还是空的。</div>';
          return;
        }
        box.innerHTML = list.map(function (L) {
          var body = L.text === '' ? '（空文件）' : L.text;
          // 太长就折起来：默认只显示前 3000 字，避免一页几万字卡死
          var truncated = body.length > 3000;
          var shown = truncated ? body.slice(0, 3000) : body;
          return '<div class="letter">'
            + '<h3>' + escapeText(L.label) + '</h3>'
            + '<div class="meta">' + escapeText(L.rel)
            + ' · ' + L.bytes + ' 字节'
            + (L.mtime ? ' · 改于 ' + escapeText(L.mtime) : '')
            + '</div>'
            + '<pre>' + escapeText(shown) + (truncated ? '\\n\\n……（后面还有 ' + (body.length - 3000) + ' 字，看全文请直接开文件）' : '') + '</pre>'
            + '</div>';
        }).join('');
      })
      .catch(function (e) {
        box.innerHTML = '<div class="empty">读信箱失败：' + escapeText(String(e && e.message || e)) + '</div>';
        lettersLoaded = false;
      });
  }

  /**
   * 转义 HTML（前端侧，服务端已转义过的字段不重复转）。
   * @param {string} s - 原值。
   * @returns {string} 转义结果。
   */
  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 标签切换
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      var name = this.getAttribute('data-tab');
      var all = document.querySelectorAll('.tab');
      for (var k = 0; k < all.length; k++) all[k].className = 'tab';
      this.className = 'tab active';
      document.getElementById('tab-letters').style.display = name === 'letters' ? '' : 'none';
      document.getElementById('tab-votes').style.display = name === 'votes' ? '' : 'none';
      if (name === 'letters') loadLetters();
    });
  }

  // 默认显示信箱，直接加载
  loadLetters();
})();
</script>
</div></body></html>`
}

/**
 * 渲染提案卡片（给主人看的投票界面）。
 *
 * 2026-10-23 加。主人原话：
 * > 「最好插件你们的信箱可以让我看看，看看你们的聊天还有投票」
 *
 * 所以这里**不给操作按钮** —— 主人是来看的，不是来投票的。
 * 投票是我们俩的事（`fish_sync_targets` 工具），他只需要看得懂现在什么状态。
 *
 * @param {object[]} proposals - 提案列表。
 * @param {string} me - 本端身份。
 * @returns {string} HTML。
 */
function renderProposalCards(proposals, me) {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return '<div class="empty">还没有任何提案。想加同步内容时，在任意一端用 '
      + '<code>fish_sync_targets action=add</code> 提一条，对端投 yes 就生效。</div>'
  }
  return proposals.map((p) => {
    const yes = Object.keys(p.votes ?? {}).filter((k) => p.votes[k] === 'yes')
    const badge = p.conflict === true
      ? '<span class="badge conflict">冲突</span>'
      : p.state === 'active'
        ? '<span class="badge active">已生效</span>'
        : p.state === 'expired'
          ? '<span class="badge expired">已过期</span>'
          : '<span class="badge pending">待投票</span>'

    const whoText = yes.length === 0 ? '还没人投' : yes.map((k) => (k === me ? '我（本端）' : '对端')).join(' + ')

    /** 为什么卡在待投票 —— 说清楚，别让人猜。 */
    let why = ''
    if (p.conflict === true) {
      why = `两端提了同名但路径不同的提案：${(p.relConflict ?? []).map(escapeHtml).join(' vs ')}。`
        + '需要一方撤回后重提。'
    } else if (p.state === 'pending') {
      why = `还差一票：${yes.length}/2。两端都 yes 才生效 —— 一个人不能自己扩同步范围。`
    } else if (p.state === 'expired') {
      why = '已过期，不再同步。要恢复就重新提一条。'
    }

    return `
      <div class="prop">
        <div class="head">
          <span class="id">${escapeHtml(p.id)}</span>
          ${badge}
        </div>
        <div class="kv2">
          路径 <b>${escapeHtml(p.rel)}</b>
          （${p.mode === 'file' ? '单文件' : `最近 ${escapeHtml(String(p.days))} 天`}）<br>
          说明 <b>${escapeHtml(p.label)}</b><br>
          提出 <b>${p.proposedBy === me ? '我（本端）' : '对端'}</b>
          · 票 <b>${escapeHtml(whoText)}</b>（${yes.length}/2）<br>
          过期 <b>${p.expiresAt === null ? '长期有效' : escapeHtml(p.expiresAt)}</b>
        </div>
        ${why === '' ? '' : `<div class="why">${why}</div>`}
      </div>`
  }).join('')
}

/**
 * HTML 转义（页面里所有外部字符串都要过一遍）。
 * @param {unknown} s - 原值。
 * @returns {string} 转义结果。
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 建管理路由。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.ctx - 插件上下文（要有 connection）。
 * @param {object} deps.cfg - 配置。
 * @param {object} deps.pairing - 配对服务。
 * @param {Function} deps.state - 返回状态快照。
 * @param {Function} deps.qrText - 返回二维码文本或 null。
 * @param {Function} deps.syncNow - 触发同步。
 * @returns {Function} (req, res) 处理函数。
 */
export function createHandler(deps) {
  return async function handle(req, res) {
    try {
      // ── 认证 ──────────────────────────────────────────────────
      // **回环请求直接放行**（2026-10-22 真机踩到后改的）。
      //
      // 为什么：桌面端页面源是 `dsh-app://app`，对 `http://127.0.0.1:PORT`
      // 属于**跨源** —— fetch 不会带上 dsh 的会话 cookie（SameSite=Strict），
      // 于是 `requestRejection` 一律返回 401，前端拿到 401 → 白条。
      //
      // 为什么放行是安全的：管理面挂在 dsh 本体上，而本体绑的是 127.0.0.1，
      // **只有本机进程能连**。局域网设备根本连不到这个端口。
      // 手机端 DSH 同理（WebView 走 127.0.0.1）。
      //
      // 对照：dsh-lan-connect 的管理面需要认证，是因为它另开了 0.0.0.0:3099
      // 暴露在局域网上 —— 我们的情况不同。
      const remote = req.socket.remoteAddress ?? ''
      const isLoopback = remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
        || remote.startsWith('127.')

      if (!isLoopback) {
        let rejection
        try {
          rejection = deps.ctx?.connection?.requestRejection?.(req)
        } catch {
          rejection = 401
        }
        if (rejection !== undefined) {
          const status = typeof rejection === 'number' ? rejection : 401
          sendJson(res, status, { ok: false, error: '需要先登录本机 DSH' })
          return
        }
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const sub = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : url.pathname

      // ── API ────────────────────────────────────────────────────
      if (sub === '/api/state' && req.method === 'GET') {
        const snap = deps.state()
        sendJson(res, 200, { ok: true, ...snap })
        return
      }

      if (sub === '/api/pair' && req.method === 'POST') {
        // CSRF 栅栏：写操作要求带自定义头（跨站表单带不了）
        if (req.headers['x-dsh-fish-sync'] !== '1') {
          sendJson(res, 403, { ok: false, error: '缺少 X-DSH-Fish-Sync 头' })
          return
        }
        deps.pairing.issue()
        sendJson(res, 200, { ok: true, ...deps.pairing.status() })
        return
      }

      if (sub === '/api/sync' && req.method === 'POST') {
        if (req.headers['x-dsh-fish-sync'] !== '1') {
          sendJson(res, 403, { ok: false, error: '缺少 X-DSH-Fish-Sync 头' })
          return
        }
        const result = await deps.syncNow()
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      // ── 用配对码去连对端（2026-10-22 加）────────────────────
      // 这是**手机端**真正要用的那条路：主人看电脑屏幕上的 6 位码，
      // 在手机浮层里输入，手机端主动 POST 到电脑端换密钥。
      // 系统浏览器扫码做不到这件事（拿不到插件里去），所以必须有这个端点。
      if (sub === '/api/join' && req.method === 'POST') {
        if (req.headers['x-dsh-fish-sync'] !== '1') {
          sendJson(res, 403, { ok: false, error: '缺少 X-DSH-Fish-Sync 头' })
          return
        }
        const body = await readJson(req)
        const code = typeof body?.code === 'string' ? body.code.trim() : ''
        const host = typeof body?.host === 'string' ? body.host.trim() : ''
        const port = Number(body?.port)
        if (code === '') {
          sendJson(res, 400, { ok: false, error: '请填配对码' })
          return
        }
        if (host === '' || !Number.isFinite(port) || port <= 0) {
          sendJson(res, 400, { ok: false, error: '请填对端地址（如 192.168.1.10:3098）' })
          return
        }
        const result = await deps.joinPeer({ code, host, port })
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      // ── 信箱内容（2026-10-23 加）─────────────────────────────
      // 主人原话：「最好插件你们的信箱可以让我看看，看看你们的聊天还有投票」
      //
      // ⚠️ 这个端点**只读固定的两封信**，不接受任何路径参数 ——
      // 一旦能传路径，它就是「读任意文件」的口子，而管理面是浏览器可达的。
      // 硬编码路径 = 最小攻击面。
      if (sub === '/api/letters' && req.method === 'GET') {
        /** 固定的两封信，路径写死。 */
        const LETTERS = [
          { rel: 'yiqishard/信箱/大肥鱼.md', label: '大肥鱼的信（电脑端写的）' },
          { rel: 'yiqishard/信箱/小肥鱼.md', label: '小肥鱼的信（手机端写的）' },
        ]
        const letters = []
        for (const item of LETTERS) {
          const abs = join(deps.home ?? '', item.rel)
          try {
            const text = await readFile(abs, 'utf8')
            const st = await stat(abs)
            letters.push({
              rel: item.rel,
              label: item.label,
              bytes: Buffer.byteLength(text),
              mtime: st.mtime.toISOString(),
              text,
            })
          } catch {
            // 还没这封信 —— 正常，不是错误
            letters.push({
              rel: item.rel,
              label: item.label,
              bytes: 0,
              mtime: null,
              text: '',
              missing: true,
            })
          }
        }
        sendJson(res, 200, { ok: true, letters })
        return
      }

      // ── 管理页 ─────────────────────────────────────────────────
      if (sub === '' || sub === '/' || sub === '/index.html') {
        const snap = deps.state()
        sendHtml(res, renderPage({
          ...snap,
          qrText: deps.qrText(),
        }))
        return
      }

      sendJson(res, 404, { ok: false, error: '未知端点' })
    } catch (error) {
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch { /* 响应可能已发 */ }
    }
  }
}
