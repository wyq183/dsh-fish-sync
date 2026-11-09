/**
 * dsh-fish-sync — 客户端插件（web GUI 半侧）
 *
 * 干一件事：在**左侧栏**注入「小鲸鱼同步」入口。点一下直接在页面里弹出浮层，
 * 显示配对二维码与倒计时——不用另开标签页。
 *
 * 格式照 dsh-lan-connect/lib/client.js（本机已验证可用的写法）：
 * 手写 `__ModuleLoader__.load` 闭包工厂，不需要构建步骤。
 *
 * 关于选择器：本仓库前端用 CSS Modules，类名形如 `<hash>_<local>`。
 * 直接写死 hash 会随 dsh 重新构建而失效，所以一律用 `[class*="local名"]`
 * 做宽松匹配。浮层挂在自己的节点上，不去猜宿主的 DOM 结构。
 */

window.__ModuleLoader__.load({
  // ⚠️ id 必须是**完整包名**，与 package.json 的 name 逐字一致。
  //    写短名（如 "dsh-fish-sync"）会静默失败：脚本执行了，但宿主按完整包名
  //    找不到注册 → `loaded without registering ... via __ModuleLoader__.load`
  //    → web boot「1 entry did not activate」→ **整页白屏**。
  //    （2026-10-22 真机上踩到，白屏排查了两小时。）
  id: "@dsh-external/dsh-fish-sync",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var BASE = "/ext/fish-sync";
    var STYLE_ID = "dsh-fish-sync/sidebar-entry.css";
    var BUTTON_CLASS = "dfs-entry";
    var PANEL_CLASS = "dfs-panel";
    var BACKDROP_CLASS = "dfs-backdrop";

    var css = [
      "." + BUTTON_CLASS + "{",
      "  display:flex;align-items:center;gap:8px;margin:6px 10px;padding:8px 12px;",
      "  border-radius:8px;cursor:pointer;user-select:none;",
      "  font-size:13px;font-weight:600;line-height:1.4;",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.08));",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  transition:background .15s, border-color .15s;",
      "}",
      "." + BUTTON_CLASS + ":hover{",
      "  background:var(--dsw-alias-interactive-bg-hover-solid, rgba(127,160,255,.16));",
      "  border-color:var(--dsw-alias-brand-primary, #4da3ff);",
      "}",
      "." + BUTTON_CLASS + " .dfs-icon{font-size:15px;line-height:1}",
      "." + BUTTON_CLASS + " .dfs-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "." + BUTTON_CLASS + " .dfs-badge{",
      "  font-size:10px;padding:1px 6px;border-radius:999px;font-weight:600;",
      "  background:rgba(63,185,80,.18);color:#3fb950;",
      "}",
      "body[data-ds-collapsed] ." + BUTTON_CLASS + "{display:none}",

      "." + BACKDROP_CLASS + "{",
      "  position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;",
      "  background:rgba(0,0,0,.55);padding:20px;",
      "}",
      "." + PANEL_CLASS + "{",
      "  width:min(430px,100%);max-height:90vh;overflow:auto;",
      "  background:var(--dsw-alias-bg-base, #151b23);",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  border-radius:14px;padding:20px;",
      "  box-shadow:0 18px 60px rgba(0,0,0,.5);",
      "  font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;",
      "}",
      "." + PANEL_CLASS + " h3{margin:0 0 2px;font-size:16px}",
      "." + PANEL_CLASS + " .dfs-sub{color:var(--dsw-alias-label-secondary,#8b98a9);font-size:12px;margin-bottom:16px}",
      "." + PANEL_CLASS + " .dfs-qr{",
      "  width:220px;height:220px;margin:0 auto 12px;background:#fff;border-radius:10px;padding:8px;",
      "}",
      "." + PANEL_CLASS + " .dfs-qr svg{width:100%;height:100%;display:block}",
      "." + PANEL_CLASS + " .dfs-qr.dfs-empty{",
      "  background:rgba(127,160,255,.06);border:1px dashed var(--dsw-alias-border-l2,#2a3242);",
      "  display:flex;align-items:center;justify-content:center;text-align:center;",
      "  color:var(--dsw-alias-label-secondary,#8b98a9);font-size:12px;padding:16px;",
      "}",
      "." + PANEL_CLASS + " .dfs-line{",
      "  display:flex;justify-content:space-between;align-items:center;",
      "  font-size:12.5px;margin-bottom:10px;color:var(--dsw-alias-label-secondary,#8b98a9);",
      "}",
      "." + PANEL_CLASS + " .dfs-cd{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary,#4da3ff)}",
      "." + PANEL_CLASS + " .dfs-cd.dfs-expired{color:#d29922}",
      "." + PANEL_CLASS + " .dfs-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}",
      "." + PANEL_CLASS + " button{",
      "  font:inherit;font-size:13px;padding:7px 14px;border-radius:8px;cursor:pointer;",
      "  border:1px solid var(--dsw-alias-border-l2,#2a3242);",
      "  background:var(--dsw-alias-interactive-bg-hover,rgba(127,160,255,.08));",
      "  color:var(--dsw-alias-label-primary,#e6edf3);",
      "}",
      "." + PANEL_CLASS + " button:hover{border-color:var(--dsw-alias-brand-primary,#4da3ff)}",
      "." + PANEL_CLASS + " button:disabled{opacity:.5;cursor:default}",
      "." + PANEL_CLASS + " .dfs-close{",
      "  float:right;cursor:pointer;font-size:18px;line-height:1;",
      "  color:var(--dsw-alias-label-secondary,#8b98a9);padding:0 4px;",
      "}",
      "." + PANEL_CLASS + " .dfs-warn{",
      "  margin-top:12px;padding:9px 11px;border-radius:8px;font-size:12px;",
      "  background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.35);color:#d29922;",
      "}",
      "." + PANEL_CLASS + " .dfs-err{color:#f85149;font-size:12px;margin-top:8px}",
      "." + PANEL_CLASS + " .dfs-ok{",
      "  padding:9px 11px;border-radius:8px;font-size:12.5px;margin-bottom:12px;",
      "  background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.35);color:#3fb950;",
      "}",
      // ── 状态条（2026-10-23 加）──
      // 原来只有失败才 alert，成功什么都不显示，同步中也只有按钮变灰。
      // 主人原话：「点按钮同步成功没有也不会弹提示也没有进度提示，只有连接失败会有提示」。
      // 现在这条常驻在按钮下面：同步中显示阶段 + 已耗时，结束显示结果（成功也显示）。
      "." + PANEL_CLASS + " .dfs-status{",
      "  margin-top:10px;padding:9px 11px;border-radius:8px;font-size:12.5px;line-height:1.5;",
      "  border:1px solid transparent;word-break:break-all;",
      "}",
      "." + PANEL_CLASS + " .dfs-status:empty{display:none}",
      "." + PANEL_CLASS + " .dfs-status.dfs-busy{",
      "  color:var(--dsw-alias-brand-primary,#4da3ff);",
      "  background:rgba(77,163,255,.1);border-color:rgba(77,163,255,.35);",
      "}",
      "." + PANEL_CLASS + " .dfs-status.dfs-ok{",
      "  color:#3fb950;background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.35);",
      "}",
      "." + PANEL_CLASS + " .dfs-status.dfs-bad{",
      "  color:#f85149;background:rgba(248,81,73,.1);border-color:rgba(248,81,73,.35);",
      "}",
      // 同步中的跑马灯，让它「看起来在动」——静止的文案骗不了人。
      "." + PANEL_CLASS + " .dfs-status.dfs-busy::after{",
      "  content:'';display:block;height:2px;margin-top:7px;border-radius:2px;",
      "  background:linear-gradient(90deg,transparent,rgba(77,163,255,.9),transparent);",
      "  background-size:200% 100%;animation:dfs-sweep 1.1s linear infinite;",
      "}",
      "@keyframes dfs-sweep{from{background-position:100% 0}to{background-position:-100% 0}}",
      "." + PANEL_CLASS + " .dfs-meta{",
      "  margin-top:10px;font-size:11.5px;line-height:1.7;",
      "  color:var(--dsw-alias-label-secondary,#8b98a9);",
      "}",
      "." + PANEL_CLASS + " .dfs-meta b{color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600}",
      "." + PANEL_CLASS + " .dfs-code{",
      "  font:700 30px/1.2 ui-monospace,'Cascadia Code',Consolas,monospace;",
      "  letter-spacing:.22em;text-align:center;padding:14px 0;margin-bottom:8px;",
      "  color:var(--dsw-alias-brand-primary,#4da3ff);",
      "  background:rgba(77,163,255,.08);border:1px dashed rgba(77,163,255,.4);border-radius:10px;",
      "}",
      "." + PANEL_CLASS + " .dfs-join{",
      "  margin-top:14px;padding-top:14px;border-top:1px solid rgba(127,160,255,.12);",
      "}",
      "." + PANEL_CLASS + " .dfs-join-title{",
      "  font-size:12px;color:var(--dsw-alias-label-secondary,#8b98a9);margin-bottom:8px;",
      "}",
      "." + PANEL_CLASS + " .dfs-input{",
      "  display:block;width:100%;margin-bottom:8px;padding:8px 10px;border-radius:8px;",
      "  font:inherit;font-size:13px;box-sizing:border-box;",
      "  color:var(--dsw-alias-label-primary,#e6edf3);",
      "  background:rgba(127,160,255,.06);",
      "  border:1px solid var(--dsw-alias-border-l2,#2a3242);",
      "}",
      "." + PANEL_CLASS + " .dfs-input:focus{",
      "  outline:none;border-color:var(--dsw-alias-brand-primary,#4da3ff);",
      "}",
    ].join("\n");

    /**
     * 注入样式表（幂等）。
     */
    function injectCss() {
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = css;
      document.head.appendChild(el);
    }

    /** 浮层节点。 */
    var backdrop = null;
    /** 倒计时定时器。 */
    var cdTimer = null;
    /** 同步进度轮询定时器。 */
    var pollTimer = null;

    /**
     * 面板内的临时 UI 状态。
     *
     * 为什么不直接改 DOM：`renderPanel` 会整块重建 `innerHTML`，
     * 任何直接写进去的东西都会在下一次 refresh 时被冲掉。
     * 所以状态存在这里，渲染时读它 —— 重建多少次都不会丢。
     *
     * 2026-10-23 加（主人报「成功没提示、没进度」）。
     */
    var ui = {
      /** 是否正在同步。 */
      busy: false,
      /** 同步中的阶段文案。 */
      stage: '',
      /** 结束后的结果提示：{ tone: 'ok'|'bad', text } 或 null。 */
      message: null,
    };

    /**
     * 拉状态。
     * @returns {Promise<object>} 状态。
     */
    function fetchState() {
      return fetch(BASE + "/api/state", { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); });
    }

    /**
     * 发一个写请求（带 CSRF 栅栏头）。
     * @param {string} path - 路径。
     * @returns {Promise<object>} 结果。
     */
    function post(path) {
      return fetch(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-fish-sync": "1" },
        body: "{}",
      }).then(function (r) { return r.json(); });
    }

    /**
     * 关闭浮层。
     */
    function closePanel() {
      if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
      stopPoll();
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      backdrop = null;
    }

    /**
     * 把 ui 状态画到状态条上（只改那一个节点，不重建面板）。
     *
     * 2026-10-23 加。原来「同步」按钮的反馈只有「按钮变灰」，
     * 成功/失败/进行中三种状态在界面上完全分不开 —— 主人根本不知道点下去有没有用。
     */
    function paintStatus() {
      if (!backdrop) return;
      var el = backdrop.querySelector("#dfs-status");
      if (!el) return;
      if (ui.busy) {
        el.className = "dfs-status dfs-busy";
        el.textContent = ui.stage === "" ? "同步中…" : "同步中 · " + ui.stage;
        return;
      }
      if (ui.message !== null) {
        el.className = "dfs-status " + (ui.message.tone === "bad" ? "dfs-bad" : "dfs-ok");
        el.textContent = ui.message.text;
        return;
      }
      el.className = "dfs-status";
      el.textContent = "";
    }

    /**
     * 停止进度轮询。
     */
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /**
     * 开始轮询同步进度。
     *
     * 为什么轮询而不是长连接：同步一次通常几百毫秒到几秒，
     * 500 毫秒一次足够看出来在动，而轮询失败（比如面板已关）也无害。
     * 阶段文案由宿主侧的 `state.syncing` 提供 —— 前端不猜阶段。
     */
    function startPoll() {
      stopPoll();
      pollTimer = setInterval(function () {
        fetchState().then(function (s) {
          var sy = s && s.syncing;
          if (sy && sy.active === true) {
            var secs = typeof sy.elapsedMs === "number" ? (sy.elapsedMs / 1000).toFixed(1) : "";
            ui.stage = (sy.stage || "处理中") + (secs === "" ? "" : " · " + secs + " 秒");
            paintStatus();
          } else if (ui.busy) {
            // 后端已经收工但请求还没返回（几乎不会），把阶段定在最后一帧
            ui.stage = sy && sy.stage ? sy.stage : "收尾中";
            paintStatus();
          }
        }).catch(function () {
          // 轮询失败静默 —— 真正的失败由 /api/sync 的响应报
        });
      }, 500);
    }

    /**
     * 同步结束的统一收尾：停轮询、落提示、重绘。
     *
     * @param {object|null} result - /api/sync 的响应；null = 网络层失败。
     * @param {Error|null} error - 网络异常。
     */
    function finishSync(result, error) {
      stopPoll();
      ui.busy = false;
      ui.stage = "";
      if (error !== null) {
        ui.message = { tone: "bad", text: "同步失败（连不上本端服务）：" + (error.message || error) };
        paintStatus();
        return;
      }
      var j = result || {};
      if (j.ok === true) {
        var parts = [
          "同步完成",
          "推 " + (j.pushed || 0) + " 个",
          "拉 " + (j.pulled || 0) + " 个",
          "跳过 " + (j.skipped || 0) + " 个",
        ];
        if (j.conflicts > 0) parts.push("冲突 " + j.conflicts + " 个（已保留本端）");
        if (typeof j.durationMs === "number") parts.push(j.durationMs + " 毫秒");
        ui.message = { tone: "ok", text: parts.join(" · ") };
      } else {
        ui.message = {
          tone: "bad",
          text: "同步失败：" + (j.error || "未知原因"),
        };
      }
      // 重绘一次，把「上次同步时间 / 明细」刷新到最新；paintStatus 会在 renderPanel 末尾再画一次
      refresh();
    }

    /**
     * 把二维码文本画进容器（走服务端 SVG，前端不做编码）。
     * @param {HTMLElement} box - 容器。
     * @param {string|null} text - 二维码文本。
     */
    function paintQr(box, text) {
      if (!box) return; // 节点不在（改版删掉了）→ 静默跳过，绝不抛
      if (!text) {
        box.className = "dfs-qr dfs-empty";
        box.textContent = "还没有有效二维码，点下面「生成二维码」";
        return;
      }
      box.className = "dfs-qr";
      // 服务端渲染 SVG：这里用 <img> 引用一个 data URL 最省事，
      // 避免把 SVG 字符串直接 innerHTML（那会执行内联脚本）
      box.innerHTML = "";
      var img = document.createElement("img");
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.display = "block";
      img.alt = "配对二维码";
      // 用 /api/state 里带的 svg 字段（服务端已生成，前端只显示）
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
      box.appendChild(img);
    }

    /**
     * 渲染浮层内容。
     * @param {object} state - 状态快照。
     */
    function renderPanel(state) {
      if (!backdrop) return;
      var panel = backdrop.querySelector("." + PANEL_CLASS);
      if (!panel) return;

      var remain = Math.max(0, Math.ceil((state.remainingMs || 0) / 1000));
      var cdClass = remain > 0 ? "dfs-cd" : "dfs-cd dfs-expired";
      var cdText = remain > 0 ? remain + " 秒" : "已过期";
      var codeText = state.pairCode || "";
      var paired = state.peer && state.peer !== "";

      // 上次同步摘要（2026-10-23 加）：原来面板里根本不显示同步过没有，
      // 主人点完按钮看不到任何痕迹，自然觉得「一直有问题」。
      var metaBits = [];
      if (state.lastSyncAt) {
        metaBits.push("上次同步 <b>" + esc(fmtTime(state.lastSyncAt)) + "</b>");
      } else {
        metaBits.push("上次同步 <b>还没同步过</b>");
      }
      if (state.lastResult) metaBits.push("结果 <b>" + esc(state.lastResult) + "</b>");
      if (state.serverPort) metaBits.push("同步口 <b>" + esc(String(state.serverPort)) + "</b>");
      var metaHtml = '<div class="dfs-meta">' + metaBits.join(" · ") + "</div>";

      // 本机地址（2026-10-23 加）：对端地址失效时要重新配对，
      // 得知道该在另一端填哪个地址。本机可能挂着两个网段，全列出来让人挑。
      var lan = Array.isArray(state.lanAddresses) ? state.lanAddresses : [];
      var lanHtml = lan.length === 0
        ? ""
        : '<div class="dfs-meta">本机地址 <b>' + lan.map(function (a) { return esc(a); }).join("</b> 或 <b>") + "</b>（在另一端填这个）</div>";

      panel.innerHTML =
        '<span class="dfs-close" id="dfs-x">×</span>' +
        "<h3>小鲸鱼同步</h3>" +
        '<div class="dfs-sub">本端 ' + esc(state.label || "") +
        " · " + esc(state.identity || "") + "</div>" +

        // ── 已配对：只显示状态 ──
        (paired
          ? '<div class="dfs-ok">✅ 已配对：' + esc(state.peer) + "</div>"
          : "") +

        // ── 配对码（本端出码，给对方输）──
        (codeText !== ""
          ? '<div class="dfs-code" id="dfs-code">' + esc(codeText) + "</div>" +
            '<div class="dfs-line"><span>配对码有效期</span><span class="' + cdClass + '" id="dfs-cd">' + cdText + "</span></div>"
          : "") +

        // ── 输码配对（去连对方）──
        '<div class="dfs-join">' +
        '<div class="dfs-join-title">输入对方的配对码</div>' +
        '<input id="dfs-in-code" class="dfs-input" placeholder="6 位码" maxlength="8" autocapitalize="characters" autocomplete="off">' +
        '<input id="dfs-in-host" class="dfs-input" placeholder="对方地址，如 192.168.1.10:3098" autocomplete="off" value="' + esc(state.peer || "") + '">' +
        '<button id="dfs-join-btn">配对</button>' +
        "</div>" +

        '<div class="dfs-actions">' +
        '<button id="dfs-pair">' + (codeText === "" ? "生成配对码" : "换一个码") + "</button>" +
        '<button id="dfs-sync"' + (ui.busy ? " disabled" : "") + ">" + (ui.busy ? "同步中…" : "立刻同步") + "</button>" +
        "</div>" +
        // 状态条：同步中/成功/失败都往这里写
        '<div class="dfs-status" id="dfs-status"></div>' +
        metaHtml +
        lanHtml +
        '<div class="dfs-warn">⚠️ 配对码就是钥匙，拿到的人可以和本端配对。<br>只在两台自己的设备之间用，别截图外传。</div>' +
        (state.lastError ? '<div class="dfs-err">' + esc(state.lastError) + "</div>" : "");

      // 状态条要跟着重建一起画回来（ui 里的状态没丢）
      paintStatus();

      // 打开面板时如果后端正在同步，自动接上进度轮询
      if (!ui.busy && state.syncing && state.syncing.active === true) {
        ui.busy = true;
        ui.stage = state.syncing.stage || "处理中";
        paintStatus();
        startPoll();
      }

      // ⚠️ 这里**不能**再调 paintQr：改版后浮层里已经没有 #dfs-qr 那个节点了
      //    （改成显示 6 位配对码）。之前残留这行导致
      //    `Cannot set properties of null (setting 'className')`
      //    → 整个 renderPanel 抛错 → 浮层只剩空壳。
      //    （2026-10-22 真机踩到。）

      // 绑定
      on(panel, "#dfs-x", "click", closePanel);
      on(panel, "#dfs-pair", "click", function () {
        var btn = this;
        btn.disabled = true;
        post("/api/pair").then(function (j) {
          if (j && j.ok) {
            ui.message = { tone: "ok", text: "已生成新的配对码，在另一端输入它即可" };
            refresh();
          } else {
            ui.message = { tone: "bad", text: "生成失败：" + (j && j.error ? j.error : "未知原因") };
            paintStatus();
          }
        }).catch(function (e) {
          ui.message = { tone: "bad", text: "生成失败：" + (e.message || e) };
          paintStatus();
        })
          .finally(function () { btn.disabled = false; });
      });

      // 输码配对
      on(panel, "#dfs-join-btn", "click", function () {
        var btn = this;
        var codeEl = panel.querySelector("#dfs-in-code");
        var hostEl = panel.querySelector("#dfs-in-host");
        var code = (codeEl && codeEl.value || "").trim();
        var hostText = (hostEl && hostEl.value || "").trim();
        if (code === "") {
          ui.message = { tone: "bad", text: "请填配对码" };
          paintStatus();
          return;
        }
        var m = hostText.match(/^([^:\s]+):(\d+)$/);
        if (!m) {
          ui.message = { tone: "bad", text: "地址格式应为 192.168.1.10:3098" };
          paintStatus();
          return;
        }
        btn.disabled = true;
        btn.textContent = "配对中…";
        ui.message = null;
        fetch(BASE + "/api/join", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-fish-sync": "1" },
          body: JSON.stringify({ code: code, host: m[1], port: Number(m[2]) }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) {
            ui.message = { tone: "ok", text: "配对成功：已连上 " + (j.peer || m[1] + ":" + m[2]) };
            refresh();
          } else {
            ui.message = { tone: "bad", text: "配对失败：" + (j && j.error ? j.error : "未知原因") };
            paintStatus();
          }
        }).catch(function (e) {
          ui.message = { tone: "bad", text: "配对失败：" + (e.message || e) };
          paintStatus();
        })
          .finally(function () { btn.disabled = false; btn.textContent = "配对"; });
      });

      // 立刻同步 —— 成功也必须有反馈（2026-10-23 修，主人报的正是这条）
      on(panel, "#dfs-sync", "click", function () {
        var btn = this;
        if (ui.busy) return;
        btn.disabled = true;
        btn.textContent = "同步中…";
        ui.busy = true;
        ui.stage = "准备中";
        ui.message = null;
        paintStatus();
        startPoll();
        post("/api/sync").then(function (j) {
          finishSync(j, null);
        }).catch(function (e) {
          finishSync(null, e);
        }).finally(function () {
          btn.disabled = false;
          btn.textContent = "立刻同步";
        });
      });

      // 倒计时
      if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
      if (remain > 0) {
        var left = remain;
        cdTimer = setInterval(function () {
          left -= 1;
          var el = document.querySelector("#dfs-cd");
          if (!el) { clearInterval(cdTimer); cdTimer = null; return; }
          if (left <= 0) {
            el.textContent = "已过期";
            el.className = "dfs-cd dfs-expired";
            clearInterval(cdTimer);
            cdTimer = null;
          } else {
            el.textContent = left + " 秒";
          }
        }, 1000);
      }
    }

    /**
     * 重新拉状态并重绘。
     */
    function refresh() {
      fetchState().then(function (state) {
        if (state && state.ok !== false) {
          renderPanel(state);
        } else {
          renderError("后端返回异常：" + (state && state.error ? state.error : "未知"));
        }
      }).catch(function (e) {
        renderError("连不上后端（" + (e && e.message ? e.message : e) + "）。"
          + "可能管理面没挂上，检查 DSH 日志里的 fish-sync。");
      });
    }

    /**
     * 渲染错误态（替代空白面板）。
     *
     * ⚠️ 空盒子是最糟糕的失败表现（2026-10-22 真机踩到）：
     *   原来 catch 里什么都不做 → panel 保持空 div → 用户只看到一条白竖条，
     *   完全不知道发生了什么。**失败必须看得见。**
     *
     * @param {string} message - 错误信息。
     */
    function renderError(message) {
      if (!backdrop) return;
      var panel = backdrop.querySelector("." + PANEL_CLASS);
      if (!panel) return;
      panel.innerHTML =
        '<span class="dfs-close" id="dfs-x">×</span>'
        + "<h3>小鲸鱼同步</h3>"
        + '<div class="dfs-sub">读取状态失败</div>'
        + '<div class="dfs-err">' + esc(message) + "</div>"
        + '<div class="dfs-actions"><button id="dfs-retry">重试</button></div>';
      var x = panel.querySelector("#dfs-x");
      if (x) x.addEventListener("click", closePanel);
      var retry = panel.querySelector("#dfs-retry");
      if (retry) retry.addEventListener("click", refresh);
    }

    /**
     * 打开浮层。
     */
    function openPanel() {
      if (backdrop) return;
      backdrop = document.createElement("div");
      backdrop.className = BACKDROP_CLASS;
      backdrop.innerHTML = '<div class="' + PANEL_CLASS + '"></div>';
      backdrop.addEventListener("click", function (e) {
        if (e.target === backdrop) closePanel();
      });
      document.body.appendChild(backdrop);
      refresh();
    }

    /**
     * 安全地给节点绑事件：节点不存在就跳过，不抛。
     *
     * 为什么需要（2026-10-22 真机踩到）：
     *   `panel.querySelector("#x").addEventListener(...)` 在节点不存在时
     *   会抛 `Cannot set properties of null`，整个渲染函数挂掉 →
     *   浮层只剩空壳，用户只看到一条白条。
     *   渲染代码里的每个选择器都可能因为改版/条件分支而取不到节点，
     *   所以一律走这个函数。
     *
     * @param {ParentNode} root - 查找范围。
     * @param {string} sel - 选择器。
     * @param {string} ev - 事件名。
     * @param {Function} fn - 回调。
     */
    function on(root, sel, ev, fn) {
      var el = root && root.querySelector ? root.querySelector(sel) : null;
      if (el && typeof el.addEventListener === "function") el.addEventListener(ev, fn);
      return el;
    }
    /**
     * 转义 HTML。
     * @param {unknown} s - 原值。
     * @returns {string} 转义结果。
     */
    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    /**
     * 把 ISO 时间转成本地「月-日 时:分:秒」。
     *
     * 后端存的是 `toISOString()`（UTC），`new Date()` 会按本机时区还原，
     * 所以这里不用手动加 8 小时 —— 手加反而错。
     *
     * @param {string} iso - ISO 字符串。
     * @returns {string} 显示用时间。
     */
    function fmtTime(iso) {
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        return (d.getMonth() + 1) + "-" + p(d.getDate())
          + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      } catch (e) {
        return String(iso);
      }
    }

    /**
     * 造左栏按钮。
     * @returns {HTMLElement} 按钮。
     */
    function makeButton() {
      var btn = document.createElement("div");
      btn.className = BUTTON_CLASS;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.title = "小鲸鱼同步：配对手机与电脑，同步任务和今日记忆";
      btn.innerHTML = '<span class="dfs-icon">🐋</span>'
        + '<span class="dfs-label">小鲸鱼同步</span>';
      btn.addEventListener("click", openPanel);
      btn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(); }
      });
      return btn;
    }

    /**
     * 找到侧边栏列——hash 无关的宽松匹配。
     * @returns {HTMLElement|null} 侧边栏。
     */
    function findSidebar() {
      return document.querySelector('[class*="sidebarCol"]')
        || document.querySelector('[class*="sidebar"] [class*="footArea"]');
    }

    /**
     * 把入口按钮插到侧边栏脚部之上；找不到脚部就追加到列尾。
     * @returns {boolean} 是否已挂上。
     */
    function mountEntry() {
      var col = findSidebar();
      if (!col) return false;
      if (col.querySelector("." + BUTTON_CLASS)) return true;
      var btn = makeButton();
      var foot = col.querySelector('[class*="footArea"]') || col.querySelector('[class*="settingsArea"]');
      if (foot && foot.parentElement) foot.parentElement.insertBefore(btn, foot);
      else col.appendChild(btn);
      return true;
    }

    /**
     * 摘掉入口按钮。
     */
    function unmountEntry() {
      if (typeof document === "undefined") return;
      var nodes = document.querySelectorAll("." + BUTTON_CLASS);
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    }

    /**
     * 插件入口。React 会重渲染侧边栏把节点冲掉，所以用轻量定时器兜住；
     * 返回的 disposer 把所有东西撤干净。
     * @param {object} ctx - 客户端上下文。
     * @returns {Function} disposer。
     */
    function apply(ctx) {
      injectCss();
      mountEntry();
      var mountTimer = setInterval(mountEntry, 1500);
      return function () {
        clearInterval(mountTimer);
        closePanel();
        unmountEntry();
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
