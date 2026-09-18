(function () {
  "use strict";

  const FORMAT = "tuk-phone-prompt-center";
  const SCHEMA_VERSION = 1;
  const SETTINGS_ID = "main";
  const nativeFetch = window.fetch.bind(window);
  const FEATURES = [
    ["chat-single", "单聊回复", "核心单人聊天和后台回复"],
    ["chat-group", "群聊回复", "群聊角色发言和群聊行动"],
    ["chat-offline", "线下模式", "线下对话、动作和场景描述"],
    ["social-weibo", "微博", "微博生成、评论、私信和粉丝互动"],
    ["social-forum", "论坛", "帖子、章节、评论和小组互动"],
    ["social-qzone", "空间动态", "空间、动态、评论和朋友圈互动"],
    ["lovers", "情侣空间", "说说、情书、问答、相册和番茄钟"],
    ["dating", "约会功能", "约会场景、剧情推进和约会总结"],
    ["game-ludo", "飞行棋", "飞行棋题目、行动和对局回复"],
    ["game-undercover", "谁是卧底", "词语生成、描述、投票和行动"],
    ["game-script", "剧本杀", "剧本生成、角色行动和结局"],
    ["studio", "创作工作室", "小剧场、旁白、同人文及创作辅助"],
    ["commerce-product", "商品与淘宝", "商品、店铺、搜索和购物互动"],
    ["commerce-food", "外卖与美食", "外卖、菜单、美食和店铺生成"],
    ["checkin", "签到与查岗", "签到、查岗、监控和日常活动"],
    ["accounting", "记账", "账目分析和记账群聊"],
    ["utility", "摘要与工具", "摘要、分类、搜索和短文本转换"],
    ["memory", "记忆处理", "记忆提取、总结和召回辅助"],
    ["other", "其他 AI 功能", "未归入上述分类的模型请求"],
  ].map(([id, name, description]) => ({ id, name, description }));
  const FEATURE_MAP = Object.fromEntries(FEATURES.map((feature) => [feature.id, feature]));
  const DEFAULT_SETTINGS = {
    id: SETTINGS_ID,
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    diagnosticsEnabled: true,
    criticalEditingEnabled: false,
    featureToggles: Object.fromEntries(FEATURES.map((feature) => [feature.id, true])),
    activePresetId: "current",
    updatedAt: 0,
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  let settings = clone(DEFAULT_SETTINGS);
  let items = [];
  let presets = [];
  let bindings = [];
  let activeView = "items";
  let filterText = "";
  let filterFeature = "all";
  let readyPromise = null;
  let toastTimer = null;
  let lastDiagnostic = null;
  let fetchHookInstalled = false;
  let pickerSelectHandler = null;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  };
  const attr = (value) => esc(value).replace(/`/g, "&#96;");
  const checked = (value) => (value ? " checked" : "");
  const selected = (value, expected) => (value === expected ? " selected" : "");

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      ...clone(DEFAULT_SETTINGS),
      ...source,
      id: SETTINGS_ID,
      schemaVersion: SCHEMA_VERSION,
      enabled: source.enabled === true,
      diagnosticsEnabled: source.diagnosticsEnabled !== false,
      criticalEditingEnabled: source.criticalEditingEnabled === true,
      featureToggles: Object.fromEntries(FEATURES.map((feature) => [feature.id, source.featureToggles?.[feature.id] !== false])),
    };
  }

  function normalizeItem(value, index = 0) {
    const source = value && typeof value === "object" ? value : {};
    const featureId = source.featureId === "all" || FEATURE_MAP[source.featureId] ? source.featureId : "other";
    const kind = source.kind === "custom" ? "custom" : "captured";
    return {
      id: String(source.id || `pc-custom-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`),
      name: String(source.name || (kind === "custom" ? "自定义提示词" : "项目默认提示词")).slice(0, 80),
      featureId,
      kind,
      role: ["system", "user", "assistant"].includes(source.role) ? source.role : "system",
      slot: Math.max(0, Number.parseInt(source.slot, 10) || 0),
      placement: ["before", "replace", "after"].includes(source.placement) ? source.placement : kind === "custom" ? "after" : "replace",
      enabled: source.enabled !== false,
      useCustom: source.useCustom === true,
      risk: source.risk === "critical" ? "critical" : "normal",
      defaultContent: typeof source.defaultContent === "string" ? source.defaultContent : "",
      customContent: typeof source.customContent === "string" ? source.customContent : "",
      scopeType: source.scopeType === "chat" ? "chat" : "global",
      scopeId: typeof source.scopeId === "string" ? source.scopeId : "",
      seeded: source.seeded === true,
      createdAt: Number(source.createdAt) || Date.now(),
      updatedAt: Number(source.updatedAt) || Date.now(),
    };
  }

  function normalizePreset(value, index = 0) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: String(source.id || `pc-preset-${Date.now()}-${index}`),
      name: String(source.name || `预设 ${index + 1}`).slice(0, 80),
      description: String(source.description || "").slice(0, 240),
      createdAt: Number(source.createdAt) || Date.now(),
      updatedAt: Number(source.updatedAt) || Date.now(),
      settings: normalizeSettings(source.settings),
      items: Array.isArray(source.items) ? source.items.map(normalizeItem) : [],
    };
  }

  async function waitForDatabase() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (window.db?.isOpen?.()) return window.db;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async function seedCatalogItems(db) {
    const seededItems = [];
    (window.PromptCenterCatalog || []).forEach((seed, index) => {
      const existing = items.find((item) => item.id === seed.id);
      if (existing) {
        if (!existing.defaultContent && !existing.useCustom) {
          existing.defaultContent = seed.content;
          existing.seeded = true;
          seededItems.push(existing);
        }
        return;
      }
      const item = normalizeItem({
        ...seed,
        kind: "captured",
        placement: "replace",
        enabled: true,
        useCustom: false,
        defaultContent: seed.content,
        seeded: true,
        createdAt: Date.now() + index,
      }, index);
      items.push(item);
      seededItems.push(item);
    });
    if (seededItems.length) await db.promptItems.bulkPut(clone(seededItems));
  }

  async function load() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const db = await waitForDatabase();
      if (!db?.promptSettings || !db?.promptItems || !db?.promptPresets) {
        readyPromise = null;
        return false;
      }
      const [storedSettings, storedItems, storedPresets, storedBindings] = await Promise.all([
        db.promptSettings.get(SETTINGS_ID),
        db.promptItems.toArray(),
        db.promptPresets.toArray(),
        db.promptBindings?.toArray?.() || [],
      ]);
      settings = normalizeSettings(storedSettings);
      items = (storedItems || []).map(normalizeItem);
      presets = (storedPresets || []).map(normalizePreset);
      bindings = Array.isArray(storedBindings) ? storedBindings.filter((entry) => entry?.id && entry?.presetId) : [];
      await seedCatalogItems(db);
      return true;
    })().catch((error) => {
      console.error("[提示词中心] 读取配置失败，已保持原始请求行为。", error);
      settings = clone(DEFAULT_SETTINGS);
      return false;
    });
    return readyPromise;
  }

  async function saveSettings() {
    settings.updatedAt = Date.now();
    const db = await waitForDatabase();
    if (!db?.promptSettings) throw new Error("提示词数据库尚未就绪");
    await db.promptSettings.put(clone(settings));
  }

  async function saveItem(item) {
    item.updatedAt = Date.now();
    const normalized = normalizeItem(item);
    const index = items.findIndex((entry) => entry.id === normalized.id);
    if (index >= 0) items[index] = normalized;
    else items.push(normalized);
    const db = await waitForDatabase();
    if (!db?.promptItems) throw new Error("提示词数据库尚未就绪");
    await db.promptItems.put(clone(normalized));
    return normalized;
  }

  async function deleteItem(id) {
    items = items.filter((item) => item.id !== id);
    const db = await waitForDatabase();
    if (db?.promptItems) await db.promptItems.delete(id);
  }

  async function savePreset(preset) {
    const normalized = normalizePreset(preset);
    const index = presets.findIndex((entry) => entry.id === normalized.id);
    if (index >= 0) presets[index] = normalized;
    else presets.push(normalized);
    const db = await waitForDatabase();
    if (!db?.promptPresets) throw new Error("提示词数据库尚未就绪");
    await db.promptPresets.put(clone(normalized));
  }

  function isModelRequest(url, init) {
    if (typeof init?.body !== "string") return false;
    const target = String(url?.url || url || "");
    return /\/chat\/completions(?:\?|$)/i.test(target) || /:generateContent(?:\?|$)/i.test(target);
  }

  function isThoughtChainContent(content) {
    const text = String(content || "");
    return /\[incipere\]|<thinking>|响应起始协议|思维链首部协议|思考协议/.test(text);
  }

  function detectFeature(text) {
    const source = String(text || "");
    if (/线下模式|线下互动|offline/i.test(source)) return "chat-offline";
    if (/群聊|群主|群成员|group chat/i.test(source)) return "chat-group";
    if (/chatResponse|线上聊天软件|角色核心设定/i.test(source)) return "chat-single";
    if (/情侣空间|情书|番茄钟|纪念日|情侣问答/.test(source)) return "lovers";
    if (/微博|粉丝|私信/.test(source)) return "social-weibo";
    if (/论坛|小组帖子|章节|帖子评论/.test(source)) return "social-forum";
    if (/空间互动|朋友圈|动态评论|说说/.test(source)) return "social-qzone";
    if (/约会|dating|精灵图|约会场景/i.test(source)) return "dating";
    if (/飞行棋|棋盘|骰子/.test(source)) return "game-ludo";
    if (/谁是卧底|卧底词|投票淘汰/.test(source)) return "game-undercover";
    if (/剧本杀|凶手|线索|搜证/.test(source)) return "game-script";
    if (/工作室|小剧场|旁白|剧本|同人文/.test(source)) return "studio";
    if (/淘宝|商品|购物车|快递|产品/.test(source)) return "commerce-product";
    if (/外卖|美食|菜单|餐厅/.test(source)) return "commerce-food";
    if (/查岗|签到|监控|监视|日常活动/.test(source)) return "checkin";
    if (/记账|账目|账单|收支/.test(source)) return "accounting";
    if (/记忆|回忆|memory|embedding/i.test(source)) return "memory";
    if (/摘要|总结|分类|关键词|搜索词|精简|改写/.test(source)) return "utility";
    return "other";
  }

  function currentChatId() {
    return String(window.state?.activeChatId || "");
  }

  function appliesToScope(item) {
    return item.scopeType !== "chat" || (item.scopeId && item.scopeId === currentChatId());
  }

  function expandMacros(content, featureId) {
    const chat = window.state?.chats?.[window.state?.activeChatId] || {};
    const values = {
      "character.name": chat.name || "",
      "character.persona": chat.settings?.aiPersona || "",
      "user.name": window.state?.qzoneSettings?.nickname || "",
      "user.persona": window.state?.qzoneSettings?.persona || "",
      "chat.id": currentChatId(),
      "chat.summary": chat.settings?.summary || "",
      "feature.id": featureId,
      "model.name": window.state?.apiConfig?.model || "",
      date: new Date().toLocaleDateString(),
      time: new Date().toLocaleTimeString(),
    };
    return String(content || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
    );
  }

  function templateizeKnownValues(content) {
    const chat = window.state?.chats?.[window.state?.activeChatId] || {};
    const replacements = [
      [chat.settings?.aiPersona, "{{character.persona}}"],
      [chat.settings?.summary, "{{chat.summary}}"],
      [window.state?.qzoneSettings?.persona, "{{user.persona}}"],
      [chat.name, "{{character.name}}"],
      [window.state?.qzoneSettings?.nickname, "{{user.name}}"],
    ].filter(([value]) => typeof value === "string" && value.length >= 2).sort((a, b) => b[0].length - a[0].length);
    return replacements.reduce((text, [value, macro]) => text.split(value).join(macro), String(content || ""));
  }

  function isCritical(content) {
    return /必须.*JSON|JSON对象|JSON数组|输出格式|response_format|tool_calls|只能.*格式|绝对禁止返回/i.test(String(content || ""));
  }

  function splitPromptContent(content) {
    const text = String(content || "");
    const sections = text.split(/(?=^#{1,4}\s+)/m).filter((part) => part.trim());
    return sections.length ? sections : [text];
  }

  function sectionName(content, featureId, partIndex) {
    const heading = String(content || "").split(/\r?\n/, 1)[0]
      .replace(/^#{1,4}\s*/, "").replace(/[\*`【】]/g, "").trim();
    return (heading || `${FEATURE_MAP[featureId]?.name || "其他功能"}默认提示词 ${partIndex + 1}`).slice(0, 80);
  }

  function capturedId(featureId, role, slot, partIndex) {
    return `pc-captured:${featureId}:${role}:${slot}:${partIndex}`;
  }

  function captureDefault(featureId, role, slot, partIndex, content) {
    const id = capturedId(featureId, role, slot, partIndex);
    const scopedItems = effectiveItems(featureId);
    let item = scopedItems.find((entry) => entry.id === id);
    if (!item) {
      item = normalizeItem({
        id,
        name: sectionName(content, featureId, partIndex),
        featureId,
        kind: "captured",
        role,
        slot,
        placement: "replace",
        enabled: true,
        risk: isCritical(content) ? "critical" : "normal",
        defaultContent: templateizeKnownValues(content),
      });
      items.push(item);
      const db = window.db;
      if (db?.promptItems) db.promptItems.put(clone(item)).catch((error) => console.warn("[提示词中心] 保存默认条目失败", error));
    } else if (!item.defaultContent || item.seeded) {
      item.defaultContent = templateizeKnownValues(content);
      item.name = sectionName(content, featureId, partIndex);
      item.risk = isCritical(content) ? "critical" : item.risk;
      item.seeded = false;
      if (items.some((entry) => entry.id === item.id) && window.db?.promptItems) {
        window.db.promptItems.put(clone(item)).catch((error) => console.warn("[提示词中心] 更新默认条目失败", error));
      }
    }
    return item;
  }

  function effectiveItems(featureId) {
    const chatId = currentChatId();
    const binding = bindings.find((entry) => entry.scopeType === "chat" && entry.scopeId === chatId && entry.featureId === featureId)
      || bindings.find((entry) => entry.scopeType === "feature" && entry.featureId === featureId);
    const preset = binding && presets.find((entry) => entry.id === binding.presetId);
    return preset ? preset.items.map(normalizeItem) : items;
  }

  function prepareMessages(messages) {
    const sourceMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
    const searchable = sourceMessages.slice(0, 5).map((message) => String(message?.content || "")).join("\n").slice(0, 24000);
    const featureId = detectFeature(searchable);
    if (!settings.enabled || settings.featureToggles[featureId] === false) {
      let observable = sourceMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message?.role === "system" && !isThoughtChainContent(message.content));
      if (!observable.length && sourceMessages.length <= 3) {
        const promptIndex = sourceMessages.findIndex((message) => message?.role === "user" && String(message.content || "").length >= 40);
        if (promptIndex >= 0) observable = [{ message: sourceMessages[promptIndex], index: promptIndex }];
      }
      observable.forEach(({ message }, slot) => splitPromptContent(message.content).forEach((part, partIndex) => captureDefault(featureId, message.role, slot, partIndex, part)));
      return { messages: sourceMessages, featureId, changed: false, applied: [] };
    }

    let candidateIndexes = sourceMessages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message?.role === "system" && !isThoughtChainContent(message.content))
      .map(({ index }) => index);
    if (!candidateIndexes.length && sourceMessages.length <= 3) {
      const promptIndex = sourceMessages.findIndex((message) => message?.role === "user" && String(message.content || "").length >= 40);
      if (promptIndex >= 0) candidateIndexes = [promptIndex];
    }

    let changed = false;
    const applied = [];
    const removeIndexes = [];
    candidateIndexes.forEach((messageIndex, slot) => {
      const message = sourceMessages[messageIndex];
      const parts = splitPromptContent(message.content);
      const resolvedParts = [];
      parts.forEach((part, partIndex) => {
        const item = captureDefault(featureId, message.role, slot, partIndex, part);
        if (!appliesToScope(item)) { resolvedParts.push(part); return; }
        if (!item.enabled) {
          changed = true;
          applied.push({ id: item.id, action: "disabled" });
          return;
        }
        if (item.useCustom) {
          resolvedParts.push(expandMacros(item.customContent, featureId));
          changed = true;
          applied.push({ id: item.id, action: "custom" });
        } else {
          resolvedParts.push(part);
          applied.push({ id: item.id, action: "default" });
        }
      });
      if (resolvedParts.length) sourceMessages[messageIndex] = { ...message, content: resolvedParts.join("\n\n") };
      else removeIndexes.push(messageIndex);
    });
    removeIndexes.sort((a, b) => b - a).forEach((index) => sourceMessages.splice(index, 1));

    const customItems = effectiveItems(featureId).filter((item) => item.kind === "custom" && item.enabled && appliesToScope(item) && (item.featureId === featureId || item.featureId === "all"));
    const before = customItems.filter((item) => item.placement === "before");
    const after = customItems.filter((item) => item.placement !== "before");
    if (before.length || after.length) changed = true;
    const toMessage = (item) => ({ role: item.role, content: expandMacros(item.customContent, featureId) });
    const existing = new Set(sourceMessages.map((message) => `${message.role}\u0000${String(message.content || "")}`));
    const uniqueBefore = before.map(toMessage).filter((message) => !existing.has(`${message.role}\u0000${message.content}`));
    uniqueBefore.forEach((message) => existing.add(`${message.role}\u0000${message.content}`));
    const uniqueAfter = after.map(toMessage).filter((message) => !existing.has(`${message.role}\u0000${message.content}`));
    if (!uniqueBefore.length && !uniqueAfter.length && customItems.length && !changed) changed = false;
    const prepared = [...uniqueBefore, ...sourceMessages, ...uniqueAfter];
    customItems.forEach((item) => applied.push({ id: item.id, action: item.placement }));
    return { messages: prepared, featureId, changed, applied };
  }

  function prepareOpenAIBody(body) {
    if (!Array.isArray(body.messages)) return { body, changed: false };
    const result = prepareMessages(body.messages);
    if (!result.changed) {
      recordDiagnostic(result, body.messages.length);
      return { body, changed: false };
    }
    const next = { ...body, messages: result.messages };
    recordDiagnostic(result, result.messages.length);
    return { body: next, changed: true };
  }

  function prepareGeminiBody(body) {
    const systemParts = Array.isArray(body.systemInstruction?.parts) ? body.systemInstruction.parts : [];
    const systemMessages = systemParts.filter((part) => typeof part?.text === "string").map((part) => ({ role: "system", content: part.text }));
    const contentMessages = (Array.isArray(body.contents) ? body.contents : []).map((content) => ({
      role: content.role === "model" ? "assistant" : "user",
      content: (content.parts || []).filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n"),
      __original: content,
    }));
    const result = prepareMessages([...systemMessages, ...contentMessages]);
    if (!result.changed) {
      recordDiagnostic(result, systemMessages.length + contentMessages.length);
      return { body, changed: false };
    }
    const nextSystem = result.messages.filter((message) => message.role === "system");
    const nextContents = result.messages.filter((message) => message.role !== "system").map((message) => {
      if (message.__original && message.content === (message.__original.parts || []).filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n")) return message.__original;
      return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
    });
    const next = { ...body, contents: nextContents };
    if (nextSystem.length) next.systemInstruction = { parts: nextSystem.map((message) => ({ text: message.content })) };
    else delete next.systemInstruction;
    recordDiagnostic(result, result.messages.length);
    return { body: next, changed: true };
  }

  function recordDiagnostic(result, messageCount) {
    lastDiagnostic = {
      timestamp: Date.now(),
      featureId: result.featureId,
      featureName: FEATURE_MAP[result.featureId]?.name || "其他 AI 功能",
      messageCount,
      applied: result.applied,
      changed: result.changed,
    };
    if (!settings.diagnosticsEnabled || !window.db?.promptDiagnostics) return;
    window.db.promptDiagnostics.add(clone(lastDiagnostic)).then(async () => {
      const count = await window.db.promptDiagnostics.count();
      if (count > 100) {
        const oldest = await window.db.promptDiagnostics.orderBy("timestamp").limit(count - 100).primaryKeys();
        await window.db.promptDiagnostics.bulkDelete(oldest);
      }
    }).catch((error) => console.warn("[提示词中心] 保存诊断记录失败", error));
  }

  function installFetchHook() {
    if (fetchHookInstalled) return;
    fetchHookInstalled = true;
    window.fetch = async function promptCenterFetch(input, init) {
      if (!isModelRequest(input, init)) return nativeFetch(input, init);
      await load();
      try {
        const parsed = JSON.parse(init.body);
        const isGemini = /:generateContent(?:\?|$)/i.test(String(input?.url || input || ""));
        const prepared = isGemini ? prepareGeminiBody(parsed) : prepareOpenAIBody(parsed);
        if (!prepared.changed) return nativeFetch(input, init);
        return nativeFetch(input, { ...init, body: JSON.stringify(prepared.body) });
      } catch (error) {
        console.warn("[提示词中心] 请求处理失败，本次已保持原始请求。", error);
        return nativeFetch(input, init);
      }
    };
  }

  function toast(message) {
    const node = $("pc-toast");
    if (!node) return;
    node.textContent = message;
    node.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("visible"), 2300);
  }

  function updateHeader() {
    const enabledCount = items.filter((item) => item.enabled).length;
    $("pc-master-switch").checked = settings.enabled;
    $("pc-overview-title").textContent = settings.enabled ? "自定义提示词已开启" : "自定义提示词已关闭";
    $("pc-overview-detail").textContent = settings.enabled
      ? `${enabledCount} 个已启用条目 · ${presets.length} 个预设`
      : "所有 AI 请求保持项目原始行为";
  }

  function featureName(featureId, allLabel = "全部范围") {
    return featureId === "all" ? allLabel : FEATURE_MAP[featureId]?.name || "其他 AI 功能";
  }

  function renderItems() {
    const query = filterText.trim().toLowerCase();
    const visible = items.filter((item) => {
      if (filterFeature !== "all" && item.featureId !== filterFeature) return false;
      return !query || `${item.name}\n${item.defaultContent}\n${item.customContent}`.toLowerCase().includes(query);
    });
    const cards = visible.map((item) => {
      const content = item.useCustom || item.kind === "custom" ? item.customContent : item.defaultContent;
      const stateText = !item.enabled ? "已关闭" : item.kind === "custom" || item.useCustom ? "已自定义" : "使用默认";
      return `<article class="pc-card">
        <div class="pc-card-head"><label class="pc-toggle"><input type="checkbox" data-pc-toggle-item="${attr(item.id)}"${checked(item.enabled)}><span></span></label>
          <div class="pc-card-main"><strong>${esc(item.name)}</strong><span>${esc(item.featureId === "all" ? "全部 AI 功能" : FEATURE_MAP[item.featureId]?.name || "其他")} · ${esc(item.role)} · ${stateText}${item.scopeType === "chat" ? " · 当前聊天" : ""}</span></div>
          <span class="pc-badge${item.risk === "critical" ? " pc-risk" : ""}">${item.risk === "critical" ? "关键格式" : item.kind === "custom" ? "自定义" : "默认"}</span>
        </div>
        <div class="pc-item-preview">${esc(content || "（空条目）")}</div>
        <div class="pc-card-actions"><button class="pc-small-button" data-pc-action="edit-item" data-id="${attr(item.id)}" type="button">编辑</button>${item.kind === "captured" && item.useCustom ? `<button class="pc-small-button" data-pc-action="reset-item" data-id="${attr(item.id)}" type="button">恢复默认</button>` : ""}<button class="pc-small-button" data-pc-action="copy-item" data-id="${attr(item.id)}" type="button">复制</button>${item.kind === "custom" ? `<button class="pc-small-button" data-pc-action="delete-item" data-id="${attr(item.id)}" type="button">删除</button>` : ""}</div>
      </article>`;
    }).join("");
    return `<div class="pc-toolbar"><input id="pc-search" class="pc-input" type="search" value="${attr(filterText)}" placeholder="搜索条目"><button id="pc-feature-filter-button" class="pc-select-button" data-pc-action="pick-filter-feature" type="button"><span>${esc(featureName(filterFeature))}</span><span aria-hidden="true">⌄</span></button></div>
      ${cards || `<div class="pc-empty"><strong>还没有匹配的提示词条目</strong>项目默认提示词会在对应 AI 功能首次实际请求时按原内容登记；也可以立即新增独立提示词。登记本身不会改变请求。</div>`}
      <button class="pc-primary-button" data-pc-action="add-item" type="button">新增提示词条目</button>`;
  }

  function renderFeatures() {
    const rows = FEATURES.map((feature) => `<div class="pc-setting-row"><div class="pc-setting-copy"><strong>${esc(feature.name)}</strong><span>${esc(feature.description)}</span></div><label class="pc-toggle"><input type="checkbox" data-pc-feature="${feature.id}"${checked(settings.featureToggles[feature.id] !== false)}><span></span></label></div>`).join("");
    return `<section class="pc-setting-card"><div class="pc-setting-row"><div class="pc-setting-copy"><strong>本地诊断记录</strong><span>只记录功能、条目 ID 和是否生效，不保存聊天内容或 API 密钥。</span></div><label class="pc-toggle"><input type="checkbox" data-pc-setting="diagnosticsEnabled"${checked(settings.diagnosticsEnabled)}><span></span></label></div><div class="pc-setting-row"><div class="pc-setting-copy"><strong>关键格式高级编辑</strong><span>关闭时仍可查看关键条目，但修改前需要先开启此开关。</span></div><label class="pc-toggle"><input type="checkbox" data-pc-setting="criticalEditingEnabled"${checked(settings.criticalEditingEnabled)}><span></span></label></div></section><div class="pc-section-title">功能范围独立开关</div><section class="pc-setting-card">${rows}</section>`;
  }

  function renderPresets() {
    const cards = presets.map((preset) => {
      const bindingCount = bindings.filter((entry) => entry.presetId === preset.id).length;
      return `<article class="pc-card"><div class="pc-card-head"><div class="pc-card-main"><strong>${esc(preset.name)}</strong><span>${new Date(preset.updatedAt).toLocaleString()} · ${preset.items.length} 个条目${bindingCount ? ` · ${bindingCount} 个分配` : ""}</span></div></div>${preset.description ? `<div class="pc-item-preview">${esc(preset.description)}</div>` : ""}<div class="pc-card-actions"><button class="pc-small-button" data-pc-action="load-preset" data-id="${attr(preset.id)}" type="button">全局载入</button><button class="pc-small-button" data-pc-action="bind-preset" data-id="${attr(preset.id)}" type="button">分配范围</button><button class="pc-small-button" data-pc-action="export-preset" data-id="${attr(preset.id)}" type="button">导出</button><button class="pc-small-button" data-pc-action="rename-preset" data-id="${attr(preset.id)}" type="button">重命名</button><button class="pc-small-button" data-pc-action="delete-preset" data-id="${attr(preset.id)}" type="button">删除</button></div></article>`;
    }).join("");
    return `<section class="pc-setting-card"><div class="pc-setting-copy"><strong>当前配置</strong><span>预设保存条目内容、开关、范围和分类开关，不包含聊天、密钥或思维链配置。</span></div><div class="pc-card-actions"><button class="pc-primary-button" data-pc-action="save-preset" type="button">另存为预设</button><button class="pc-small-button" data-pc-action="export-all" type="button">导出全部</button></div></section>${cards || '<div class="pc-empty"><strong>暂无自定义预设</strong>可以把当前配置保存为独立预设。</div>'}`;
  }

  function renderTools() {
    const diagnostic = lastDiagnostic ? JSON.stringify(lastDiagnostic, null, 2) : "本次打开应用后还没有模型请求。";
    const variables = [
      ["{{character.name}}", "当前聊天角色名称"],
      ["{{character.persona}}", "当前聊天角色的人设"],
      ["{{user.name}}", "当前用户昵称"],
      ["{{user.persona}}", "当前用户人设"],
      ["{{chat.id}}", "当前聊天的唯一 ID"],
      ["{{chat.summary}}", "当前聊天保存的总结"],
      ["{{feature.id}}", "本次提示词所属的功能标识"],
      ["{{model.name}}", "API 设置中当前使用的模型名称"],
      ["{{date}}", "设备当前的本地日期"],
      ["{{time}}", "设备当前的本地时间"],
    ].map(([name, description]) => `<div class="pc-variable-row"><code>${esc(name)}</code><span>${esc(description)}</span></div>`).join("");
    return `<section class="pc-setting-card"><div class="pc-setting-copy"><strong>最近一次实际生效检查</strong><span>只展示请求分类和条目 ID，不展示聊天正文。</span></div><pre class="pc-code">${esc(diagnostic)}</pre></section><section class="pc-setting-card"><div class="pc-setting-copy"><strong>可用变量</strong><span>变量在发送请求前替换；未知变量保留原样，便于发现拼写错误。</span></div><div class="pc-variable-list">${variables}</div></section><section class="pc-setting-card"><div class="pc-setting-copy"><strong>安全恢复</strong><span>恢复默认只删除提示词中心的自定义数据，不影响聊天、API、思维链、世界书或其他设置。</span></div><div class="pc-card-actions"><button class="pc-danger-button" data-pc-action="reset-all" type="button">恢复提示词中心默认</button></div></section>`;
  }

  function render() {
    updateHeader();
    document.querySelectorAll("[data-pc-view]").forEach((button) => button.classList.toggle("active", button.dataset.pcView === activeView));
    const host = $("pc-main-content");
    if (!host) return;
    host.innerHTML = activeView === "items" ? renderItems() : activeView === "features" ? renderFeatures() : activeView === "presets" ? renderPresets() : renderTools();
    $("pc-search")?.addEventListener("input", (event) => { filterText = event.target.value; render(); $("pc-search")?.focus(); });
  }

  function showSheet(title, html, actions) {
    $("pc-sheet-title").textContent = title;
    $("pc-sheet-body").innerHTML = html;
    const actionHost = $("pc-sheet-actions");
    actionHost.innerHTML = "";
    (actions || []).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger ? "pc-danger-button" : action.primary ? "pc-primary-button" : "pc-secondary-button";
      button.textContent = action.label;
      button.addEventListener("click", async () => {
        try {
          const result = action.run ? await action.run() : true;
          if (result !== false && action.close !== false) closeSheet();
        } catch (error) { toast(error?.message || String(error)); }
      });
      actionHost.appendChild(button);
    });
    $("pc-sheet-backdrop").classList.add("visible");
    $("pc-sheet-backdrop").setAttribute("aria-hidden", "false");
  }

  function closeSheet() {
    $("pc-sheet-backdrop")?.classList.remove("visible");
    $("pc-sheet-backdrop")?.setAttribute("aria-hidden", "true");
  }

  function closeFeaturePicker() {
    $("pc-picker-backdrop")?.classList.remove("visible");
    $("pc-picker-backdrop")?.setAttribute("aria-hidden", "true");
    pickerSelectHandler = null;
  }

  function openFeaturePicker({ title = "选择功能范围", value = "all", includeAll = false, onSelect }) {
    const choices = includeAll ? [{ id: "all", name: "全部范围" }, ...FEATURES] : FEATURES;
    $("pc-picker-title").textContent = title;
    $("pc-picker-options").innerHTML = choices.map((feature) => `<button class="pc-picker-option${feature.id === value ? " selected" : ""}" data-pc-picker-value="${attr(feature.id)}" type="button"><span>${esc(feature.name)}</span><span aria-hidden="true">${feature.id === value ? "✓" : ""}</span></button>`).join("");
    pickerSelectHandler = onSelect;
    $("pc-picker-backdrop").classList.add("visible");
    $("pc-picker-backdrop").setAttribute("aria-hidden", "false");
    $("pc-picker-options").querySelector(".selected")?.scrollIntoView?.({ block: "nearest" });
  }

  async function resetPromptItems() {
    const db = await waitForDatabase();
    if (!db?.promptItems) throw new Error("提示词数据库尚未就绪");
    await db.promptItems.clear();
    items = [];
    await seedCatalogItems(db);
    settings.activePresetId = "current";
    await saveSettings();
  }

  function validateEditedItem(item) {
    if (!item.name.trim()) throw new Error("名称不能为空");
    if ((item.kind === "custom" || item.useCustom) && !item.customContent.trim()) throw new Error("自定义内容不能为空");
    if (item.risk === "critical" && item.useCustom) {
      if (!settings.criticalEditingEnabled) throw new Error("请先在“范围”中开启关键格式高级编辑");
      if (/JSON/i.test(item.defaultContent) && !/JSON|\{|\[/i.test(item.customContent)) throw new Error("关键格式内容缺少 JSON 或结构说明，已阻止保存");
    }
  }

  function itemEditor(item) {
    const source = normalizeItem(item || { kind: "custom", featureId: filterFeature === "all" ? "all" : filterFeature, name: "新提示词", role: "system", placement: "after", customContent: "", enabled: true });
    const content = source.kind === "custom" ? source.customContent : source.useCustom ? source.customContent : source.defaultContent;
    const html = `<div class="pc-field"><label for="pc-item-name">名称</label><input id="pc-item-name" class="pc-input" maxlength="80" value="${attr(source.name)}"></div>
      <div class="pc-inline-fields"><div class="pc-field"><label for="pc-item-feature-button">适用功能</label><input id="pc-item-feature" type="hidden" value="${attr(source.featureId)}"><button id="pc-item-feature-button" class="pc-select-button" type="button"><span>${esc(featureName(source.featureId, "全部 AI 功能"))}</span><span aria-hidden="true">⌄</span></button></div><div class="pc-field"><label for="pc-item-role">消息角色</label><select id="pc-item-role" class="pc-select">${["system","user","assistant"].map((role) => `<option value="${role}"${selected(source.role, role)}>${role}</option>`).join("")}</select></div></div>
      <div class="pc-inline-fields"><div class="pc-field"><label for="pc-item-placement">注入方式</label><select id="pc-item-placement" class="pc-select"${source.kind === "captured" ? " disabled" : ""}><option value="before"${selected(source.placement,"before")}>聊天记录之前</option><option value="after"${selected(source.placement,"after")}>聊天记录之后</option><option value="replace"${selected(source.placement,"replace")}>替换默认条目</option></select></div><div class="pc-field"><label for="pc-item-scope">作用范围</label><select id="pc-item-scope" class="pc-select"><option value="global"${selected(source.scopeType,"global")}>全局</option><option value="chat"${selected(source.scopeType,"chat")}${currentChatId() ? "" : " disabled"}>当前聊天</option></select></div></div>
      ${source.kind === "captured" ? `<div class="pc-field"><label>项目原始内容（只读）</label><pre class="pc-code">${esc(source.defaultContent)}</pre></div>` : ""}
      <div class="pc-field"><label for="pc-item-content">${source.kind === "captured" ? "自定义内容" : "内容"}</label><textarea id="pc-item-content" class="pc-textarea" spellcheck="false">${esc(content)}</textarea><div class="pc-field-note">支持角色、用户、聊天、模型、日期和时间变量。思维链内容不由这里管理。</div></div>`;
    showSheet(item ? "编辑提示词条目" : "新增提示词条目", html, [
      { label: "取消" },
      { label: "保存", primary: true, run: async () => {
          const updated = normalizeItem({ ...source,
            name: $("pc-item-name").value,
            featureId: $("pc-item-feature").value,
            role: $("pc-item-role").value,
            placement: source.kind === "captured" ? "replace" : $("pc-item-placement").value,
            scopeType: $("pc-item-scope").value,
            scopeId: $("pc-item-scope").value === "chat" ? currentChatId() : "",
            customContent: $("pc-item-content").value,
            useCustom: source.kind === "captured" ? $("pc-item-content").value !== source.defaultContent : true,
          });
          validateEditedItem(updated);
          await saveItem(updated);
          settings.activePresetId = "current";
          await saveSettings();
          render(); toast("提示词条目已保存");
      } },
    ]);
    $("pc-item-feature-button").addEventListener("click", () => openFeaturePicker({
      title: "选择适用功能",
      value: $("pc-item-feature").value,
      includeAll: source.kind === "custom",
      onSelect: (value) => {
        $("pc-item-feature").value = value;
        $("pc-item-feature-button").firstElementChild.textContent = featureName(value, "全部 AI 功能");
      },
    }));
  }

  function textPrompt(title, initialValue, onSave) {
    showSheet(title, `<div class="pc-field"><label for="pc-text-value">名称</label><input id="pc-text-value" class="pc-input" maxlength="80" value="${attr(initialValue || "")}"></div>`, [
      { label: "取消" },
      { label: "保存", primary: true, run: async () => { const value = $("pc-text-value").value.trim(); if (!value) { toast("名称不能为空"); return false; } await onSave(value); render(); } },
    ]);
  }

  function confirmAction(title, message, actionLabel, run) {
    showSheet(title, `<div class="pc-setting-card"><div class="pc-setting-copy"><strong>${esc(message)}</strong><span>此操作只影响提示词中心，不会修改思维链或聊天数据。</span></div></div>`, [{ label: "取消" }, { label: actionLabel, danger: true, run }]);
  }

  function downloadPayload(payload, fileName) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportPayload(preset) {
    const cleanItem = (item) => ({ ...clone(item), defaultContent: item.kind === "captured" ? "" : item.defaultContent });
    const cleanPreset = (entry) => ({ ...clone(entry), items: entry.items.map(cleanItem) });
    const payload = { format: FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), settings: preset ? preset.settings : clone(settings), items: (preset ? preset.items : items).map(cleanItem), presets: preset ? [cleanPreset(preset)] : presets.map(cleanPreset), bindings: preset ? [] : clone(bindings) };
    downloadPayload(payload, `${preset ? `提示词预设_${preset.name}` : "提示词中心全部配置"}_${new Date().toISOString().slice(0,10)}.json`);
    toast("提示词配置已导出");
  }

  async function applyImported(payload, mode, applyImportedSwitch) {
    const importedItems = (Array.isArray(payload.items) ? payload.items : []).map(normalizeItem);
    const importedPresets = (Array.isArray(payload.presets) ? payload.presets : []).map(normalizePreset);
    const importedBindings = (Array.isArray(payload.bindings) ? payload.bindings : []).filter((entry) => entry?.id && entry?.presetId);
    const db = await waitForDatabase();
    if (!db) throw new Error("数据库尚未就绪");
    await db.transaction("rw", db.promptSettings, db.promptItems, db.promptPresets, db.promptBindings, async () => {
      if (mode === "replace") {
        await db.promptItems.clear(); await db.promptPresets.clear(); await db.promptBindings.clear();
        items = importedItems; presets = importedPresets; bindings = importedBindings;
      } else {
        const existingItemIds = new Set(items.map((item) => item.id));
        const existingPresetIds = new Set(presets.map((preset) => preset.id));
        const presetIdMap = new Map();
        importedItems.forEach((item) => { if (existingItemIds.has(item.id)) item.id = `${item.id}-import-${Date.now()}-${Math.random().toString(36).slice(2,5)}`; items.push(item); });
        importedPresets.forEach((preset) => { const originalId = preset.id; if (existingPresetIds.has(preset.id)) preset.id = `${preset.id}-import-${Date.now()}-${Math.random().toString(36).slice(2,5)}`; presetIdMap.set(originalId, preset.id); presets.push(preset); });
        importedBindings.forEach((entry) => { entry.presetId = presetIdMap.get(entry.presetId) || entry.presetId; if (bindings.some((current) => current.id === entry.id)) entry.id = `${entry.id}-import-${Date.now()}-${Math.random().toString(36).slice(2,5)}`; bindings.push(entry); });
      }
      if (mode === "replace" && payload.settings) {
        const previousEnabled = settings.enabled;
        settings = normalizeSettings(payload.settings);
        if (!applyImportedSwitch) settings.enabled = previousEnabled;
      } else if (applyImportedSwitch && payload.settings) {
        settings.enabled = payload.settings.enabled === true;
      }
      await db.promptSettings.put(clone(settings));
      if (items.length) await db.promptItems.bulkPut(clone(items));
      if (presets.length) await db.promptPresets.bulkPut(clone(presets));
      if (bindings.length) await db.promptBindings.bulkPut(clone(bindings));
    });
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || ""));
        if (payload?.format !== FORMAT || Number(payload.schemaVersion) !== SCHEMA_VERSION) throw new Error("不是可识别的提示词中心配置文件");
        const count = (payload.items?.length || 0) + (payload.presets?.length || 0);
        showSheet("导入提示词配置", `<div class="pc-setting-card"><div class="pc-setting-copy"><strong>检测到 ${count} 项提示词数据</strong><span>安全合并会保留现有配置并为冲突项创建副本；完整替换会先清空提示词中心数据。思维链和聊天不会受影响。</span></div><div class="pc-setting-row"><div class="pc-setting-copy"><strong>应用文件中的总开关状态</strong><span>关闭时保留当前“启用自定义提示词”状态。</span></div><label class="pc-toggle"><input id="pc-import-apply-switch" type="checkbox"><span></span></label></div></div>`, [
          { label: "取消" },
          { label: "安全合并", primary: true, run: async () => { await applyImported(payload, "merge", $("pc-import-apply-switch").checked); render(); toast("提示词配置已安全合并"); } },
          { label: "完整替换", danger: true, run: async () => { await applyImported(payload, "replace", $("pc-import-apply-switch").checked); render(); toast("提示词配置已替换"); } },
        ]);
      } catch (error) { toast(`导入失败：${error.message}`); }
    };
    reader.onerror = () => toast("导入失败：无法读取文件");
    reader.readAsText(file);
  }

  async function handleAction(action, id) {
    const item = items.find((entry) => entry.id === id);
    const preset = presets.find((entry) => entry.id === id);
    if (action === "pick-filter-feature") openFeaturePicker({ title: "筛选功能范围", value: filterFeature, includeAll: true, onSelect: (value) => { filterFeature = value; render(); } });
    else if (action === "add-item") itemEditor(null);
    else if (action === "edit-item" && item) itemEditor(item);
    else if (action === "copy-item" && item) itemEditor(normalizeItem({ ...clone(item), id: "", kind: "custom", name: `${item.name} 副本`, defaultContent: "", customContent: item.useCustom ? item.customContent : item.defaultContent, useCustom: true, risk: "normal" }));
    else if (action === "reset-item" && item) confirmAction("恢复默认", `确定恢复“${item.name}”的项目原始内容？`, "恢复", async () => { item.useCustom = false; item.customContent = ""; item.enabled = true; await saveItem(item); render(); toast("已恢复默认内容"); });
    else if (action === "delete-item" && item) confirmAction("删除条目", `确定删除“${item.name}”？`, "删除", async () => { await deleteItem(item.id); render(); toast("条目已删除"); });
    else if (action === "save-preset") textPrompt("另存为预设", "", async (name) => { const now = Date.now(); await savePreset({ id: `pc-preset-${now}-${Math.random().toString(36).slice(2,7)}`, name, createdAt: now, updatedAt: now, settings: clone(settings), items: clone(items) }); toast("预设已保存"); });
    else if (action === "load-preset" && preset) confirmAction("载入预设", `使用“${preset.name}”替换当前提示词中心配置？`, "载入", async () => { const db = await waitForDatabase(); await db.transaction("rw", db.promptSettings, db.promptItems, async () => { await db.promptItems.clear(); items = preset.items.map(normalizeItem); settings = normalizeSettings({ ...preset.settings, activePresetId: preset.id }); await db.promptSettings.put(clone(settings)); if (items.length) await db.promptItems.bulkPut(clone(items)); }); render(); toast("预设已载入"); });
    else if (action === "bind-preset" && preset) {
      const html = `<div class="pc-field"><label for="pc-binding-feature-button">功能范围</label><input id="pc-binding-feature" type="hidden" value="${FEATURES[0].id}"><button id="pc-binding-feature-button" class="pc-select-button" type="button"><span>${esc(FEATURES[0].name)}</span><span aria-hidden="true">⌄</span></button></div><div class="pc-field"><label for="pc-binding-scope">分配层级</label><select id="pc-binding-scope" class="pc-select"><option value="feature">该功能的全部角色</option><option value="chat"${currentChatId() ? "" : " disabled"}>该功能的当前聊天</option></select><div class="pc-field-note">当前聊天分配优先于功能分配；全局使用请点击“全局载入”。</div></div>`;
      showSheet("分配提示词预设", html, [{ label: "取消" }, ...(bindings.some((entry) => entry.presetId === preset.id) ? [{ label: "清除该预设分配", danger: true, run: async () => {
        const ids = bindings.filter((entry) => entry.presetId === preset.id).map((entry) => entry.id);
        bindings = bindings.filter((entry) => entry.presetId !== preset.id);
        if (ids.length) await window.db.promptBindings.bulkDelete(ids);
        render(); toast("预设分配已清除");
      } }] : []), { label: "保存分配", primary: true, run: async () => {
        const featureId = $("pc-binding-feature").value;
        const scopeType = $("pc-binding-scope").value;
        const scopeId = scopeType === "chat" ? currentChatId() : "*";
        const id = `pc-binding:${scopeType}:${scopeId}:${featureId}`;
        const binding = { id, presetId: preset.id, scopeType, scopeId, featureId, updatedAt: Date.now() };
        const index = bindings.findIndex((entry) => entry.id === id);
        if (index >= 0) bindings[index] = binding; else bindings.push(binding);
        await window.db.promptBindings.put(clone(binding)); render(); toast("预设范围已分配");
      } }]);
      $("pc-binding-feature-button").addEventListener("click", () => openFeaturePicker({ title: "选择预设功能范围", value: $("pc-binding-feature").value, onSelect: (value) => { $("pc-binding-feature").value = value; $("pc-binding-feature-button").firstElementChild.textContent = featureName(value); } }));
    }
    else if (action === "export-preset" && preset) exportPayload(preset);
    else if (action === "export-all") exportPayload(null);
    else if (action === "rename-preset" && preset) textPrompt("重命名预设", preset.name, async (name) => { preset.name = name; preset.updatedAt = Date.now(); await savePreset(preset); toast("预设已重命名"); });
    else if (action === "delete-preset" && preset) confirmAction("删除预设", `确定删除“${preset.name}”？相关范围分配也会一并移除。`, "删除", async () => { presets = presets.filter((entry) => entry.id !== preset.id); const removed = bindings.filter((entry) => entry.presetId === preset.id).map((entry) => entry.id); bindings = bindings.filter((entry) => entry.presetId !== preset.id); await window.db.transaction("rw", window.db.promptPresets, window.db.promptBindings, async () => { await window.db.promptPresets.delete(preset.id); if (removed.length) await window.db.promptBindings.bulkDelete(removed); }); render(); toast("预设已删除"); });
    else if (action === "reset-all") confirmAction("恢复默认", "确定清空所有自定义提示词、预设和提示词中心设置？", "全部恢复", async () => { const db = await waitForDatabase(); await db.transaction("rw", db.promptSettings, db.promptItems, db.promptPresets, db.promptBindings, db.promptDiagnostics, async () => { await Promise.all([db.promptSettings.clear(), db.promptItems.clear(), db.promptPresets.clear(), db.promptBindings.clear(), db.promptDiagnostics.clear()]); }); settings = clone(DEFAULT_SETTINGS); items = []; presets = []; bindings = []; lastDiagnostic = null; await seedCatalogItems(db); render(); toast("提示词中心已恢复默认"); });
  }

  async function open() {
    await load();
    render();
  }

  function init() {
    if (!$("prompt-center-screen")) return;
    $("pc-master-switch").addEventListener("change", async (event) => { settings.enabled = event.target.checked; settings.activePresetId = "current"; try { await saveSettings(); render(); toast(settings.enabled ? "自定义提示词已开启" : "已关闭并恢复项目原始请求"); } catch (error) { settings.enabled = false; event.target.checked = false; toast(error.message); } });
    document.querySelector(".pc-view-switch").addEventListener("click", (event) => { const button = event.target.closest("[data-pc-view]"); if (!button) return; activeView = button.dataset.pcView; render(); });
    $("pc-main-content").addEventListener("click", (event) => { const button = event.target.closest("[data-pc-action]"); if (button) handleAction(button.dataset.pcAction, button.dataset.id); });
    $("pc-main-content").addEventListener("change", async (event) => {
      const itemId = event.target.dataset.pcToggleItem;
      if (itemId) {
        const item = items.find((entry) => entry.id === itemId);
        if (item && item.risk === "critical" && !event.target.checked) {
          event.target.checked = true;
          confirmAction("关闭关键格式", `关闭“${item.name}”可能导致该功能的模型回复无法解析。仍要关闭吗？`, "仍然关闭", async () => { item.enabled = false; await saveItem(item); settings.activePresetId = "current"; await saveSettings(); render(); toast("关键格式条目已关闭"); });
        } else if (item) {
          item.enabled = event.target.checked; await saveItem(item); settings.activePresetId = "current"; await saveSettings(); updateHeader();
        }
      }
      const featureId = event.target.dataset.pcFeature;
      if (featureId) { settings.featureToggles[featureId] = event.target.checked; settings.activePresetId = "current"; await saveSettings(); updateHeader(); }
      const settingName = event.target.dataset.pcSetting;
      if (settingName) { settings[settingName] = event.target.checked; settings.activePresetId = "current"; await saveSettings(); render(); }
    });
    $("pc-sheet-close").addEventListener("click", closeSheet);
    $("pc-sheet-backdrop").addEventListener("click", (event) => { if (event.target === $("pc-sheet-backdrop")) closeSheet(); });
    $("pc-picker-close").addEventListener("click", closeFeaturePicker);
    $("pc-picker-backdrop").addEventListener("click", (event) => { if (event.target === $("pc-picker-backdrop")) closeFeaturePicker(); });
    $("pc-picker-options").addEventListener("click", (event) => {
      const button = event.target.closest("[data-pc-picker-value]");
      if (!button) return;
      const onSelect = pickerSelectHandler;
      closeFeaturePicker();
      onSelect?.(button.dataset.pcPickerValue);
    });
    $("pc-reset-prompts-btn").addEventListener("click", () => confirmAction("重置提示词", "确定把提示词条目恢复为项目默认内容？自定义预设、范围开关和其他设置会保留。", "重置条目", async () => { await resetPromptItems(); render(); toast("提示词条目已恢复默认"); }));
    $("pc-import-btn").addEventListener("click", () => $("pc-import-input").click());
    $("pc-import-input").addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) importFile(file); });
    render();
  }

  installFetchHook();
  load();
  window.PromptCenterApp = { open, prepareMessages, getSettings: () => clone(settings), getItems: () => clone(items), detectFeature };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
