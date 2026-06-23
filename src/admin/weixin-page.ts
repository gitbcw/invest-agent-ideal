export function renderWeixinAdminPage(options: {
  title?: string;
  subtitle?: string;
  apiBase?: string;
  showAlertActions?: boolean;
  sampleMessages?: string[];
  qrHint?: string;
} = {}): string {
  const title = options.title ?? "微信连接";
  const subtitle = options.subtitle ?? "单客户 Experimental MVP 绑定页";
  const apiBase = options.apiBase ?? "/api/weixin";
  const showAlertActions = options.showAlertActions ?? true;
  const sampleMessages = options.sampleMessages ?? ["我的持仓", "自选列表", "买入 000001 10.50 100", "每日复盘"];
  const qrHint = options.qrHint ?? "请使用客户微信扫描二维码，并在微信中确认登录。";
  const alertButtons = showAlertActions
    ? `<button id="mockAlertBtn" class="secondary">模拟触发</button>
        <button id="checkAlertsBtn" class="secondary">立即巡检</button>`
    : "";
  const sampleText = sampleMessages.join("\\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>invest-agent ${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #fff;
      --text: #1f2933;
      --muted: #667085;
      --line: #d8dde6;
      --primary: #1677ff;
      --danger: #d92d20;
      --ok: #067647;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 28px 18px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 22px;
      line-height: 1.25;
      margin: 0;
    }
    .sub {
      color: var(--muted);
      margin-top: 6px;
      font-size: 14px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
      cursor: pointer;
      background: var(--primary);
      color: white;
    }
    button.secondary {
      background: #344054;
    }
    button.danger {
      background: var(--danger);
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    dl {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 10px 14px;
      margin: 0;
      font-size: 14px;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
      word-break: break-all;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #eef4ff;
      color: #175cd3;
      font-size: 13px;
    }
    .badge.ok {
      background: #ecfdf3;
      color: var(--ok);
    }
    .badge.err {
      background: #fef3f2;
      color: var(--danger);
    }
    #qrWrap {
      display: none;
      margin-top: 16px;
    }
    #qr {
      width: min(260px, 80vw);
      height: min(260px, 80vw);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #101828;
      color: #f2f4f7;
      border-radius: 8px;
      padding: 12px;
      max-height: 260px;
      overflow: auto;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${title}</h1>
        <div class="sub">${subtitle}</div>
      </div>
      <span id="stageBadge" class="badge">loading</span>
    </header>

    <section class="panel">
      <div class="row">
        <button id="connectBtn">连接微信</button>
        <button id="listenBtn" class="secondary">启动监听</button>
        <button id="refreshBtn" class="secondary">刷新状态</button>
        <button id="testPushBtn" class="secondary">测试提醒</button>
        ${alertButtons}
        <button id="stopBtn" class="danger">断开连接</button>
      </div>
      <div id="qrWrap">
        <p class="hint">${qrHint}</p>
        <img id="qr" alt="微信登录二维码" />
        <p id="qrLink" class="hint" style="margin-top:10px; word-break: break-all;"></p>
      </div>
    </section>

    <section class="panel">
      <dl>
        <dt>连接阶段</dt><dd id="stage">-</dd>
        <dt>账号</dt><dd id="accountId">-</dd>
        <dt>监听状态</dt><dd id="listener">-</dd>
        <dt>提醒推送</dt><dd id="pushReady">-</dd>
        <dt>最近会话</dt><dd id="lastConversation">-</dd>
        <dt>提示</dt><dd id="message">-</dd>
        <dt>更新时间</dt><dd id="updatedAt">-</dd>
        <dt>错误</dt><dd id="lastError">-</dd>
      </dl>
    </section>

    <section class="panel">
      <p class="hint">连接成功后，用另一个微信给该账号发送：</p>
      <pre>${sampleText}</pre>
    </section>

    <section class="panel">
      <p class="hint">最近操作结果</p>
      <pre id="actionLog">-</pre>
    </section>
  </main>

  <script>
    const els = {
      badge: document.getElementById("stageBadge"),
      stage: document.getElementById("stage"),
      accountId: document.getElementById("accountId"),
      listener: document.getElementById("listener"),
      pushReady: document.getElementById("pushReady"),
      lastConversation: document.getElementById("lastConversation"),
      message: document.getElementById("message"),
      updatedAt: document.getElementById("updatedAt"),
      lastError: document.getElementById("lastError"),
      qrWrap: document.getElementById("qrWrap"),
      qr: document.getElementById("qr"),
      qrLink: document.getElementById("qrLink"),
      connectBtn: document.getElementById("connectBtn"),
      refreshBtn: document.getElementById("refreshBtn"),
      listenBtn: document.getElementById("listenBtn"),
      testPushBtn: document.getElementById("testPushBtn"),
      mockAlertBtn: document.getElementById("mockAlertBtn"),
      checkAlertsBtn: document.getElementById("checkAlertsBtn"),
      stopBtn: document.getElementById("stopBtn"),
      actionLog: document.getElementById("actionLog"),
    };

    let pollTimer = null;
    let lastQr = "";

    function setBadge(stage) {
      els.badge.textContent = stage || "-";
      els.badge.className = "badge";
      if (stage === "connected") els.badge.classList.add("ok");
      if (stage === "error") els.badge.classList.add("err");
    }

    function render(state) {
      setBadge(state.stage);
      els.stage.textContent = state.stage || "-";
      els.accountId.textContent = state.accountId || "-";
      els.listener.textContent = state.listenerRunning ? "监听中" : "未监听";
      els.pushReady.textContent = state.pushReady ? "可推送" : "等待客户先发一条消息";
      els.lastConversation.textContent = state.lastConversationId
        ? state.lastConversationId + (state.lastConversationAt ? " / " + state.lastConversationAt : "")
        : "-";
      els.message.textContent = state.message || "-";
      els.updatedAt.textContent = state.updatedAt || "-";
      els.lastError.textContent = state.lastError || "-";
      if (state.qrcodeUrl) {
        if (lastQr !== state.qrcodeDataUrl) {
          els.qr.src = state.qrcodeDataUrl || "";
          els.qrLink.textContent = state.qrcodeUrl;
          lastQr = state.qrcodeDataUrl || "";
        }
        els.qrWrap.style.display = "block";
      } else {
        els.qrWrap.style.display = "none";
        lastQr = "";
      }
      els.connectBtn.disabled = state.stage === "waiting_scan" || state.stage === "scanned";
      els.listenBtn.disabled = state.stage !== "connected" || state.listenerRunning;
      els.testPushBtn.disabled = !state.pushReady;
      if (els.mockAlertBtn) els.mockAlertBtn.disabled = !state.pushReady;
      if (els.checkAlertsBtn) els.checkAlertsBtn.disabled = !state.pushReady;
    }

    async function api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function refresh() {
      const state = await api("${apiBase}/status");
      render(state);
      if (["waiting_scan", "scanned"].includes(state.stage) && !pollTimer) {
        pollTimer = setInterval(refresh, 2500);
      }
      if (!["waiting_scan", "scanned"].includes(state.stage) && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    els.connectBtn.addEventListener("click", async () => {
      render(await api("${apiBase}/connect/start", { method: "POST" }));
      await refresh();
    });
    els.refreshBtn.addEventListener("click", refresh);
    els.listenBtn.addEventListener("click", async () => {
      render(await api("${apiBase}/listener/start", { method: "POST" }));
      await refresh();
    });
    els.testPushBtn.addEventListener("click", async () => {
      const result = await api("${apiBase}/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "测试提醒：盘中提醒链路已接通。" }),
      });
      render(result.state);
      els.actionLog.textContent = JSON.stringify(result, null, 2);
      await refresh();
    });
    if (els.checkAlertsBtn) {
      els.checkAlertsBtn.addEventListener("click", async () => {
        const result = await api("/api/alerts/check-and-push", { method: "POST" });
        render(result.state);
        els.actionLog.textContent = JSON.stringify(result, null, 2);
        await refresh();
      });
    }
    if (els.mockAlertBtn) {
      els.mockAlertBtn.addEventListener("click", async () => {
        const result = await api("/api/alerts/mock-and-push", { method: "POST" });
        render(result.state);
        els.actionLog.textContent = JSON.stringify(result, null, 2);
        await refresh();
      });
    }
    els.stopBtn.addEventListener("click", async () => {
      render(await api("${apiBase}/connect/stop", { method: "POST" }));
      await refresh();
    });

    refresh().catch((err) => {
      els.message.textContent = err.message;
      setBadge("error");
    });
  </script>
</body>
</html>`;
}
