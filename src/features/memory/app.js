(function () {
  "use strict";

  const SETTINGS_PREFIX = "memory:";
  const VECTOR_BATCH = 24;
  const processing = new Set();
  let activeTab = "text";
  let editingFactId = null;
  let toastTimer = null;
  let worker = null;
  let workerSequence = 0;
  const workerRequests = new Map();

  const defaults = () => ({
    id: "",
    chatId: "",
    vectorEnabled: false,
    vectorProvider: "local-lite",
    vectorModel: "Xenova/bge-small-zh-v1.5",
    vectorEndpoint: "",
    vectorApiKey: "",
    vectorDimensions: 384,
    vectorTopK: 5,
    vectorThreshold: 0.18,
    vectorTokenBudget: 700,
    vectorIncludeLinked: false,
    tableEnabled: false,
    tableAutoExtract: false,
    tableExtractCount: 12,
    tableTokenBudget: 700,
    tableIncludeLinked: false,
    lastVectorIndex: -1,
    lastTableIndex: -1,
    updatedAt: Date.now(),
  });

  function databaseReady() {
    return window.db && window.db.memorySettings && window.db.memoryVectors && window.db.memoryFacts;
  }

  function currentChat() {
    return window.state?.activeChatId ? window.state.chats?.[window.state.activeChatId] : null;
  }

  function idFor(chatId) {
    return `${SETTINGS_PREFIX}${chatId}`;
  }

  async function getSettings(chatId) {
    if (!databaseReady()) return { ...defaults(), id: idFor(chatId), chatId };
    const saved = await window.db.memorySettings.get(idFor(chatId));
    return { ...defaults(), ...(saved || {}), id: idFor(chatId), chatId };
  }

  async function saveSettings(chatId, patch) {
    const value = { ...(await getSettings(chatId)), ...patch, id: idFor(chatId), chatId, updatedAt: Date.now() };
    await window.db.memorySettings.put(value);
    return value;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeVector(vector) {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const scale = Math.sqrt(sum) || 1;
    return Array.from(vector, (value) => value / scale);
  }

  function liteEmbed(text, dimensions) {
    const vector = new Float32Array(dimensions);
    const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
    const terms = normalized.match(/[\u3400-\u9fff]|[a-z0-9_]+|[^\s]/g) || [];
    const features = terms.concat(terms.slice(0, -1).map((term, index) => `${term}${terms[index + 1]}`));
    for (const feature of features) {
      const hash = parseInt(hashString(feature), 36) >>> 0;
      vector[hash % dimensions] += hash & 1 ? 1 : -1;
    }
    return normalizeVector(vector);
  }

  function getNeuralWorker() {
    if (worker) return worker;
    const code = `
      import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
      const models = new Map();
      self.onmessage = async (event) => {
        const { id, model, texts } = event.data;
        try {
          let extractor = models.get(model);
          if (!extractor) {
            extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
            models.set(model, extractor);
          }
          const result = await extractor(texts, { pooling: "mean", normalize: true });
          self.postMessage({ id, vectors: result.tolist() });
        } catch (error) {
          self.postMessage({ id, error: error?.message || String(error) });
        }
      };
    `;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    worker = new Worker(url, { type: "module" });
    URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => {
      const request = workerRequests.get(data.id);
      if (!request) return;
      workerRequests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.vectors);
    };
    worker.onerror = (event) => {
      for (const request of workerRequests.values()) request.reject(new Error(event.message || "本地语义模型加载失败"));
      workerRequests.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  }

  async function embedTexts(texts, settings) {
    if (!texts.length) return [];
    if (settings.vectorProvider === "local-lite") {
      return texts.map((text) => liteEmbed(text, Number(settings.vectorDimensions) || 384));
    }
    if (settings.vectorProvider === "local-neural") {
      const id = ++workerSequence;
      const promise = new Promise((resolve, reject) => workerRequests.set(id, { resolve, reject }));
      getNeuralWorker().postMessage({ id, model: settings.vectorModel || defaults().vectorModel, texts });
      return promise;
    }
    const endpoint = String(settings.vectorEndpoint || "").replace(/\/$/, "");
    if (!endpoint) throw new Error("请先填写兼容 Embeddings 接口地址");
    const response = await fetch(endpoint.endsWith("/embeddings") ? endpoint : `${endpoint}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.vectorApiKey ? { Authorization: `Bearer ${settings.vectorApiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.vectorModel, input: texts }),
    });
    if (!response.ok) throw new Error(`向量接口返回 ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const ordered = [...(data.data || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
    if (ordered.length !== texts.length) throw new Error("向量接口返回数量与输入不一致");
    return ordered.map((item) => normalizeVector(item.embedding || []));
  }

  function messageText(message, chat) {
    if (!message || message.isHidden || message.type === "summary") return "";
    let content = "";
    if (typeof message.content === "string") content = message.content;
    else if (message.type === "voice_message") content = message.content || "";
    else if (message.meaning) content = `[表情：${message.meaning}]`;
    if (!content.trim()) return "";
    const sender = message.role === "user" ? chat.settings?.myNickname || "我" : message.senderName || chat.name || "角色";
    return `${sender}：${content.trim()}`;
  }

  function vectorSourceKey(chatId, message, index) {
    return `${chatId}:${message.type || "message"}:${message.timestamp || index}:${hashString(String(message.content || message.meaning || ""))}`;
  }

  async function indexChat(chatId, options = {}) {
    const chat = window.state?.chats?.[chatId];
    if (!chat || !databaseReady()) return { added: 0 };
    const settings = await getSettings(chatId);
    if (!settings.vectorEnabled && !options.force) return { added: 0 };
    const start = options.rebuild ? 0 : Math.max(0, Number(settings.lastVectorIndex) + 1);
    if (options.rebuild) await window.db.memoryVectors.where("chatId").equals(chatId).delete();
    const items = [];
    chat.history.forEach((message, index) => {
      if (index < start) return;
      const text = message.type === "summary" ? String(message.content || "").trim() : messageText(message, chat);
      if (!text) return;
      items.push({ message, index, text });
    });
    for (let offset = 0; offset < items.length; offset += VECTOR_BATCH) {
      const batch = items.slice(offset, offset + VECTOR_BATCH);
      const vectors = await embedTexts(batch.map((item) => item.text), settings);
      const now = Date.now();
      await window.db.memoryVectors.bulkPut(batch.map((item, index) => ({
        id: vectorSourceKey(chatId, item.message, item.index),
        chatId,
        sourceType: item.message.type === "summary" ? "summary" : "message",
        sourceIndex: item.index,
        content: item.text,
        timestamp: item.message.timestamp || now,
        embedding: vectors[index],
        provider: settings.vectorProvider,
        model: settings.vectorModel,
        contentHash: hashString(item.text),
        createdAt: now,
      })));
    }
    await saveSettings(chatId, { lastVectorIndex: Math.max(-1, chat.history.length - 1) });
    return { added: items.length };
  }

  function stripFence(value) {
    return String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  async function extractFacts(chatId, messages, settings) {
    const chat = window.state?.chats?.[chatId];
    const config = window.state?.apiConfig || {};
    if (!config.proxyUrl || !config.apiKey || !config.model) throw new Error("主 API 未配置，无法自动提取表格记忆");
    const transcript = messages.map(({ message, index }) => `[${index}] ${new Date(message.timestamp || Date.now()).toLocaleString("zh-CN", { hour12: false })} ${messageText(message, chat)}`).join("\n");
    const prompt = `从以下角色扮演对话中提取值得长期保存、未来会影响回复的明确事实。忽略寒暄、猜测、临时语气和重复内容。只输出 JSON：{"facts":[{"subject":"主体","predicate":"属性或关系","value":"值","category":"profile|relationship|preference|event|promise|boundary|task|world","confidence":0到1}]}; 没有事实时输出 {"facts":[]}。不要编造。\n\n${transcript}`;
    const isGemini = window.ApiGenerationParams.isGemini(config.proxyUrl, config);
    let response;
    if (isGemini) {
      response = await fetch(`${config.proxyUrl}/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { ...window.ApiGenerationParams.gemini({ temperature: 0.1 }), responseMimeType: "application/json" } }),
      });
    } else {
      response = await fetch(`${String(config.proxyUrl).replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], ...window.ApiGenerationParams.openAI({ temperature: 0.1 }) }),
      });
    }
    if (!response.ok) throw new Error(`事实提取接口返回 ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const content = isGemini ? data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") : data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(stripFence(content));
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  }

  function cleanFact(input) {
    const allowed = new Set(["profile", "relationship", "preference", "event", "promise", "boundary", "task", "world"]);
    const subject = String(input.subject || "").trim().slice(0, 80);
    const predicate = String(input.predicate || "").trim().slice(0, 80);
    const value = String(input.value || "").trim().slice(0, 1000);
    if (!subject || !predicate || !value) return null;
    return { subject, predicate, value, category: allowed.has(input.category) ? input.category : "profile", confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0.8)) };
  }

  async function upsertFact(chatId, fact, source = "auto") {
    const clean = cleanFact(fact);
    if (!clean) return null;
    const active = await window.db.memoryFacts.where("chatId").equals(chatId).filter((item) => item.status === "active" && item.subject === clean.subject && item.predicate === clean.predicate).toArray();
    const same = active.find((item) => item.value === clean.value);
    if (same) {
      await window.db.memoryFacts.update(same.id, { confidence: Math.max(same.confidence || 0, clean.confidence), updatedAt: Date.now() });
      return same.id;
    }
    const locked = active.find((item) => item.locked);
    if (locked) return locked.id;
    const now = Date.now();
    for (const item of active) await window.db.memoryFacts.update(item.id, { status: "superseded", validTo: now, updatedAt: now });
    const id = `fact:${chatId}:${now}:${hashString(`${clean.subject}:${clean.predicate}:${clean.value}`)}`;
    await window.db.memoryFacts.put({ id, chatId, ...clean, status: "active", visibility: "private", locked: false, source, validFrom: now, validTo: null, createdAt: now, updatedAt: now });
    return id;
  }

  async function processTable(chatId) {
    const chat = window.state?.chats?.[chatId];
    const settings = await getSettings(chatId);
    if (!chat || !settings.tableEnabled || !settings.tableAutoExtract) return { added: 0 };
    const start = Math.max(0, Number(settings.lastTableIndex) + 1);
    const eligible = [];
    chat.history.forEach((message, index) => { if (index >= start && messageText(message, chat)) eligible.push({ message, index }); });
    if (eligible.length < Math.max(2, Number(settings.tableExtractCount) || 12)) return { added: 0 };
    const facts = await extractFacts(chatId, eligible, settings);
    let added = 0;
    for (const fact of facts) { if (await upsertFact(chatId, fact, "auto")) added += 1; }
    await saveSettings(chatId, { lastTableIndex: chat.history.length - 1 });
    return { added };
  }

  async function processChat(chatId) {
    if (!chatId || processing.has(chatId) || !databaseReady()) return;
    processing.add(chatId);
    try {
      const settings = await getSettings(chatId);
      if (settings.vectorEnabled) await indexChat(chatId);
      if (settings.tableEnabled && settings.tableAutoExtract) await processTable(chatId);
    } catch (error) {
      console.error("长期记忆处理失败:", error);
    } finally {
      processing.delete(chatId);
    }
  }

  function linkedChatIds(chat, enabled) {
    if (!enabled) return [];
    return (chat.settings?.linkedMemories || []).map((item) => item.chatId).filter((id) => window.state?.chats?.[id]);
  }

  function cosine(a, b) {
    if (!a?.length || a.length !== b?.length) return -1;
    let score = 0;
    for (let index = 0; index < a.length; index += 1) score += a[index] * b[index];
    return score;
  }

  function withinBudget(lines, budget) {
    const limit = Math.max(200, Number(budget) || 700) * 2;
    const result = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length > limit && result.length) break;
      result.push(line.slice(0, Math.max(0, limit - used)));
      used += line.length;
      if (used >= limit) break;
    }
    return result;
  }

  async function buildContext({ chatId, recentMessages = [], mode = "chat" }) {
    if (!databaseReady() || !chatId) return "";
    const chat = window.state?.chats?.[chatId];
    if (!chat) return "";
    const settings = await getSettings(chatId);
    const query = recentMessages.map((message) => messageText(message, chat)).filter(Boolean).slice(-6).join("\n");
    const log = { id: `recall:${chatId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, chatId, timestamp: Date.now(), mode, query, vectorItems: [], factIds: [], errors: [] };
    const sections = [];
    if (settings.tableEnabled) {
      try {
        const ids = [chatId, ...linkedChatIds(chat, settings.tableIncludeLinked)];
        let facts = await window.db.memoryFacts.where("chatId").anyOf(ids).filter((item) => item.status === "active").toArray();
        const queryTerms = new Set((query.match(/[\u3400-\u9fff]|[a-z0-9_]+/gi) || []).map((term) => term.toLowerCase()));
        facts = facts.map((fact) => ({ fact, score: (fact.chatId === chatId ? 2 : 0) + (["boundary", "promise", "relationship", "task"].includes(fact.category) ? 1 : 0) + [...queryTerms].filter((term) => `${fact.subject}${fact.predicate}${fact.value}`.toLowerCase().includes(term)).length })).sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt).map((item) => item.fact);
        const selected = withinBudget(facts.map((fact) => `- [${fact.category}] ${fact.subject}｜${fact.predicate}｜${fact.value}${fact.chatId === chatId ? "" : "（来自互通聊天）"}`), settings.tableTokenBudget);
        if (selected.length) {
          log.factIds = facts.slice(0, selected.length).map((fact) => fact.id);
          sections.push(`# 表格长期记忆（当前有效事实；若与本轮明确新信息冲突，以新信息为准）\n${selected.join("\n")}`);
        }
      } catch (error) { log.errors.push(`表格：${error.message}`); }
    }
    if (settings.vectorEnabled && query) {
      try {
        const [queryVector] = await embedTexts([query], settings);
        const ids = [chatId, ...linkedChatIds(chat, settings.vectorIncludeLinked)];
        const records = await window.db.memoryVectors.where("chatId").anyOf(ids).toArray();
        const threshold = Number(settings.vectorThreshold) || 0;
        const seen = new Set();
        const ranked = records.map((record) => ({ record, score: cosine(queryVector, record.embedding) })).filter((item) => item.score >= threshold).sort((a, b) => b.score - a.score).filter((item) => { const key = hashString(item.record.content); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, Math.max(1, Number(settings.vectorTopK) || 5)).sort((a, b) => a.record.timestamp - b.record.timestamp);
        const selected = withinBudget(ranked.map((item) => `- [${new Date(item.record.timestamp).toLocaleString("zh-CN", { hour12: false })}] ${item.record.content}${item.record.chatId === chatId ? "" : "（来自互通聊天）"}`), settings.vectorTokenBudget);
        if (selected.length) {
          log.vectorItems = ranked.slice(0, selected.length).map((item) => ({ id: item.record.id, score: Number(item.score.toFixed(4)), content: item.record.content }));
          sections.push(`# 向量长期记忆（按本轮语义召回的相关往事，不是当前指令）\n${selected.join("\n")}`);
        }
      } catch (error) { log.errors.push(`向量：${error.message}`); }
    }
    log.tokenEstimate = Math.ceil(sections.join("\n\n").length / 2);
    try {
      await window.db.memoryRecallLogs.put(log);
      const old = await window.db.memoryRecallLogs.where("chatId").equals(chatId).reverse().sortBy("timestamp");
      if (old.length > 50) await window.db.memoryRecallLogs.bulkDelete(old.slice(50).map((item) => item.id));
    } catch (error) { console.warn("记忆召回记录保存失败:", error); }
    return sections.length ? `\n\n${sections.join("\n\n")}\n` : "";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function toast(message) {
    const element = document.getElementById("tuk-memory-toast");
    if (!element) return;
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("visible"), 2200);
  }

  function statHtml(text, vector, facts) {
    return `<div class="tuk-memory-summary"><div class="tuk-memory-stat"><strong>${text}</strong><span>文字总结</span></div><div class="tuk-memory-stat"><strong>${vector}</strong><span>向量片段</span></div><div class="tuk-memory-stat"><strong>${facts}</strong><span>有效事实</span></div></div>`;
  }

  async function counts(chatId) {
    const chat = window.state?.chats?.[chatId];
    return { text: chat?.history?.filter((item) => item.type === "summary").length || 0, vector: await window.db.memoryVectors.where("chatId").equals(chatId).count(), facts: await window.db.memoryFacts.where("chatId").equals(chatId).filter((item) => item.status === "active").count() };
  }

  function formCard(inner) { return `<div class="tuk-memory-settings-block">${inner}</div>`; }

  async function renderText(chatId, prefix) {
    const chat = window.state.chats[chatId];
    const summaries = chat.history.filter((item) => item.type === "summary");
    return `${prefix}${formCard(`<h3>传统文字记忆</h3><p class="tuk-memory-help">沿用原有长期总结能力、提示词、自动/手动模式和总结管理，不改变原来的生成与注入逻辑。</p><div class="tuk-memory-actions"><button class="tuk-memory-btn" data-action="open-original-summary">打开原有总结管理</button></div>`)}${summaries.length ? summaries.slice().reverse().map((item, reverseIndex) => `<article class="tuk-memory-card"><div class="tuk-memory-card-head"><strong>总结 ${summaries.length - reverseIndex}</strong><span class="tuk-memory-badge">传统文字</span></div><p>${escapeHtml(item.content)}</p><div class="tuk-memory-meta">${new Date(item.timestamp || Date.now()).toLocaleString()}</div></article>`).join("") : `<div class="tuk-memory-empty">还没有传统文字总结。原有自动总结或手动总结生成后会显示在这里。</div>`}`;
  }

  async function renderVector(chatId, prefix, settings) {
    const records = await window.db.memoryVectors.where("chatId").equals(chatId).reverse().sortBy("timestamp");
    return `${prefix}${formCard(`<h3>向量记忆</h3><p class="tuk-memory-help">把聊天片段编码为向量，在每轮回复前只召回与当前对话最相关的往事。关闭时不会索引或注入。</p><div class="tuk-memory-actions"><button class="tuk-memory-btn" data-action="index-vector" ${settings.vectorEnabled ? "" : "disabled"}>索引现有聊天</button><button class="tuk-memory-danger" data-action="rebuild-vector" ${settings.vectorEnabled ? "" : "disabled"}>重建索引</button><button class="tuk-memory-danger" data-action="clear-vector">清空向量</button></div>`)}${records.length ? records.slice(0, 100).map((item) => `<article class="tuk-memory-card"><div class="tuk-memory-card-head"><strong>${escapeHtml(item.sourceType === "summary" ? "总结片段" : "对话片段")}</strong><span class="tuk-memory-badge">${escapeHtml(item.provider || "")}</span></div><p>${escapeHtml(item.content)}</p><div class="tuk-memory-meta">${new Date(item.timestamp).toLocaleString()} · ${escapeHtml(item.model || `${item.embedding?.length || 0} 维`)}</div><div class="tuk-memory-actions"><button class="tuk-memory-danger" data-action="delete-vector" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join("") : `<div class="tuk-memory-empty">还没有向量片段。启用向量记忆后可索引已有聊天，之后的新消息会自动增量索引。</div>`}`;
  }

  async function renderTable(chatId, prefix) {
    const facts = await window.db.memoryFacts.where("chatId").equals(chatId).reverse().sortBy("updatedAt");
    const editing = facts.find((item) => item.id === editingFactId);
    const categories = [["profile", "资料"], ["relationship", "关系"], ["preference", "偏好"], ["event", "事件"], ["promise", "承诺"], ["boundary", "边界"], ["task", "待办"], ["world", "世界设定"]];
    const form = `<h3>${editing ? "编辑表格事实" : "新增表格事实"}</h3><form id="tuk-memory-fact-form" class="tuk-memory-form">${editing ? `<input type="hidden" name="id" value="${escapeHtml(editing.id)}">` : ""}<div class="tuk-memory-form-row"><label class="tuk-memory-field"><span>主体</span><input class="tuk-memory-input" name="subject" maxlength="80" value="${escapeHtml(editing?.subject || "")}" placeholder="如：我 / 角色名" required></label><label class="tuk-memory-field"><span>类别</span><select class="tuk-memory-select" name="category">${categories.map(([value, label]) => `<option value="${value}" ${editing?.category === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div><label class="tuk-memory-field"><span>属性 / 关系</span><input class="tuk-memory-input" name="predicate" maxlength="80" value="${escapeHtml(editing?.predicate || "")}" placeholder="如：喜欢、生日、答应" required></label><label class="tuk-memory-field"><span>值</span><textarea class="tuk-memory-textarea" name="value" maxlength="1000" placeholder="明确、可独立理解的事实" required>${escapeHtml(editing?.value || "")}</textarea></label><div class="tuk-memory-actions"><button class="tuk-memory-btn" type="submit">${editing ? "保存修改" : "保存事实"}</button>${editing ? `<button class="tuk-memory-btn" type="button" data-action="cancel-fact-edit">取消</button>` : ""}</div></form>`;
    return `${prefix}${formCard(form)}${facts.length ? facts.slice(0, 120).map((item) => `<article class="tuk-memory-card"><div class="tuk-memory-card-head"><strong>${escapeHtml(item.subject)}｜${escapeHtml(item.predicate)}</strong><span class="tuk-memory-badge">${escapeHtml(item.status === "active" ? item.category : "已失效")}</span></div><p>${escapeHtml(item.value)}</p><div class="tuk-memory-meta">${item.locked ? "已锁定 · " : ""}${item.source === "auto" ? "自动提取" : "手动添加"} · ${new Date(item.updatedAt).toLocaleString()}</div><div class="tuk-memory-actions"><button class="tuk-memory-btn" data-action="edit-fact" data-id="${escapeHtml(item.id)}">编辑</button><button class="tuk-memory-btn" data-action="toggle-fact-lock" data-id="${escapeHtml(item.id)}">${item.locked ? "解锁" : "锁定"}</button><button class="tuk-memory-btn" data-action="toggle-fact-status" data-id="${escapeHtml(item.id)}">${item.status === "active" ? "标为失效" : "恢复有效"}</button><button class="tuk-memory-danger" data-action="delete-fact" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join("") : `<div class="tuk-memory-empty">还没有表格事实。可以手动添加；开启自动提取后，系统会从新增对话中识别稳定事实。</div>`}`;
  }

  function renderSettings(prefix, settings) {
    const toggle = (name, label, checked) => `<label class="toggle-switch-label tuk-memory-switch-row"><span>${label}</span><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><span class="toggle-switch-slider"></span></label>`;
    return `${prefix}<form id="tuk-memory-settings-form" class="tuk-memory-form">${formCard(`<h3>向量记忆</h3>${toggle("vectorEnabled", "启用向量索引与语义召回", settings.vectorEnabled)}<label class="tuk-memory-field"><span>向量方式</span><select class="tuk-memory-select" name="vectorProvider"><option value="local-lite" ${settings.vectorProvider === "local-lite" ? "selected" : ""}>本地轻量（无需下载，词字相关）</option><option value="local-neural" ${settings.vectorProvider === "local-neural" ? "selected" : ""}>本地语义模型（首次下载）</option><option value="compatible" ${settings.vectorProvider === "compatible" ? "selected" : ""}>兼容 Embeddings API</option></select></label><label class="tuk-memory-field"><span>模型名</span><input class="tuk-memory-input" name="vectorModel" value="${escapeHtml(settings.vectorModel)}"></label><div class="tuk-memory-form-row"><label class="tuk-memory-field"><span>召回条数</span><input class="tuk-memory-input" type="number" name="vectorTopK" min="1" max="20" value="${settings.vectorTopK}"></label><label class="tuk-memory-field"><span>相似度阈值</span><input class="tuk-memory-input" type="number" name="vectorThreshold" min="-1" max="1" step="0.01" value="${settings.vectorThreshold}"></label></div><label class="tuk-memory-field"><span>注入预算（约 token）</span><input class="tuk-memory-input" type="number" name="vectorTokenBudget" min="200" max="8000" value="${settings.vectorTokenBudget}"></label><label class="tuk-memory-field"><span>Embeddings 接口地址</span><input class="tuk-memory-input" name="vectorEndpoint" value="${escapeHtml(settings.vectorEndpoint)}" placeholder="仅兼容 API 方式需要"></label><label class="tuk-memory-field"><span>Embeddings API Key</span><input class="tuk-memory-input" type="password" name="vectorApiKey" value="${escapeHtml(settings.vectorApiKey)}" autocomplete="off"></label>${toggle("vectorIncludeLinked", "同时召回原“记忆互通”聊天的向量", settings.vectorIncludeLinked)}<p class="tuk-memory-help">本地语义模型运行在浏览器内，首次使用需联网下载模型；失败会明确报错，不会偷偷切换方式。</p>`)}${formCard(`<h3>表格记忆</h3>${toggle("tableEnabled", "启用结构化事实注入", settings.tableEnabled)}${toggle("tableAutoExtract", "自动从新增对话提取事实", settings.tableAutoExtract)}<div class="tuk-memory-form-row"><label class="tuk-memory-field"><span>累计消息数</span><input class="tuk-memory-input" type="number" name="tableExtractCount" min="2" max="100" value="${settings.tableExtractCount}"></label><label class="tuk-memory-field"><span>注入预算（约 token）</span><input class="tuk-memory-input" type="number" name="tableTokenBudget" min="200" max="8000" value="${settings.tableTokenBudget}"></label></div>${toggle("tableIncludeLinked", "同时注入原“记忆互通”聊天的事实", settings.tableIncludeLinked)}<p class="tuk-memory-help">自动提取复用当前主 API。相同“主体 + 属性”的新值会让旧值失效；锁定的事实不会被自动覆盖。</p>`)}<button type="submit" class="tuk-memory-btn">保存设置</button></form>`;
  }

  async function renderRecall(chatId, prefix) {
    const logs = await window.db.memoryRecallLogs.where("chatId").equals(chatId).reverse().sortBy("timestamp");
    const log = logs[0];
    if (!log) return `${prefix}<div class="tuk-memory-empty">还没有召回记录。启用向量或表格记忆并触发一次 AI 回复后，这里会显示实际注入内容。</div>`;
    const recalledFacts = log.factIds?.length ? (await window.db.memoryFacts.bulkGet(log.factIds)).filter(Boolean) : [];
    return `${prefix}${formCard(`<h3>最近一次注入</h3><p class="tuk-memory-help">${new Date(log.timestamp).toLocaleString()} · ${escapeHtml(log.mode)} · 约 ${log.tokenEstimate || 0} token</p>${log.errors?.length ? `<p class="tuk-memory-meta">${escapeHtml(log.errors.join("；"))}</p>` : ""}`)}${recalledFacts.length ? `<article class="tuk-memory-card"><div class="tuk-memory-card-head"><strong>表格事实</strong><span class="tuk-memory-badge">${recalledFacts.length} 条</span></div><p>${recalledFacts.map((fact) => escapeHtml(`${fact.subject}｜${fact.predicate}｜${fact.value}`)).join("\n")}</p></article>` : ""}${log.vectorItems?.length ? log.vectorItems.map((item) => `<article class="tuk-memory-card"><div class="tuk-memory-card-head"><strong>向量召回</strong><span class="tuk-memory-badge">${item.score}</span></div><p>${escapeHtml(item.content)}</p></article>`).join("") : ""}${!recalledFacts.length && !log.vectorItems?.length ? `<div class="tuk-memory-empty">本轮没有达到条件的记忆被注入。${log.errors?.length ? "请查看上方错误提示。" : ""}</div>` : ""}`;
  }

  async function render() {
    const chat = currentChat();
    const content = document.getElementById("tuk-memory-content");
    if (!content) return;
    if (!chat || !databaseReady()) { content.innerHTML = `<div class="tuk-memory-empty">请先打开一个聊天，或等待数据库加载完成。</div>`; return; }
    document.getElementById("tuk-memory-chat-line").textContent = `当前聊天：${chat.name || chat.id}`;
    const settings = await getSettings(chat.id);
    const stats = await counts(chat.id);
    const prefix = statHtml(stats.text, stats.vector, stats.facts);
    if (activeTab === "text") content.innerHTML = await renderText(chat.id, prefix);
    else if (activeTab === "vector") content.innerHTML = await renderVector(chat.id, prefix, settings);
    else if (activeTab === "table") content.innerHTML = await renderTable(chat.id, prefix);
    else if (activeTab === "settings") content.innerHTML = renderSettings(prefix, settings);
    else content.innerHTML = await renderRecall(chat.id, prefix);
  }

  async function open() {
    const modal = document.getElementById("tuk-memory-center-modal");
    if (!modal) return;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    await render();
  }

  function close() {
    const modal = document.getElementById("tuk-memory-center-modal");
    if (!modal) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  function confirmed(button) {
    if (button.dataset.confirming === "true") return true;
    button.dataset.confirming = "true";
    button.dataset.originalText = button.textContent;
    button.textContent = "再次点击确认";
    setTimeout(() => { if (button.isConnected && button.dataset.confirming === "true") { button.textContent = button.dataset.originalText; delete button.dataset.confirming; } }, 2600);
    return false;
  }

  async function handleAction(button) {
    const chat = currentChat();
    if (!chat) return;
    const action = button.dataset.action;
    try {
      if (action === "open-original-summary") {
        close();
        document.getElementById("view-summaries-btn")?.click();
        return;
      }
      if (action === "index-vector") {
        button.disabled = true; toast("正在索引，请稍候…");
        const result = await indexChat(chat.id, { force: true });
        toast(`已索引 ${result.added} 条记忆`);
      } else if (action === "rebuild-vector") {
        if (!confirmed(button)) return;
        button.disabled = true; toast("正在重建索引…");
        const result = await indexChat(chat.id, { force: true, rebuild: true });
        toast(`已重建 ${result.added} 条记忆`);
      } else if (action === "clear-vector") {
        if (!confirmed(button)) return;
        await window.db.memoryVectors.where("chatId").equals(chat.id).delete();
        await saveSettings(chat.id, { lastVectorIndex: -1 }); toast("向量记忆已清空");
      } else if (action === "delete-vector") {
        if (!confirmed(button)) return;
        await window.db.memoryVectors.delete(button.dataset.id); toast("向量片段已删除");
      } else if (action === "delete-fact") {
        if (!confirmed(button)) return;
        await window.db.memoryFacts.delete(button.dataset.id); toast("事实已删除");
      } else if (action === "edit-fact") {
        editingFactId = button.dataset.id;
      } else if (action === "cancel-fact-edit") {
        editingFactId = null;
      } else if (action === "toggle-fact-lock") {
        const fact = await window.db.memoryFacts.get(button.dataset.id);
        await window.db.memoryFacts.update(fact.id, { locked: !fact.locked, updatedAt: Date.now() }); toast(fact.locked ? "事实已解锁" : "事实已锁定");
      } else if (action === "toggle-fact-status") {
        const fact = await window.db.memoryFacts.get(button.dataset.id);
        await window.db.memoryFacts.update(fact.id, { status: fact.status === "active" ? "inactive" : "active", validTo: fact.status === "active" ? Date.now() : null, updatedAt: Date.now() }); toast(fact.status === "active" ? "事实已标为失效" : "事实已恢复");
      }
      await render();
    } catch (error) { console.error(error); toast(error.message || "操作失败"); button.disabled = false; }
  }

  async function deleteChatData(chatId) {
    if (!databaseReady()) return;
    await Promise.all([
      window.db.memoryVectors.where("chatId").equals(chatId).delete(),
      window.db.memoryFacts.where("chatId").equals(chatId).delete(),
      window.db.memoryRecallLogs.where("chatId").equals(chatId).delete(),
      window.db.memorySettings.delete(idFor(chatId)),
    ]);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("open-memory-center-btn")?.addEventListener("click", open);
    document.getElementById("tuk-memory-close-btn")?.addEventListener("click", close);
    document.getElementById("tuk-memory-refresh-btn")?.addEventListener("click", render);
    document.querySelectorAll("[data-memory-tab]").forEach((button) => button.addEventListener("click", async () => {
      activeTab = button.dataset.memoryTab;
      document.querySelectorAll("[data-memory-tab]").forEach((item) => item.classList.toggle("active", item === button));
      await render();
    }));
    document.getElementById("tuk-memory-content")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (button) void handleAction(button);
    });
    document.getElementById("tuk-memory-content")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const chat = currentChat();
      if (!chat) return;
      try {
        if (event.target.id === "tuk-memory-fact-form") {
          const data = new FormData(event.target);
          const value = Object.fromEntries(data.entries());
          if (value.id) {
            const fact = await window.db.memoryFacts.get(value.id);
            const clean = cleanFact(value);
            if (!fact || !clean) throw new Error("事实内容不完整");
            await window.db.memoryFacts.update(value.id, { ...clean, updatedAt: Date.now() });
            editingFactId = null;
            toast("事实已更新");
          } else {
            await upsertFact(chat.id, value, "manual");
            toast("事实已保存");
          }
        } else if (event.target.id === "tuk-memory-settings-form") {
          const data = new FormData(event.target);
          const value = Object.fromEntries(data.entries());
          await saveSettings(chat.id, {
            vectorEnabled: data.has("vectorEnabled"), vectorProvider: value.vectorProvider, vectorModel: value.vectorModel.trim(), vectorEndpoint: value.vectorEndpoint.trim(), vectorApiKey: value.vectorApiKey,
            vectorTopK: Math.max(1, Math.min(20, Number(value.vectorTopK) || 5)), vectorThreshold: Math.max(-1, Math.min(1, Number(value.vectorThreshold) || 0)), vectorTokenBudget: Math.max(200, Math.min(8000, Number(value.vectorTokenBudget) || 700)), vectorIncludeLinked: data.has("vectorIncludeLinked"),
            tableEnabled: data.has("tableEnabled"), tableAutoExtract: data.has("tableAutoExtract"), tableExtractCount: Math.max(2, Math.min(100, Number(value.tableExtractCount) || 12)), tableTokenBudget: Math.max(200, Math.min(8000, Number(value.tableTokenBudget) || 700)), tableIncludeLinked: data.has("tableIncludeLinked"),
          });
          toast("设置已保存");
        }
        await render();
      } catch (error) { console.error(error); toast(error.message || "保存失败"); }
    });
    document.getElementById("tuk-memory-center-modal")?.addEventListener("click", (event) => { if (event.target.id === "tuk-memory-center-modal") close(); });
  });

  window.TukMemory = { open, close, render, processChat, buildContext, indexChat, deleteChatData, getSettings };
})();
