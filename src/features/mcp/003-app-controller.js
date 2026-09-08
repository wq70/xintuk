(function () {
  "use strict";

  const TYPES = {
    remote: ["远程服务", "连接 Streamable HTTP / SSE MCP 服务"],
    computer_bridge: ["电脑桥接", "通过电脑桥接器使用本地 stdio 服务"],
    termux: ["Termux", "连接 Android Termux 中运行的桥接服务"],
    ios_ish: ["iOS / iSH", "连接 iSH 或其他 iOS 本地桥接服务"],
    ios_shortcuts: ["苹果快捷指令", "从应用跳转执行一次性快捷指令动作"],
    bluetooth: ["蓝牙设备", "配对 Web Bluetooth 设备或连接蓝牙桥接端点"],
    custom_bridge: ["自定义桥接", "连接遵循 MCP HTTP 传输的自建桥接器"],
  };
  const STATUS = { online: "在线", offline: "离线", testing: "连接中", error: "异常", disabled: "已停用", paired: "已配对", ready: "就绪" };
  const KINDS = { tools: "工具", resources: "资源", resourceTemplates: "资源模板", prompts: "提示词" };
  let view = "connections";
  let snapshot = { ready: false, connections: [], activities: [], settings: {} };
  let editingId = null;

  const manager = () => window.McpManager;
  const appState = () => window.state;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  };
  const attr = (value) => esc(value).replace(/`/g, "&#96;");
  const checked = (value) => (value ? " checked" : "");
  const selected = (value, expected) => (value === expected ? " selected" : "");
  const parseJson = (value, fallback, label) => {
    const text = String(value || "").trim();
    if (!text) return fallback;
    try { return JSON.parse(text); } catch (_) { throw new Error(`${label || "JSON"}格式不正确。`); }
  };
  const formatTime = (value) => value ? new Date(value).toLocaleString() : "—";

  function notify(title, message, details) {
    showSheet(title, `<div class="mcp-setting-card"><div class="mcp-setting-copy"><strong>${esc(message)}</strong>${details ? `<pre class="mcp-json">${esc(typeof details === "string" ? details : JSON.stringify(details, null, 2))}</pre>` : ""}</div></div>`, [
      { label: "知道了", primary: true, close: true },
    ]);
  }

  function showSheet(title, html, actions) {
    $("mcp-sheet-title").textContent = title;
    $("mcp-sheet-body").innerHTML = html;
    const actionHost = $("mcp-sheet-actions");
    actionHost.innerHTML = "";
    (actions || []).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger ? "mcp-danger-button" : action.primary ? "mcp-primary-button" : "mcp-secondary-button";
      button.textContent = action.label;
      button.addEventListener("click", async () => {
        try {
          button.disabled = true;
          if (action.run) await action.run();
          if (action.close !== false) closeSheet();
        } catch (error) {
          button.disabled = false;
          notify("操作没有完成", error?.message || String(error));
        }
      });
      actionHost.appendChild(button);
    });
    const backdrop = $("mcp-sheet-backdrop");
    backdrop.classList.add("visible");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeSheet() {
    const backdrop = $("mcp-sheet-backdrop");
    backdrop.classList.remove("visible");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function renderOverview() {
    const online = snapshot.connections.filter((item) => ["online", "paired"].includes(item.status)).length;
    const toolCount = snapshot.connections.reduce((sum, item) => sum + (item.capabilities?.tools?.length || 0), 0);
    $("mcp-online-count").textContent = online;
    $("mcp-tool-count").textContent = toolCount;
    $("mcp-overview-title").textContent = online ? `${online} 个服务可用` : snapshot.connections.length ? "服务当前未连接" : "尚未连接服务";
    $("mcp-overview-detail").textContent = snapshot.connections.length ? `${snapshot.connections.length} 个服务，共发现 ${toolCount} 个工具` : "添加一个 MCP 服务后即可发现工具";
  }

  function renderConnections() {
    if (!snapshot.connections.length) return `<div class="mcp-empty"><strong>连接你的第一个 MCP 服务</strong>支持远程、电脑桥接、Termux、iOS / iSH、快捷指令、蓝牙和自定义桥接。</div>`;
    return snapshot.connections.map((connection) => {
      const caps = connection.capabilityCount || Object.values(connection.capabilities || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
      const endpoint = connection.type === "ios_shortcuts" ? connection.shortcutName || "未填写快捷指令" : connection.endpoint || (connection.bluetoothMode === "direct" ? "Web Bluetooth 直连" : "未填写端点");
      return `<article class="mcp-card">
        <div class="mcp-card-head"><i class="mcp-status-dot ${attr(connection.status)}"></i><div class="mcp-card-main"><strong>${esc(connection.name || TYPES[connection.type]?.[0] || "MCP 服务")}</strong><span>${esc(STATUS[connection.status] || connection.status || "离线")} · ${esc(TYPES[connection.type]?.[0] || connection.type)} · ${caps} 项能力</span><span>${esc(endpoint)}</span></div></div>
        ${connection.lastError ? `<div class="mcp-field-note">${esc(connection.lastError)}</div>` : ""}
        <div class="mcp-card-actions">
          ${connection.type === "ios_shortcuts" ? `<button type="button" class="mcp-small-button" data-mcp-action="run-shortcut" data-id="${attr(connection.id)}">运行</button>` : `<button type="button" class="mcp-small-button" data-mcp-action="connect" data-id="${attr(connection.id)}">${connection.status === "online" ? "刷新" : "连接测试"}</button>`}
          <button type="button" class="mcp-small-button" data-mcp-action="edit" data-id="${attr(connection.id)}">编辑</button>
          <button type="button" class="mcp-small-button" data-mcp-action="toggle" data-id="${attr(connection.id)}">${connection.enabled ? "停用" : "启用"}</button>
          <button type="button" class="mcp-small-button" data-mcp-action="remove" data-id="${attr(connection.id)}">删除</button>
        </div>
      </article>`;
    }).join("");
  }

  function capabilityRows() {
    const rows = [];
    snapshot.connections.forEach((connection) => {
      Object.entries(KINDS).forEach(([kind, label]) => {
        (connection.capabilities?.[kind] || []).forEach((item) => rows.push({ connection, kind, label, item }));
      });
    });
    return rows;
  }

  function renderCapabilities() {
    const rows = capabilityRows();
    if (!rows.length) return `<div class="mcp-empty"><strong>还没有发现能力</strong>先连接或刷新一个 MCP 服务。</div>`;
    return `<div class="mcp-search-row"><input id="mcp-capability-search" class="mcp-input" type="search" placeholder="搜索工具、资源或提示词" autocomplete="off"></div><div id="mcp-capability-results">${renderCapabilityItems(rows)}</div>`;
  }

  function renderCapabilityItems(rows) {
    return rows.map(({ connection, kind, label, item }) => {
      const name = item.name || item.uri || item.uriTemplate || "未命名";
      return `<article class="mcp-card" data-capability-text="${attr(`${connection.name} ${name} ${item.description || ""}`.toLocaleLowerCase())}">
        <div class="mcp-card-head"><div class="mcp-card-main"><strong>${esc(name)}</strong><span>${esc(label)} · ${esc(connection.name)}</span></div></div>
        ${item.description ? `<div class="mcp-field-note">${esc(item.description)}</div>` : ""}
        <div class="mcp-card-actions"><button type="button" class="mcp-small-button" data-mcp-action="invoke" data-id="${attr(connection.id)}" data-kind="${attr(kind)}" data-name="${attr(name)}">打开</button>${kind === "resources" && item.subscribe ? `<button type="button" class="mcp-small-button" data-mcp-action="subscribe" data-id="${attr(connection.id)}" data-name="${attr(name)}">订阅切换</button>` : ""}</div>
      </article>`;
    }).join("");
  }

  function renderActivities() {
    if (!snapshot.activities.length) return `<div class="mcp-empty"><strong>还没有调用记录</strong>工具调用、服务通知和错误会显示在这里。</div>`;
    return snapshot.activities.map((item) => `<article class="mcp-card">
      <div class="mcp-card-head"><i class="mcp-status-dot ${attr(item.status === "success" ? "online" : item.status)}"></i><div class="mcp-card-main"><strong>${esc(item.title || item.method || "MCP 活动")}</strong><span>${esc(item.connectionName || "MCP")} · ${esc(formatTime(item.createdAt))}</span></div></div>
      <div class="mcp-field-note">${esc(item.summary || STATUS[item.status] || item.status)}</div>
      <div class="mcp-card-actions"><button type="button" class="mcp-small-button" data-mcp-action="activity-detail" data-id="${attr(item.id)}">详情</button></div>
    </article>`).join("");
  }

  function toggleRow(id, title, note, value) {
    return `<div class="mcp-setting-row"><div class="mcp-setting-copy"><strong>${esc(title)}</strong><span>${esc(note)}</span></div><label class="mcp-toggle"><input id="${attr(id)}" type="checkbox"${checked(value)}><span></span></label></div>`;
  }

  function renderSettings() {
    const s = snapshot.settings || {};
    return `<section class="mcp-setting-card">
      ${toggleRow("mcp-auto-reconnect", "自动重连", "应用打开后恢复已启用的网络连接", s.autoReconnect)}
      ${toggleRow("mcp-show-chat-cards", "聊天活动卡片", "在聊天中显示工具调用状态与摘要", s.showChatCards)}
      ${toggleRow("mcp-result-details", "保留详细结果", "记录中保留工具返回详情；可能占用更多空间", s.includeResultDetails)}
    </section>
    <section class="mcp-setting-card">
      <div class="mcp-field"><label for="mcp-timeout">请求超时（毫秒）</label><input id="mcp-timeout" class="mcp-input" type="number" min="3000" max="120000" value="${attr(s.timeoutMs || 20000)}"></div>
      <div class="mcp-field"><label for="mcp-max-calls">单轮最多工具调用</label><input id="mcp-max-calls" class="mcp-input" type="number" min="1" max="32" value="${attr(s.maxCallsPerTurn || 8)}"></div>
      <div class="mcp-field"><label for="mcp-max-tools">送入模型的最多工具数</label><input id="mcp-max-tools" class="mcp-input" type="number" min="1" max="128" value="${attr(s.maxCatalogTools || 40)}"></div>
      <div class="mcp-field"><label for="mcp-result-limit">单个结果最大字符数</label><input id="mcp-result-limit" class="mcp-input" type="number" min="2000" max="200000" value="${attr(s.maxResultLength || 30000)}"></div>
      <div class="mcp-field"><label for="mcp-retention">记录保留天数</label><input id="mcp-retention" class="mcp-input" type="number" min="1" max="365" value="${attr(s.activityRetentionDays || 30)}"></div>
      <div class="mcp-field"><label for="mcp-roots">可向服务公开的根目录（JSON 数组）</label><textarea id="mcp-roots" class="mcp-textarea" spellcheck="false">${esc(JSON.stringify(s.roots || [], null, 2))}</textarea><div class="mcp-field-note">仅在服务请求 roots/list 时返回；不会自动扫描文件。</div></div>
      <button type="button" class="mcp-primary-button" data-mcp-action="save-settings">保存设置</button>
    </section>
    <section class="mcp-setting-card"><div class="mcp-setting-copy"><strong>导入与导出</strong><span>兼容常见 mcpServers 配置。导出不会包含令牌、密钥或会话。</span></div><div class="mcp-card-actions"><button type="button" class="mcp-small-button" data-mcp-action="import">导入配置</button><button type="button" class="mcp-small-button" data-mcp-action="export">导出配置</button></div></section>`;
  }

  function render() {
    if (!$('mcp-main-content')) return;
    renderOverview();
    document.querySelectorAll("[data-mcp-view]").forEach((button) => button.classList.toggle("active", button.dataset.mcpView === view));
    const host = $("mcp-main-content");
    host.innerHTML = view === "connections" ? renderConnections() : view === "capabilities" ? renderCapabilities() : view === "activities" ? renderActivities() : renderSettings();
  }

  function connectionForm(connection) {
    const c = connection || { enabled: true, type: "remote", authType: "none", transport: "auto", availability: "all", bluetoothMode: "bridge" };
    return `<div class="mcp-field"><label for="mcp-form-type">连接类型</label><select id="mcp-form-type" class="mcp-select">${Object.entries(TYPES).map(([key, data]) => `<option value="${key}"${selected(c.type, key)}>${esc(data[0])}</option>`).join("")}</select><div id="mcp-type-note" class="mcp-field-note"></div></div>
      <div class="mcp-field"><label for="mcp-form-name">显示名称</label><input id="mcp-form-name" class="mcp-input" maxlength="80" value="${attr(c.name || "")}" placeholder="例如：我的文件工具"></div>
      <div id="mcp-http-fields">
        <div class="mcp-field"><label for="mcp-form-endpoint">MCP / 桥接端点</label><input id="mcp-form-endpoint" class="mcp-input" inputmode="url" value="${attr(c.endpoint || "")}" placeholder="https://example.com/mcp"><div class="mcp-field-note">电脑、Termux、iSH 与蓝牙桥接需要先由对应桥接器暴露 HTTP MCP 端点。</div></div>
        <div class="mcp-field"><label for="mcp-form-transport">传输方式</label><select id="mcp-form-transport" class="mcp-select"><option value="auto"${selected(c.transport, "auto")}>自动识别</option><option value="streamable_http"${selected(c.transport, "streamable_http")}>Streamable HTTP</option><option value="sse"${selected(c.transport, "sse")}>SSE</option></select></div>
        <div class="mcp-field"><label for="mcp-form-auth">鉴权方式</label><select id="mcp-form-auth" class="mcp-select"><option value="none"${selected(c.authType, "none")}>无</option><option value="bearer"${selected(c.authType, "bearer")}>Bearer Token</option><option value="api_key"${selected(c.authType, "api_key")}>API Key 请求头</option><option value="oauth"${selected(c.authType, "oauth")}>OAuth Access Token</option></select></div>
        <div class="mcp-field"><label for="mcp-form-header">API Key 请求头名称</label><input id="mcp-form-header" class="mcp-input" value="${attr(c.apiKeyHeader || "X-API-Key")}"></div>
        <div class="mcp-field"><label for="mcp-form-secret">密钥 / Token</label><input id="mcp-form-secret" class="mcp-input" type="password" autocomplete="new-password" placeholder="${connection ? "留空则保留原凭据" : "仅保存在独立凭据表"}"></div>
        <div class="mcp-field"><label for="mcp-form-headers">附加请求头（JSON 对象）</label><textarea id="mcp-form-headers" class="mcp-textarea" spellcheck="false">${esc(JSON.stringify(c.headers || {}, null, 2))}</textarea></div>
      </div>
      <div id="mcp-shortcut-fields" hidden><div class="mcp-field"><label for="mcp-form-shortcut">快捷指令名称</label><input id="mcp-form-shortcut" class="mcp-input" value="${attr(c.shortcutName || "")}" placeholder="快捷指令名称"></div></div>
      <div id="mcp-bluetooth-fields" hidden><div class="mcp-field"><label for="mcp-form-bluetooth-mode">蓝牙方式</label><select id="mcp-form-bluetooth-mode" class="mcp-select"><option value="bridge"${selected(c.bluetoothMode, "bridge")}>桥接端点</option><option value="direct"${selected(c.bluetoothMode, "direct")}>Web Bluetooth 配对</option></select></div><div class="mcp-field"><label for="mcp-form-service-uuid">Service UUID（直连）</label><input id="mcp-form-service-uuid" class="mcp-input" value="${attr(c.serviceUuid || "")}" placeholder="设备提供的 Service UUID"></div></div>
      <div class="mcp-field"><label for="mcp-form-availability">可用范围</label><select id="mcp-form-availability" class="mcp-select"><option value="all"${selected(c.availability, "all")}>所有聊天可授权</option><option value="current_chat"${selected(c.availability, "current_chat")}>仅当前聊天可授权</option><option value="manual"${selected(c.availability, "manual")}>仅在 MCP 页手动使用</option></select></div>
      <div class="mcp-field"><label for="mcp-form-launch">桥接启动信息（JSON，可选）</label><textarea id="mcp-form-launch" class="mcp-textarea" spellcheck="false" placeholder='{"command":"npx","args":["-y","server"]}'>${esc(c.launchConfig ? JSON.stringify(c.launchConfig, null, 2) : "")}</textarea><div class="mcp-field-note">用于保存或导出 stdio 启动参数；浏览器不会擅自在设备上执行命令。</div></div>`;
  }

  function updateConnectionFields() {
    const type = $("mcp-form-type")?.value;
    if (!type) return;
    $("mcp-type-note").textContent = TYPES[type]?.[1] || "";
    $("mcp-shortcut-fields").hidden = type !== "ios_shortcuts";
    $("mcp-bluetooth-fields").hidden = type !== "bluetooth";
    const directBluetooth = type === "bluetooth" && $("mcp-form-bluetooth-mode")?.value === "direct";
    $("mcp-http-fields").hidden = type === "ios_shortcuts" || directBluetooth;
  }

  function openConnectionForm(id) {
    editingId = id || null;
    const connection = id ? snapshot.connections.find((item) => item.id === id) : null;
    showSheet(connection ? "编辑 MCP 服务" : "添加 MCP 服务", connectionForm(connection), [
      { label: "取消", close: true },
      { label: "保存", primary: true, run: saveConnectionForm },
    ]);
    $("mcp-form-type").addEventListener("change", updateConnectionFields);
    $("mcp-form-bluetooth-mode").addEventListener("change", updateConnectionFields);
    updateConnectionFields();
  }

  async function saveConnectionForm() {
    const type = $("mcp-form-type").value;
    const bluetoothMode = $("mcp-form-bluetooth-mode").value;
    const endpointNeeded = type !== "ios_shortcuts" && !(type === "bluetooth" && bluetoothMode === "direct");
    const name = $("mcp-form-name").value.trim();
    const endpoint = $("mcp-form-endpoint").value.trim();
    if (!name) throw new Error("请填写服务名称。");
    if (endpointNeeded && !endpoint) throw new Error("请填写 MCP 或桥接端点。");
    if (endpoint && !/^https?:\/\//i.test(endpoint)) throw new Error("端点必须使用 http:// 或 https://。");
    if (type === "ios_shortcuts" && !$("mcp-form-shortcut").value.trim()) throw new Error("请填写快捷指令名称。");
    const previous = editingId ? snapshot.connections.find((item) => item.id === editingId) : null;
    const record = {
      ...(previous || {}), id: editingId || undefined, name, type,
      endpoint, transport: $("mcp-form-transport").value, authType: $("mcp-form-auth").value,
      apiKeyHeader: $("mcp-form-header").value.trim() || "X-API-Key",
      headers: parseJson($("mcp-form-headers").value, {}, "附加请求头"),
      shortcutName: $("mcp-form-shortcut").value.trim(), bluetoothMode,
      serviceUuid: $("mcp-form-service-uuid").value.trim(), availability: $("mcp-form-availability").value,
      chatId: $("mcp-form-availability").value === "current_chat" ? appState()?.activeChatId || previous?.chatId : null,
      launchConfig: parseJson($("mcp-form-launch").value, null, "桥接启动信息"), enabled: previous?.enabled !== false,
      keepExistingSecret: Boolean(previous),
    };
    await manager().saveConnection(record, $("mcp-form-secret").value || undefined);
  }

  function openCapability(connectionId, kind, name) {
    const connection = snapshot.connections.find((item) => item.id === connectionId);
    const item = connection?.capabilities?.[kind]?.find((cap) => (cap.name || cap.uri || cap.uriTemplate) === name);
    if (!item) return notify("能力不可用", "该能力可能已被服务更新，请重新连接后再试。");
    const requiresArgs = kind === "tools" || kind === "prompts" || kind === "resourceTemplates";
    const html = `<div class="mcp-setting-card"><div class="mcp-setting-copy"><strong>${esc(name)}</strong><span>${esc(item.description || `${KINDS[kind]} · ${connection.name}`)}</span></div></div>${requiresArgs ? `<div class="mcp-field"><label for="mcp-invoke-args">参数（JSON 对象）</label><textarea id="mcp-invoke-args" class="mcp-textarea" spellcheck="false">{}</textarea></div>` : ""}`;
    showSheet(`使用${KINDS[kind]}`, html, [{ label: "取消", close: true }, { label: "执行", primary: true, close: false, run: async () => {
      const args = requiresArgs ? parseJson($("mcp-invoke-args").value, {}, "参数") : {};
      let target = name;
      if (kind === "resourceTemplates") target = name.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(args[key] ?? `{${key}}`));
      const result = await manager().consumeCapability(connectionId, kind, target, args);
      notify("执行结果", "MCP 能力调用完成。", result);
    }}]);
  }

  async function handleAction(button) {
    const action = button.dataset.mcpAction;
    const id = button.dataset.id;
    if (action === "connect") { button.disabled = true; try { await manager().connect(id, { force: true }); } catch (error) { notify("连接失败", error?.message || String(error)); } return; }
    if (action === "edit") return openConnectionForm(id);
    if (action === "toggle") {
      const connection = snapshot.connections.find((item) => item.id === id);
      if (!connection) return;
      await manager().saveConnection({ ...connection, enabled: !connection.enabled, status: connection.enabled ? "disabled" : "offline", keepExistingSecret: true });
      if (connection.enabled) await manager().disconnect(id);
      return;
    }
    if (action === "remove") {
      const connection = snapshot.connections.find((item) => item.id === id);
      const ok = await manager().confirmAction({ title: "删除 MCP 服务", message: `删除“${connection?.name || "该服务"}”及其本地凭据和能力缓存？聊天记录不会被删除。`, acceptText: "删除" });
      if (ok) await manager().removeConnection(id);
      return;
    }
    if (action === "run-shortcut") {
      const connection = snapshot.connections.find((item) => item.id === id);
      const ok = await manager().confirmAction({ title: "运行快捷指令", message: `即将离开当前页面并运行“${connection?.shortcutName}”。`, acceptText: "继续" });
      if (ok) location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(connection.shortcutName)}`;
      return;
    }
    if (action === "invoke") return openCapability(id, button.dataset.kind, button.dataset.name);
    if (action === "subscribe") { try { const active = await manager().toggleSubscription(id, button.dataset.name); notify("资源订阅", active ? "已订阅资源更新。" : "已取消资源订阅。"); } catch (error) { notify("订阅失败", error?.message || String(error)); } return; }
    if (action === "activity-detail") {
      const activity = snapshot.activities.find((item) => item.id === id);
      if (activity) notify(activity.title || "MCP 活动", activity.summary || STATUS[activity.status] || activity.status, activity);
      return;
    }
    if (action === "save-settings") return saveSettings();
    if (action === "import") return $("mcp-import-input").click();
    if (action === "export") return exportConnections();
  }

  async function saveSettings() {
    const roots = parseJson($("mcp-roots").value, [], "根目录");
    if (!Array.isArray(roots)) throw new Error("根目录必须是 JSON 数组。");
    await manager().saveSettings({
      autoReconnect: $("mcp-auto-reconnect").checked, showChatCards: $("mcp-show-chat-cards").checked,
      includeResultDetails: $("mcp-result-details").checked,
      timeoutMs: Math.min(120000, Math.max(3000, Number($("mcp-timeout").value) || 20000)),
      maxCallsPerTurn: Math.min(32, Math.max(1, Number($("mcp-max-calls").value) || 8)),
      maxCatalogTools: Math.min(128, Math.max(1, Number($("mcp-max-tools").value) || 40)),
      maxResultLength: Math.min(200000, Math.max(2000, Number($("mcp-result-limit").value) || 30000)),
      activityRetentionDays: Math.min(365, Math.max(1, Number($("mcp-retention").value) || 30)), roots,
    });
    notify("设置已保存", "新的 MCP 全局设置已生效。");
  }

  function exportConnections() {
    const payload = { format: "tuk-mcp-connections", version: 1, exportedAt: new Date().toISOString(), settings: snapshot.settings, connections: snapshot.connections.map(({ capabilities, status, lastError, ...item }) => item) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `mcp-connections-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importConnections(file) {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data.connections) ? data.connections : Object.entries(data.mcpServers || {}).map(([name, config]) => ({ name, type: config.url ? "remote" : "computer_bridge", endpoint: config.url || config.endpoint || "", launchConfig: config.command ? { command: config.command, args: config.args || [], env: config.env || {} } : undefined, headers: config.headers || {}, enabled: true, availability: "all", transport: "auto", authType: "none" }));
    if (!items.length) throw new Error("文件中没有可导入的 MCP 服务。");
    let imported = 0;
    for (const item of items) {
      if (!item.name || (!item.endpoint && item.type !== "ios_shortcuts" && !item.launchConfig)) continue;
      await manager().saveConnection({ ...item, id: undefined, status: "offline", enabled: item.enabled !== false });
      imported += 1;
    }
    notify("导入完成", `已导入 ${imported} 个服务。凭据不会从配置文件自动导入，请逐个编辑填写。`);
  }

  function permissionBlock(settings, key, title, inherited) {
    const online = snapshot.connections.filter((item) => item.enabled && item.availability !== "manual");
    return `<div class="mcp-chat-member" data-mcp-permission-block="${attr(key)}"><div class="mcp-setting-copy"><strong>${esc(title)}</strong>${inherited ? `<span>群成员可拥有独立权限；未修改项沿用群聊设置。</span>` : ""}</div>
      ${toggleRow(`mcp-enabled-${key}`, "允许使用 MCP", "仅向模型提供下方明确授权的工具", settings.enabled)}
      <div class="mcp-field"><label>触发方式</label><select class="mcp-select" data-mcp-setting="mode"><option value="auto"${selected(settings.mode, "auto")}>自动判断</option><option value="explicit"${selected(settings.mode, "explicit")}>仅明显工具需求</option><option value="rules"${selected(settings.mode, "rules")}>仅命中自定义规则</option><option value="manual_only"${selected(settings.mode, "manual_only")}>仅手动调用</option><option value="read_only_auto"${selected(settings.mode, "read_only_auto")}>仅只读工具自动</option><option value="required"${selected(settings.mode, "required")}>有工具时优先要求调用</option><option value="disabled"${selected(settings.mode, "disabled")}>禁用</option></select></div>
      <div class="mcp-field"><label>触发规则（每行或逗号分隔）</label><textarea class="mcp-textarea" data-mcp-setting="triggerRules">${esc(settings.triggerRules || "")}</textarea></div>
      ${toggleRow(`mcp-confirm-${key}`, "写入前确认", "创建、修改、发送、删除等操作先询问", settings.confirmWrites !== false)}
      ${toggleRow(`mcp-cards-${key}`, "显示活动卡片", "在聊天内显示调用中、成功或失败状态", settings.showActivityCards !== false)}
      <div class="mcp-chat-connection-list">${online.length ? online.map((connection) => {
        const allowed = settings.allowedConnections?.includes(connection.id);
        const tools = connection.capabilities?.tools || [];
        const selectedTools = settings.allowedTools?.[connection.id];
        return `<div class="mcp-chat-connection"><label><input type="checkbox" data-mcp-connection="${attr(connection.id)}"${checked(allowed)}><span>${esc(connection.name)} · ${tools.length} 个工具</span></label>${tools.length ? `<div class="mcp-chat-tools">${tools.map((tool) => `<label><input type="checkbox" data-mcp-tool-connection="${attr(connection.id)}" value="${attr(tool.name)}"${checked(!Array.isArray(selectedTools) || selectedTools.includes(tool.name))}><span>${esc(tool.title || tool.name)}</span></label>`).join("")}</div>` : ""}</div>`;
      }).join("") : `<div class="mcp-field-note">没有可授权的服务。请先在主屏幕 MCP 页面添加并连接。</div>`}</div></div>`;
  }

  function renderChatSettings(chat) {
    const panel = $("mcp-chat-settings-panel");
    if (!panel || !chat) return;
    const base = manager().getChatSettings(chat);
    let html = permissionBlock(base, "base", chat.isGroup ? "群聊默认权限" : "当前聊天", false);
    if (chat.isGroup && Array.isArray(chat.members)) {
      html += chat.members.map((member, index) => {
        const actorId = member.id || member.originalName || `member-${index}`;
        return `<details class="mcp-chat-member"><summary>${esc(member.groupNickname || member.originalName || member.name || `成员 ${index + 1}`)}的独立权限</summary>${permissionBlock(manager().getChatSettings(chat, actorId), encodeURIComponent(actorId), "角色权限", true)}</details>`;
      }).join("");
    }
    panel.innerHTML = html;
  }

  function readPermissionBlock(block) {
    const allowedConnections = Array.from(block.querySelectorAll("[data-mcp-connection]:checked")).map((node) => node.dataset.mcpConnection);
    const allowedTools = {};
    allowedConnections.forEach((connectionId) => { allowedTools[connectionId] = Array.from(block.querySelectorAll(`[data-mcp-tool-connection="${CSS.escape(connectionId)}"]:checked`)).map((node) => node.value); });
    const key = block.dataset.mcpPermissionBlock;
    return {
      enabled: block.querySelector(`#mcp-enabled-${CSS.escape(key)}`)?.checked || false,
      mode: block.querySelector('[data-mcp-setting="mode"]')?.value || "auto",
      triggerRules: block.querySelector('[data-mcp-setting="triggerRules"]')?.value.trim() || "",
      confirmWrites: block.querySelector(`#mcp-confirm-${CSS.escape(key)}`)?.checked !== false,
      showActivityCards: block.querySelector(`#mcp-cards-${CSS.escape(key)}`)?.checked !== false,
      allowedConnections, allowedTools,
    };
  }

  function saveChatSettingsFromPanel(chat) {
    const panel = $("mcp-chat-settings-panel");
    const baseBlock = panel?.querySelector('[data-mcp-permission-block="base"]');
    if (!chat || !baseBlock) return;
    const previous = chat.settings?.mcp || {};
    const base = { ...previous, ...readPermissionBlock(baseBlock) };
    if (chat.isGroup) {
      base.memberSettings = { ...(previous.memberSettings || {}) };
      panel.querySelectorAll("[data-mcp-permission-block]:not([data-mcp-permission-block=base])").forEach((block) => {
        const actorId = decodeURIComponent(block.dataset.mcpPermissionBlock);
        base.memberSettings[actorId] = { ...(base.memberSettings[actorId] || {}), ...readPermissionBlock(block) };
      });
    }
    chat.settings = chat.settings || {};
    chat.settings.mcp = base;
  }

  async function handleElicitation(event) {
    const { connection, client, message } = event.detail || {};
    if (!client || !message) return;
    const schema = message.params?.requestedSchema || {};
    const properties = schema.properties || {};
    const fields = Object.entries(properties).map(([key, spec]) => {
      const required = (schema.required || []).includes(key);
      if (Array.isArray(spec.enum)) return `<div class="mcp-field"><label>${esc(spec.title || key)}${required ? " *" : ""}</label><select class="mcp-select" data-elicitation-key="${attr(key)}" data-type="string">${spec.enum.map((v) => `<option value="${attr(v)}">${esc(v)}</option>`).join("")}</select></div>`;
      if (spec.type === "boolean") return `<div class="mcp-setting-row"><div class="mcp-setting-copy"><strong>${esc(spec.title || key)}</strong><span>${esc(spec.description || "")}</span></div><label class="mcp-toggle"><input type="checkbox" data-elicitation-key="${attr(key)}" data-type="boolean"><span></span></label></div>`;
      return `<div class="mcp-field"><label>${esc(spec.title || key)}${required ? " *" : ""}</label><input class="mcp-input" data-elicitation-key="${attr(key)}" data-type="${attr(spec.type || "string")}" ${spec.type === "number" || spec.type === "integer" ? "type=number" : "type=text"} placeholder="${attr(spec.description || "")}"></div>`;
    }).join("");
    showSheet(`来自 ${connection?.name || "MCP"} 的请求`, `<div class="mcp-field-note">${esc(message.params?.message || "服务需要你补充信息。请仅填写愿意提供的内容。")}</div>${fields}`, [
      { label: "拒绝", run: () => client.sendResponse(message.id, { action: "decline" }) },
      { label: "提交", primary: true, run: async () => {
        const content = {};
        $("mcp-sheet-body").querySelectorAll("[data-elicitation-key]").forEach((input) => {
          const type = input.dataset.type;
          content[input.dataset.elicitationKey] = type === "boolean" ? input.checked : type === "number" || type === "integer" ? Number(input.value) : input.value;
        });
        await client.sendResponse(message.id, { action: "accept", content });
      } },
    ]);
  }

  function bind() {
    $("mcp-add-connection-btn")?.addEventListener("click", () => openConnectionForm());
    $("mcp-sheet-close")?.addEventListener("click", closeSheet);
    $("mcp-sheet-backdrop")?.addEventListener("click", (event) => { if (event.target.id === "mcp-sheet-backdrop") closeSheet(); });
    document.querySelectorAll("[data-mcp-view]").forEach((button) => button.addEventListener("click", () => { view = button.dataset.mcpView; render(); }));
    $("mcp-main-content")?.addEventListener("click", (event) => { const button = event.target.closest("[data-mcp-action]"); if (button) handleAction(button).catch((error) => notify("操作没有完成", error?.message || String(error))); });
    $("mcp-main-content")?.addEventListener("input", (event) => {
      if (event.target.id !== "mcp-capability-search") return;
      const query = event.target.value.trim().toLocaleLowerCase();
      document.querySelectorAll("[data-capability-text]").forEach((card) => { card.hidden = Boolean(query && !card.dataset.capabilityText.includes(query)); });
    });
    $("mcp-import-input")?.addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { await importConnections(file); } catch (error) { notify("导入失败", error?.message || String(error)); } });
    document.addEventListener("tuk-mcp-elicitation", handleElicitation);
  }

  function open() { render(); }

  function init() {
    bind();
    manager()?.subscribe((next) => { snapshot = next; render(); });
  }

  window.McpApp = { open, render, renderChatSettings, saveChatSettingsFromPanel };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
