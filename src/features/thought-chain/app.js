(function () {
  "use strict";

  const STORAGE_VERSION = 1;
  const storageRoot = new URL("./", window.location.href);
  const storageKey = `ephone:tuk-phone:${storageRoot.protocol}//${storageRoot.host}${storageRoot.pathname}:thought-chain-settings-v1`;
  const MODES = new Set(["native_off", "card", "hybrid"]);
  const PROVIDERS = new Set(["auto", "gemini", "claude", "deepseek", "openai", "compatible"]);
  const POSITIONS = new Set(["head", "middle", "before_history", "in_chat", "after_history", "tail"]);
  const ROLES = new Set(["system", "user", "assistant"]);
  const PREFILL_STRATEGIES = new Set(["auto", "assistant", "user", "system", "none"]);
  const EFFORTS = new Set(["auto", "minimal", "low", "medium", "high", "max"]);

  const DEFAULT_ITEMS = [
    {
      id: "tc-core-head",
      name: "思维链首部协议",
      position: "head",
      role: "system",
      depth: 0,
      enabled: true,
      core: true,
      content: "在生成最终回复前，先执行以下思考协议。思考必须位于 [incipere] 与 [finire] 之间，并使用 <thinking> 与 </thinking> 包裹。中间的具体检查步骤由用户配置的思维链条目决定。不要把思考内容混入最终正文。\n\n格式：\n[incipere]\n<thinking>\n...思考过程...\n</thinking>\n[finire]",
    },
    {
      id: "tc-core-tail",
      name: "思维链末尾触发器",
      position: "tail",
      role: "assistant",
      depth: 0,
      enabled: true,
      core: true,
      content: "[incipere]\n<thinking>\n",
    },
  ];

  const DEFAULT_CONFIG = {
    version: STORAGE_VERSION,
    enabled: false,
    mode: "card",
    provider: "auto",
    nativeEffort: "auto",
    prefillStrategy: "auto",
    scopes: { chat: true, offline: true },
    extraction: {
      enabled: true,
      startMarker: "<thinking>",
      endMarker: "</thinking>",
      ignoreCase: true,
      allowMissingStart: true,
      extractAll: false,
      removeFromBody: true,
    },
    extraBodyJson: "",
    items: DEFAULT_ITEMS,
    presets: [],
    activePresetId: "builtin-default",
  };

  let config = normalizeConfig(loadStored());
  let activeView = "config";
  let editingItemId = null;
  let toastTimer = null;
  let lastCapture = null;

  const $ = (id) => document.getElementById(id);
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  const esc = (value) => {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  };
  const attr = (value) => esc(value).replace(/`/g, "&#96;");
  const checked = (value) => (value ? " checked" : "");
  const selected = (value, expected) => (value === expected ? " selected" : "");

  function normalizeItem(item, index) {
    const source = item && typeof item === "object" ? item : {};
    return {
      id: String(source.id || `tc-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`),
      name: String(source.name || `未命名条目 ${index + 1}`).slice(0, 80),
      position: POSITIONS.has(source.position) ? source.position : "middle",
      role: ROLES.has(source.role) ? source.role : "system",
      depth: Math.max(0, Math.min(999, Number.parseInt(source.depth, 10) || 0)),
      enabled: source.enabled !== false,
      core: source.core === true,
      content: typeof source.content === "string" ? source.content : "",
    };
  }

  function normalizeConfig(input) {
    const source = input && typeof input === "object" ? input : {};
    const extractionSource = source.extraction || source.behavior;
    const extraction = extractionSource && typeof extractionSource === "object" ? extractionSource : {};
    const scopes = source.scopes && typeof source.scopes === "object" ? source.scopes : {};
    const normalized = {
      version: STORAGE_VERSION,
      enabled: source.enabled === true,
      mode: MODES.has(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
      provider: PROVIDERS.has(source.provider) ? source.provider : DEFAULT_CONFIG.provider,
      nativeEffort: EFFORTS.has(source.nativeEffort) ? source.nativeEffort : DEFAULT_CONFIG.nativeEffort,
      prefillStrategy: PREFILL_STRATEGIES.has(source.prefillStrategy) ? source.prefillStrategy : DEFAULT_CONFIG.prefillStrategy,
      scopes: {
        chat: scopes.chat !== false,
        offline: scopes.offline !== false,
      },
      extraction: {
        enabled: extraction.enabled !== false,
        startMarker: typeof extraction.startMarker === "string" ? extraction.startMarker : DEFAULT_CONFIG.extraction.startMarker,
        endMarker: typeof extraction.endMarker === "string" ? extraction.endMarker : DEFAULT_CONFIG.extraction.endMarker,
        ignoreCase: extraction.ignoreCase !== false,
        allowMissingStart: extraction.allowMissingStart !== false,
        extractAll: extraction.extractAll === true,
        removeFromBody: extraction.removeFromBody !== false,
      },
      extraBodyJson: typeof source.extraBodyJson === "string" ? source.extraBodyJson : "",
      items: Array.isArray(source.items) ? source.items.map(normalizeItem) : clone(DEFAULT_ITEMS),
      presets: Array.isArray(source.presets)
        ? source.presets.filter((item) => item && typeof item === "object").map((preset, index) => ({
            id: String(preset.id || `tc-preset-${Date.now()}-${index}`),
            name: String(preset.name || `预设 ${index + 1}`).slice(0, 80),
            createdAt: Number(preset.createdAt) || Date.now(),
            snapshot: normalizePresetSnapshot(preset.snapshot),
          }))
        : [],
      activePresetId: typeof source.activePresetId === "string" ? source.activePresetId : "builtin-default",
    };
    if (!normalized.items.length) normalized.items = clone(DEFAULT_ITEMS);
    return normalized;
  }

  function normalizePresetSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === "object" ? snapshot : {};
    return {
      mode: MODES.has(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
      provider: PROVIDERS.has(source.provider) ? source.provider : DEFAULT_CONFIG.provider,
      nativeEffort: EFFORTS.has(source.nativeEffort) ? source.nativeEffort : DEFAULT_CONFIG.nativeEffort,
      prefillStrategy: PREFILL_STRATEGIES.has(source.prefillStrategy) ? source.prefillStrategy : DEFAULT_CONFIG.prefillStrategy,
      scopes: {
        chat: source.scopes?.chat !== false,
        offline: source.scopes?.offline !== false,
      },
      extraction: normalizeConfig({ extraction: source.extraction }).extraction,
      extraBodyJson: typeof source.extraBodyJson === "string" ? source.extraBodyJson : "",
      items: Array.isArray(source.items) ? source.items.map(normalizeItem) : clone(DEFAULT_ITEMS),
    };
  }

  function currentSnapshot() {
    return clone({
      mode: config.mode,
      provider: config.provider,
      nativeEffort: config.nativeEffort,
      prefillStrategy: config.prefillStrategy,
      scopes: config.scopes,
      extraction: config.extraction,
      extraBodyJson: config.extraBodyJson,
      items: config.items,
    });
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn("[思维链] 读取设置失败，已使用默认配置。", error);
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(config));
    } catch (error) {
      console.error("[思维链] 保存设置失败。", error);
      toast("设置保存失败，请检查浏览器存储空间");
      return false;
    }
    return true;
  }

  function toast(message) {
    const element = $("tc-toast");
    if (!element) return;
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("visible"), 2200);
  }

  function providerLabel(provider) {
    return { gemini: "Gemini", claude: "Claude", deepseek: "DeepSeek", openai: "OpenAI", compatible: "兼容接口" }[provider] || "自动识别";
  }

  function detectProvider(proxyUrl, model) {
    if (config.provider !== "auto") return config.provider;
    const url = String(proxyUrl || "").toLowerCase();
    const name = String(model || "").toLowerCase();
    if (url.includes("generativelanguage.googleapis.com") || name.includes("gemini")) return "gemini";
    if (url.includes("anthropic.com") || name.includes("claude")) return "claude";
    if (url.includes("deepseek.com") || name.includes("deepseek")) return "deepseek";
    if (url.includes("openai.com") || /^(gpt-|o[134](?:-|$))/.test(name)) return "openai";
    return "compatible";
  }

  function isLatestClaudeWithoutPrefill(model) {
    const name = String(model || "").toLowerCase();
    if (/claude-(?:opus|sonnet|fable|mythos)-5/.test(name)) return true;
    const match = /claude-(?:opus|sonnet)-4[-_.]?([0-9]+)/.exec(name);
    return Boolean(match && Number(match[1]) >= 6);
  }

  function isGeminiWithoutReliablePrefill(model) {
    const match = /gemini-3\.(\d+)/i.exec(String(model || ""));
    return Boolean(match && Number(match[1]) >= 6);
  }

  function isOpenAIReasoningModel(model) {
    return /^(?:gpt-5|o[134](?:-|$))/i.test(String(model || ""));
  }

  function geminiSupportsMinimal(model) {
    return /^gemini-3(?:-flash(?:-|$)|\.(?:5|6)-flash(?:-|$)|\.(?:1|5)-flash-lite(?:-|$))/i.test(String(model || ""));
  }

  function resolvePrefillStrategy(provider, model, proxyUrl) {
    if (config.prefillStrategy !== "auto") return config.prefillStrategy;
    if (provider === "claude" && isLatestClaudeWithoutPrefill(model)) return "system";
    if (provider === "gemini" && isGeminiWithoutReliablePrefill(model)) return "system";
    if (provider === "openai" && isOpenAIReasoningModel(model)) return "system";
    if (provider === "deepseek" && /api\.deepseek\.com/i.test(String(proxyUrl || "")) && !/\/beta(?:\/|$)/i.test(String(proxyUrl || ""))) return "system";
    return "assistant";
  }

  function expandMacros(value, context) {
    const now = new Date();
    const replacements = {
      model: context.model || "",
      provider: context.provider || "compatible",
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString(),
      mode: config.mode,
    };
    return String(value || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match,
    );
  }

  function injectItems(systemPrompt, messages, context) {
    let nextSystemPrompt = String(systemPrompt || "");
    let nextMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
    const enabledItems = config.items.filter((item) => item.enabled && item.content.trim());
    const byPosition = (position) => enabledItems.filter((item) => item.position === position);
    const asMessage = (item) => ({ role: item.role, content: expandMacros(item.content, context) });

    const headMessages = [];
    byPosition("head").forEach((item) => {
      const content = expandMacros(item.content, context);
      if (item.role === "system") nextSystemPrompt = `${content}\n\n${nextSystemPrompt}`.trim();
      else headMessages.push({ role: item.role, content });
    });
    byPosition("middle").forEach((item) => {
      const content = expandMacros(item.content, context);
      if (item.role === "system") nextSystemPrompt = `${nextSystemPrompt}\n\n${content}`.trim();
      else headMessages.push({ role: item.role, content });
    });

    nextMessages = [...headMessages, ...byPosition("before_history").map(asMessage), ...nextMessages];
    const inChatAnchors = [];
    byPosition("in_chat").forEach((item) => {
      const depth = Math.max(0, Math.min(nextMessages.length, item.depth || 0));
      const baseIndex = Math.max(0, nextMessages.length - depth);
      const offset = inChatAnchors.filter((anchor) => anchor <= baseIndex).length;
      nextMessages.splice(baseIndex + offset, 0, asMessage(item));
      inChatAnchors.push(baseIndex);
    });
    nextMessages.push(...byPosition("after_history").map(asMessage));

    const strategy = resolvePrefillStrategy(context.provider, context.model, context.proxyUrl);
    const tailItems = byPosition("tail");
    if (strategy === "assistant" || strategy === "user") {
      tailItems.forEach((item) => {
        const message = { role: strategy, content: expandMacros(item.content, context) };
        if (strategy === "assistant" && context.provider === "deepseek") message.prefix = true;
        nextMessages.push(message);
      });
    } else if (strategy === "system") {
      const tailText = tailItems.map((item) => expandMacros(item.content, context)).join("\n").trim();
      if (tailText) {
        nextSystemPrompt = `${nextSystemPrompt}\n\n# 响应起始协议\n请从下列起始内容继续生成，并严格执行上方思维协议：\n${tailText}`.trim();
      }
    }
    return { systemPrompt: nextSystemPrompt, messages: nextMessages, prefillStrategy: strategy };
  }

  function parseExtraBody() {
    const raw = String(config.extraBodyJson || "").trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn("[思维链] 额外请求参数不是有效 JSON，本次未应用。", error);
      return {};
    }
  }

  function nativeControl(provider, model) {
    const shouldDisable = config.mode === "native_off" || config.mode === "card";
    const effort = config.nativeEffort;
    const control = { openAI: {}, gemini: null, supported: true, note: "" };

    if (provider === "gemini") {
      if (shouldDisable) {
        if (/^gemini-3/i.test(model)) {
          const supportsMinimal = geminiSupportsMinimal(model);
          const minimumLevel = supportsMinimal ? "minimal" : "low";
          control.gemini = { thinkingLevel: minimumLevel };
          control.note = `该 Gemini 型号不能彻底关闭，已请求其最低可用级别 ${minimumLevel}`;
        } else {
          control.gemini = { thinkingBudget: 0 };
          control.note = "已请求关闭原生思考";
        }
      } else if (effort !== "auto") {
        const supportsMinimal = geminiSupportsMinimal(model);
        control.gemini = /^gemini-3/i.test(model)
          ? { thinkingLevel: effort === "max" ? "high" : effort === "minimal" && !supportsMinimal ? "low" : effort }
          : { thinkingBudget: { minimal: 0, low: 1024, medium: 4096, high: 8192, max: 16384 }[effort] };
        control.note = `原生思考强度：${effort}`;
      }
      return control;
    }

    if (shouldDisable) {
      if (provider === "deepseek") {
        control.openAI = { thinking: { type: "disabled" } };
        control.note = "已请求关闭 DeepSeek 原生思考";
      } else if (provider === "openai") {
        const name = String(model || "").toLowerCase();
        if (/^gpt-5-pro(?:-|$)/.test(name)) {
          control.supported = false;
          control.note = "该 OpenAI Pro 型号不支持关闭原生推理，未添加不兼容参数";
        } else if (/^gpt-5\.(?:[1-9]|\d{2,})(?:-|$)/.test(name)) {
          control.openAI = { reasoning_effort: "none" };
          control.note = "已请求关闭 OpenAI 原生推理";
        } else if (/^gpt-5(?:-|$)/.test(name)) {
          control.openAI = { reasoning_effort: "minimal" };
          control.note = "该 OpenAI 型号不支持 none，已请求最低可用级别 minimal";
        } else if (/^o[134](?:-|$)/.test(name)) {
          control.openAI = { reasoning_effort: "low" };
          control.note = "该 OpenAI o 系列不支持关闭，已请求最低可用级别 low";
        } else {
          control.note = "当前 OpenAI 型号没有可关闭的原生推理参数";
        }
      } else if (provider === "claude") {
        control.openAI = { thinking: { type: "disabled" }, reasoning_effort: "none" };
        control.note = "已向兼容接口请求关闭 Claude 原生思考";
      } else {
        control.supported = false;
        control.note = "接口类型未知，无法安全添加关闭原生思考参数";
      }
    } else if (effort !== "auto") {
      if (provider === "deepseek") control.openAI = { thinking: { type: "enabled" }, reasoning_effort: effort === "minimal" ? "low" : effort };
      else if (provider === "openai") control.openAI = { reasoning_effort: effort };
      else if (provider === "claude") control.openAI = { thinking: { type: "adaptive" }, reasoning_effort: effort };
      else control.supported = false;
      control.note = control.supported ? `原生思考强度：${effort}` : "接口类型未知，未添加强度参数";
    } else {
      control.note = "保留接口的原生思考默认值";
    }
    return control;
  }

  function prepareRequest(options) {
    const input = options && typeof options === "object" ? options : {};
    const scope = input.scope === "offline" ? "offline" : "chat";
    const original = {
      systemPrompt: String(input.systemPrompt || ""),
      messages: Array.isArray(input.messages) ? input.messages.map((message) => ({ ...message })) : [],
    };
    if (!config.enabled || config.scopes[scope] === false) {
      return { ...original, active: false, mode: null, provider: null, openAIOptions: {}, geminiThinkingConfig: null, diagnostics: "保持项目原始行为" };
    }

    const provider = detectProvider(input.proxyUrl, input.model);
    const context = { provider, model: String(input.model || ""), proxyUrl: String(input.proxyUrl || "") };
    let prepared = original;
    let prefillStrategy = "none";
    if (config.mode === "card" || config.mode === "hybrid") {
      prepared = injectItems(original.systemPrompt, original.messages, context);
      prefillStrategy = prepared.prefillStrategy;
    }
    const control = nativeControl(provider, context.model);
    const openAIOptions = { ...control.openAI, ...parseExtraBody() };
    const strategyNote = (config.mode === "card" || config.mode === "hybrid")
      ? `；自定义注入使用${{ assistant: "末尾 assistant 预填", user: "末尾 user 触发", system: "系统指令兼容策略", none: "无末尾触发" }[prefillStrategy]}`
      : "";
    return {
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      active: true,
      mode: config.mode,
      provider,
      openAIOptions,
      geminiThinkingConfig: control.gemini,
      nativeControlSupported: control.supported,
      prefillStrategy,
      diagnostics: `${providerLabel(provider)}：${control.note}${strategyNote}`,
    };
  }

  function applyGeminiConfig(geminiConfig, prepared) {
    if (!geminiConfig || !prepared?.active || !prepared.geminiThinkingConfig) return geminiConfig;
    try {
      const body = JSON.parse(geminiConfig.data.body);
      body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: prepared.geminiThinkingConfig };
      geminiConfig.data.body = JSON.stringify(body);
    } catch (error) {
      console.warn("[思维链] Gemini 思考参数合并失败，本次保留原请求。", error);
    }
    return geminiConfig;
  }

  function extractTaggedReasoning(rawText) {
    const raw = String(rawText || "");
    const settings = config.extraction;
    if (!settings.enabled || !raw || !settings.endMarker) return { text: raw, reasoning: "", count: 0 };
    const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const comparisonRaw = settings.ignoreCase ? raw.toLowerCase() : raw;
    const comparisonStart = settings.ignoreCase ? settings.startMarker.toLowerCase() : settings.startMarker;
    const hasStart = Boolean(settings.startMarker && comparisonRaw.includes(comparisonStart));
    let source;
    if (hasStart) source = `${escapeRegex(settings.startMarker)}([\\s\\S]*?)${escapeRegex(settings.endMarker)}`;
    else if (settings.allowMissingStart) source = `^([\\s\\S]*?)${escapeRegex(settings.endMarker)}`;
    else return { text: raw, reasoning: "", count: 0 };
    const flags = `${settings.ignoreCase ? "i" : ""}${settings.extractAll ? "g" : ""}`;
    try {
      const regex = new RegExp(source, flags);
      const matches = [];
      if (settings.extractAll) {
        let match;
        while ((match = regex.exec(raw)) !== null) {
          matches.push({ full: match[0], content: String(match[1] ?? "").trim() });
          if (!match[0]) regex.lastIndex += 1;
        }
      } else {
        const match = regex.exec(raw);
        if (match) matches.push({ full: match[0], content: String(match[1] ?? "").trim() });
      }
      let text = raw;
      if (settings.removeFromBody) matches.forEach((match) => { text = text.replace(match.full, ""); });
      text = text.replace(/^\s*\[finire\]\s*/i, "").trim();
      return { text, reasoning: matches.map((match) => match.content).filter(Boolean).join("\n\n"), count: matches.length };
    } catch (error) {
      console.warn("[思维链] 提取规则执行失败，已保留原始回复。", error);
      return { text: raw, reasoning: "", count: 0 };
    }
  }

  function extractNativeReasoning(data, provider) {
    if (!data || typeof data !== "object") return "";
    const message = data?.choices?.[0]?.message;
    if (message?.reasoning_content) return String(message.reasoning_content);
    if (typeof message?.reasoning === "string") return message.reasoning;
    const geminiParts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(geminiParts)) {
      const text = geminiParts.filter((part) => part && (part.thought === true || part.thoughtSummary === true) && typeof part.text === "string").map((part) => part.text).join("\n");
      if (text) return text;
    }
    if (Array.isArray(data.content)) {
      const text = data.content.filter((block) => block?.type === "thinking" && typeof block.thinking === "string").map((block) => block.thinking).join("\n");
      if (text) return text;
    }
    if (Array.isArray(data.output)) {
      return data.output.filter((item) => item?.type === "reasoning").flatMap((item) => item.content || []).map((part) => part?.text || "").filter(Boolean).join("\n");
    }
    return "";
  }

  function processResponse(options) {
    const input = options && typeof options === "object" ? options : { text: options };
    const rawText = String(input.text || "");
    if (!config.enabled) return { text: rawText, reasoning: "", source: "none" };
    const provider = input.provider || detectProvider(input.proxyUrl, input.model);
    const nativeReasoning = extractNativeReasoning(input.data, provider);
    const tagged = extractTaggedReasoning(rawText);
    const reasoning = [nativeReasoning, tagged.reasoning].filter(Boolean).join("\n\n");
    const source = nativeReasoning && tagged.reasoning ? "mixed" : nativeReasoning ? "native" : tagged.reasoning ? "prompt" : "none";
    lastCapture = {
      at: Date.now(),
      provider,
      model: String(input.model || ""),
      source,
      reasoning,
      rawLength: rawText.length,
      bodyLength: tagged.text.length,
    };
    if (activeView === "tools" && $("tc-main-content")) render();
    return { text: tagged.text, reasoning, source };
  }

  function modeName(mode) {
    return { native_off: "关闭原生思考", card: "卡 COT", hybrid: "混合模式" }[mode] || mode;
  }

  function updateHeader() {
    const title = $("tc-overview-title");
    const detail = $("tc-overview-detail");
    const master = $("tc-master-switch");
    const picker = $("tc-mode-picker");
    if (!title || !detail || !master || !picker) return;
    master.checked = config.enabled;
    picker.classList.toggle("disabled", !config.enabled);
    picker.querySelectorAll("[data-tc-mode]").forEach((button) => button.classList.toggle("active", button.dataset.tcMode === config.mode));
    title.textContent = config.enabled ? modeName(config.mode) : "思维链已关闭";
    detail.textContent = config.enabled ? `${config.items.filter((item) => item.enabled).length} 个条目启用 · ${providerLabel(detectProvider(window.state?.apiConfig?.proxyUrl, window.state?.apiConfig?.model))}` : "请求保持当前项目的原始行为";
  }

  function toggleRow(field, title, note, value) {
    return `<div class="tc-setting-row"><div class="tc-setting-copy"><strong>${esc(title)}</strong><span>${esc(note)}</span></div><label class="tc-toggle"><input type="checkbox" data-tc-field="${attr(field)}"${checked(value)}><span></span></label></div>`;
  }

  function renderConfig() {
    const provider = detectProvider(window.state?.apiConfig?.proxyUrl, window.state?.apiConfig?.model);
    const preview = prepareRequest({
      systemPrompt: "",
      messages: [],
      proxyUrl: window.state?.apiConfig?.proxyUrl,
      model: window.state?.apiConfig?.model,
      scope: "chat",
    });
    return `<section class="tc-setting-card">
      <div class="tc-field"><label for="tc-provider-select">接口类型</label><select id="tc-provider-select" class="tc-select" data-tc-field="provider">
        <option value="auto"${selected(config.provider, "auto")}>自动识别（当前：${esc(providerLabel(provider))}）</option>
        <option value="gemini"${selected(config.provider, "gemini")}>Gemini</option>
        <option value="claude"${selected(config.provider, "claude")}>Claude / Anthropic 兼容</option>
        <option value="deepseek"${selected(config.provider, "deepseek")}>DeepSeek</option>
        <option value="openai"${selected(config.provider, "openai")}>OpenAI</option>
        <option value="compatible"${selected(config.provider, "compatible")}>其他兼容接口</option>
      </select><div class="tc-field-note">自动识别依据 API 地址与模型名；套壳或自定义模型可手动指定。</div></div>
      <div class="tc-inline-fields">
        <div class="tc-field"><label for="tc-effort-select">原生思考强度</label><select id="tc-effort-select" class="tc-select" data-tc-field="nativeEffort">
          ${["auto", "minimal", "low", "medium", "high", "max"].map((value) => `<option value="${value}"${selected(config.nativeEffort, value)}>${value === "auto" ? "接口默认" : value}</option>`).join("")}
        </select></div>
        <div class="tc-field"><label for="tc-prefill-select">末尾触发策略</label><select id="tc-prefill-select" class="tc-select" data-tc-field="prefillStrategy">
          <option value="auto"${selected(config.prefillStrategy, "auto")}>自动兼容</option>
          <option value="assistant"${selected(config.prefillStrategy, "assistant")}>Assistant 预填</option>
          <option value="user"${selected(config.prefillStrategy, "user")}>User 触发</option>
          <option value="system"${selected(config.prefillStrategy, "system")}>System 末端指令</option>
          <option value="none"${selected(config.prefillStrategy, "none")}>不发送末尾触发</option>
        </select></div>
      </div>
      <div class="tc-status-line">${esc(preview.diagnostics)}</div>
    </section>
    <div class="tc-section-title">生效范围</div>
    <section class="tc-setting-card">
      ${toggleRow("scopes.chat", "普通聊天与群聊", "包含主聊天回复和 MCP 工具轮次", config.scopes.chat)}
      ${toggleRow("scopes.offline", "线下模式", "角色开启线下模式时也使用当前配置", config.scopes.offline)}
    </section>
    <div class="tc-section-title">回复提取</div>
    <section class="tc-setting-card">
      ${toggleRow("extraction.enabled", "提取自定义思考", "从模型正文中识别思考标签", config.extraction.enabled)}
      ${toggleRow("extraction.removeFromBody", "从正文移除", "避免思考标签破坏聊天 JSON 与可见正文", config.extraction.removeFromBody)}
      ${toggleRow("extraction.allowMissingStart", "兼容缺少开头标签", "如果只有结束标签，从回复开头提取", config.extraction.allowMissingStart)}
      ${toggleRow("extraction.extractAll", "提取全部思考块", "关闭时只处理第一个完整块", config.extraction.extractAll)}
      <div class="tc-inline-fields" style="margin-top:10px">
        <div class="tc-field"><label for="tc-start-marker">开始标记</label><input id="tc-start-marker" class="tc-input" data-tc-field="extraction.startMarker" value="${attr(config.extraction.startMarker)}"></div>
        <div class="tc-field"><label for="tc-end-marker">结束标记</label><input id="tc-end-marker" class="tc-input" data-tc-field="extraction.endMarker" value="${attr(config.extraction.endMarker)}"></div>
      </div>
    </section>
    <div class="tc-section-title">高级请求参数</div>
    <section class="tc-setting-card"><div class="tc-field"><label for="tc-extra-body">额外请求体字段（JSON 对象）</label><textarea id="tc-extra-body" class="tc-textarea" data-tc-field="extraBodyJson" spellcheck="false" placeholder='例如：{"reasoning_effort":"high"}'>${esc(config.extraBodyJson)}</textarea><div class="tc-field-note">仅在总开关开启时合并到 OpenAI 兼容请求；同名字段会覆盖内置值。无效 JSON 不会发送。</div></div></section>`;
  }

  function itemPositionName(position) {
    return { head: "提示词首部", middle: "提示词尾部", before_history: "聊天记录之前", in_chat: "聊天记录内部", after_history: "聊天记录之后", tail: "最终预填" }[position] || position;
  }

  function renderItems() {
    const cards = config.items.map((item, index) => `<article class="tc-card">
      <div class="tc-card-head"><label class="tc-toggle"><input type="checkbox" data-tc-item-toggle="${attr(item.id)}"${checked(item.enabled)}><span></span></label><div class="tc-card-main"><strong>${esc(item.name)}</strong><span>${esc(itemPositionName(item.position))} · ${esc(item.role)}${item.position === "in_chat" ? ` · depth ${item.depth}` : ""}${item.core ? " · 核心" : ""}</span></div></div>
      <div class="tc-item-preview">${esc(item.content || "（空条目）")}</div>
      <div class="tc-card-actions">
        <button type="button" class="tc-small-button" data-tc-action="edit-item" data-id="${attr(item.id)}">编辑</button>
        <button type="button" class="tc-small-button" data-tc-action="copy-item" data-id="${attr(item.id)}">复制</button>
        <button type="button" class="tc-small-button" data-tc-action="move-up" data-id="${attr(item.id)}"${index === 0 ? " disabled" : ""}>上移</button>
        <button type="button" class="tc-small-button" data-tc-action="move-down" data-id="${attr(item.id)}"${index === config.items.length - 1 ? " disabled" : ""}>下移</button>
        <button type="button" class="tc-small-button" data-tc-action="delete-item" data-id="${attr(item.id)}">删除</button>
      </div>
    </article>`).join("");
    return `${cards || `<div class="tc-empty"><strong>暂无思维链条目</strong>新增首部、步骤或末尾触发器。</div>`}<button type="button" class="tc-primary-button" data-tc-action="add-item">新增条目</button>`;
  }

  function renderPresets() {
    const builtIn = `<article class="tc-card"><div class="tc-card-head"><div class="tc-card-main"><strong>内置首尾模板</strong><span>仅包含首部协议和末尾触发器</span></div></div><div class="tc-card-actions"><button type="button" class="tc-small-button" data-tc-action="load-builtin">载入</button></div></article>`;
    const custom = config.presets.map((preset) => `<article class="tc-card"><div class="tc-card-head"><div class="tc-card-main"><strong>${esc(preset.name)}</strong><span>${new Date(preset.createdAt).toLocaleString()} · ${preset.snapshot.items.filter((item) => item.enabled).length} 个启用条目</span></div></div><div class="tc-card-actions"><button type="button" class="tc-small-button" data-tc-action="load-preset" data-id="${attr(preset.id)}">载入</button><button type="button" class="tc-small-button" data-tc-action="rename-preset" data-id="${attr(preset.id)}">重命名</button><button type="button" class="tc-small-button" data-tc-action="delete-preset" data-id="${attr(preset.id)}">删除</button></div></article>`).join("");
    return `<section class="tc-setting-card"><div class="tc-setting-copy"><strong>当前配置</strong><span>保存为独立预设，方便按模型或用途切换。</span></div><div class="tc-card-actions"><button type="button" class="tc-primary-button" data-tc-action="save-preset">另存为预设</button><button type="button" class="tc-small-button" data-tc-action="export">导出全部</button></div></section>${builtIn}${custom || ""}`;
  }

  function renderTools() {
    const provider = detectProvider(window.state?.apiConfig?.proxyUrl, window.state?.apiConfig?.model);
    const prepared = prepareRequest({
      systemPrompt: "（这里是项目原有系统提示词）",
      messages: [{ role: "user", content: "（这里是最近一条用户消息）" }],
      proxyUrl: window.state?.apiConfig?.proxyUrl,
      model: window.state?.apiConfig?.model,
      scope: "chat",
    });
    const preview = {
      enabled: config.enabled,
      mode: config.enabled ? config.mode : "off",
      provider,
      diagnostics: prepared.diagnostics,
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      openAIOptions: prepared.openAIOptions,
      geminiThinkingConfig: prepared.geminiThinkingConfig,
    };
    const captureHtml = lastCapture
      ? `<pre class="tc-code">${esc(JSON.stringify({ ...lastCapture, reasoning: lastCapture.reasoning || "（未提取到思考内容）" }, null, 2))}</pre>`
      : `<div class="tc-field-note">本次打开页面后还没有捕获模型回复。内容只保存在内存中，刷新后自动清除。</div>`;
    return `<section class="tc-setting-card"><div class="tc-setting-copy"><strong>最终注入预览</strong><span>使用当前 API 与模型配置模拟，不会调用模型。</span></div><pre class="tc-code">${esc(JSON.stringify(preview, null, 2))}</pre></section>
      <section class="tc-setting-card"><div class="tc-field"><label for="tc-parser-input">思考提取测试</label><textarea id="tc-parser-input" class="tc-textarea" placeholder="粘贴包含思考标签的模拟回复"></textarea></div><button type="button" class="tc-primary-button" data-tc-action="test-parser">运行测试</button><pre id="tc-parser-output" class="tc-code" hidden></pre></section>
      <section class="tc-setting-card"><div class="tc-setting-copy"><strong>最近一次捕获</strong><span>用于检查原生或自定义思考是否被正确识别。</span></div>${captureHtml}</section>`;
  }

  function render() {
    updateHeader();
    document.querySelectorAll("[data-tc-view]").forEach((button) => button.classList.toggle("active", button.dataset.tcView === activeView));
    const host = $("tc-main-content");
    if (!host) return;
    host.innerHTML = activeView === "config" ? renderConfig() : activeView === "items" ? renderItems() : activeView === "presets" ? renderPresets() : renderTools();
  }

  function showSheet(title, html, actions) {
    $("tc-sheet-title").textContent = title;
    $("tc-sheet-body").innerHTML = html;
    const actionHost = $("tc-sheet-actions");
    actionHost.innerHTML = "";
    (actions || []).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger ? "tc-danger-button" : action.primary ? "tc-primary-button" : "tc-secondary-button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        try {
          const shouldClose = action.run ? action.run() !== false : true;
          if (shouldClose && action.close !== false) closeSheet();
        } catch (error) {
          toast(error?.message || String(error));
        }
      });
      actionHost.appendChild(button);
    });
    const backdrop = $("tc-sheet-backdrop");
    backdrop.classList.add("visible");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeSheet() {
    const backdrop = $("tc-sheet-backdrop");
    if (!backdrop) return;
    backdrop.classList.remove("visible");
    backdrop.setAttribute("aria-hidden", "true");
    editingItemId = null;
  }

  function itemEditor(item) {
    const source = item || normalizeItem({ name: "新思维步骤", position: "middle", role: "system", content: "", enabled: true }, config.items.length);
    editingItemId = item?.id || null;
    const html = `<div class="tc-field"><label for="tc-item-name">名称</label><input id="tc-item-name" class="tc-input" maxlength="80" value="${attr(source.name)}"></div>
      <div class="tc-inline-fields"><div class="tc-field"><label for="tc-item-position">注入位置</label><select id="tc-item-position" class="tc-select">${["head", "middle", "before_history", "in_chat", "after_history", "tail"].map((value) => `<option value="${value}"${selected(source.position, value)}>${itemPositionName(value)}</option>`).join("")}</select></div>
      <div class="tc-field"><label for="tc-item-role">消息角色</label><select id="tc-item-role" class="tc-select">${["system", "user", "assistant"].map((value) => `<option value="${value}"${selected(source.role, value)}>${value}</option>`).join("")}</select></div></div>
      <div class="tc-field"><label for="tc-item-depth">聊天内深度</label><input id="tc-item-depth" class="tc-input" type="number" min="0" max="999" value="${source.depth}"><div class="tc-field-note">只在“聊天记录内部”位置生效；0 表示最后一条之后。</div></div>
      <div class="tc-field"><label for="tc-item-content">内容</label><textarea id="tc-item-content" class="tc-textarea" spellcheck="false">${esc(source.content)}</textarea><div class="tc-field-note">支持 {{model}}、{{provider}}、{{date}}、{{time}}、{{mode}}。</div></div>`;
    showSheet(item ? "编辑思维链条目" : "新增思维链条目", html, [
      { label: "取消" },
      { label: "保存", primary: true, run: () => {
          const updated = normalizeItem({
            ...source,
            id: editingItemId || source.id,
            name: $("tc-item-name").value.trim(),
            position: $("tc-item-position").value,
            role: $("tc-item-role").value,
            depth: $("tc-item-depth").value,
            content: $("tc-item-content").value,
          }, config.items.length);
          if (!updated.name || !updated.content.trim()) { toast("名称和内容不能为空"); return false; }
          const index = config.items.findIndex((entry) => entry.id === editingItemId);
          if (index >= 0) config.items[index] = updated;
          else config.items.push(updated);
          config.activePresetId = "current";
          save(); render(); toast("条目已保存");
        } },
    ]);
  }

  function textPrompt(title, label, initialValue, onSave) {
    showSheet(title, `<div class="tc-field"><label for="tc-prompt-input">${esc(label)}</label><input id="tc-prompt-input" class="tc-input" maxlength="80" value="${attr(initialValue || "")}"></div>`, [
      { label: "取消" },
      { label: "保存", primary: true, run: () => {
          const value = $("tc-prompt-input").value.trim();
          if (!value) { toast("名称不能为空"); return false; }
          onSave(value);
          save(); render();
        } },
    ]);
  }

  function confirmAction(title, message, actionLabel, onAccept) {
    showSheet(title, `<div class="tc-setting-card"><div class="tc-setting-copy"><strong>${esc(message)}</strong><span>此操作只影响思维链配置，不会修改聊天记录。</span></div></div>`, [
      { label: "取消" },
      { label: actionLabel, danger: true, run: () => { onAccept(); save(); render(); } },
    ]);
  }

  function loadSnapshot(snapshot, activePresetId) {
    const normalized = normalizePresetSnapshot(snapshot);
    Object.assign(config, normalized, { activePresetId });
    save(); render(); toast("预设已载入");
  }

  function exportConfig() {
    const payload = { format: "tuk-phone-thought-chain", version: STORAGE_VERSION, exportedAt: new Date().toISOString(), config: clone(config) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `思维链配置_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast("配置已导出");
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || ""));
        const imported = payload?.format === "tuk-phone-thought-chain" ? payload.config : payload;
        const normalized = normalizeConfig(imported);
        showSheet("导入思维链配置", `<div class="tc-setting-card"><div class="tc-setting-copy"><strong>确认覆盖当前思维链配置？</strong><span>将导入 ${normalized.items.length} 个条目和 ${normalized.presets.length} 个自定义预设。聊天、API 与其他设置不会受影响。</span></div></div>`, [
          { label: "取消" },
          { label: "确认导入", primary: true, run: () => { config = normalized; save(); render(); toast("配置已导入"); } },
        ]);
      } catch (error) {
        toast("导入失败：文件格式不正确");
      }
    };
    reader.onerror = () => toast("导入失败：无法读取文件");
    reader.readAsText(file);
  }

  function setNestedField(path, value) {
    const keys = path.split(".");
    let target = config;
    while (keys.length > 1) target = target[keys.shift()];
    target[keys[0]] = value;
    config.activePresetId = "current";
    save();
  }

  function handleContentClick(event) {
    const actionElement = event.target.closest("[data-tc-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.tcAction;
    const id = actionElement.dataset.id;
    const index = config.items.findIndex((item) => item.id === id);
    if (action === "add-item") itemEditor(null);
    else if (action === "edit-item" && index >= 0) itemEditor(config.items[index]);
    else if (action === "copy-item" && index >= 0) {
      const copy = normalizeItem({ ...clone(config.items[index]), id: "", name: `${config.items[index].name} 副本`, core: false }, config.items.length);
      config.items.splice(index + 1, 0, copy); config.activePresetId = "current"; save(); render(); toast("条目已复制");
    } else if (action === "move-up" && index > 0) {
      [config.items[index - 1], config.items[index]] = [config.items[index], config.items[index - 1]]; config.activePresetId = "current"; save(); render();
    } else if (action === "move-down" && index >= 0 && index < config.items.length - 1) {
      [config.items[index + 1], config.items[index]] = [config.items[index], config.items[index + 1]]; config.activePresetId = "current"; save(); render();
    } else if (action === "delete-item" && index >= 0) {
      confirmAction("删除条目", `确定删除“${config.items[index].name}”？`, "删除", () => { config.items.splice(index, 1); config.activePresetId = "current"; });
    } else if (action === "save-preset") {
      textPrompt("另存为预设", "预设名称", "", (name) => { config.presets.push({ id: `tc-preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, createdAt: Date.now(), snapshot: currentSnapshot() }); toast("预设已保存"); });
    } else if (action === "load-builtin") {
      loadSnapshot({ ...currentSnapshot(), mode: "card", items: clone(DEFAULT_ITEMS) }, "builtin-default");
    } else if (action === "load-preset") {
      const preset = config.presets.find((entry) => entry.id === id); if (preset) loadSnapshot(preset.snapshot, preset.id);
    } else if (action === "rename-preset") {
      const preset = config.presets.find((entry) => entry.id === id); if (preset) textPrompt("重命名预设", "新名称", preset.name, (name) => { preset.name = name; toast("预设已重命名"); });
    } else if (action === "delete-preset") {
      const preset = config.presets.find((entry) => entry.id === id); if (preset) confirmAction("删除预设", `确定删除“${preset.name}”？`, "删除", () => { config.presets = config.presets.filter((entry) => entry.id !== id); if (config.activePresetId === id) config.activePresetId = "current"; });
    } else if (action === "export") exportConfig();
    else if (action === "test-parser") {
      const output = $("tc-parser-output");
      const result = extractTaggedReasoning($("tc-parser-input").value);
      output.hidden = false;
      output.textContent = `匹配数量：${result.count}\n\n【提取出的思考】\n${result.reasoning || "（无）"}\n\n【交给正文解析器的内容】\n${result.text || "（空）"}`;
    }
  }

  function init() {
    if (!$("thought-chain-screen")) return;
    $("tc-master-switch").addEventListener("change", (event) => {
      config.enabled = event.target.checked;
      save(); render(); toast(config.enabled ? `已开启：${modeName(config.mode)}` : "已关闭，恢复项目原始请求行为");
    });
    $("tc-mode-picker").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tc-mode]");
      if (!button || !config.enabled) return;
      config.mode = button.dataset.tcMode;
      config.activePresetId = "current";
      save(); render(); toast(`已切换为${modeName(config.mode)}`);
    });
    document.querySelector(".tc-view-switch").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tc-view]");
      if (!button) return;
      activeView = button.dataset.tcView;
      render();
    });
    $("tc-main-content").addEventListener("click", handleContentClick);
    $("tc-main-content").addEventListener("change", (event) => {
      const field = event.target.dataset.tcField;
      if (field) {
        const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
        if (field === "extraBodyJson" && value.trim()) {
          try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); }
          catch (_) { toast("额外请求参数必须是 JSON 对象"); render(); return; }
        }
        setNestedField(field, value); render();
      }
      const itemToggle = event.target.dataset.tcItemToggle;
      if (itemToggle) {
        const item = config.items.find((entry) => entry.id === itemToggle);
        if (item) { item.enabled = event.target.checked; config.activePresetId = "current"; save(); updateHeader(); }
      }
    });
    $("tc-sheet-close").addEventListener("click", closeSheet);
    $("tc-sheet-backdrop").addEventListener("click", (event) => { if (event.target === $("tc-sheet-backdrop")) closeSheet(); });
    $("tc-import-btn").addEventListener("click", () => $("tc-import-input").click());
    $("tc-import-input").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) importConfig(file);
      event.target.value = "";
    });
    render();
  }

  window.ThoughtChainApp = {
    open: render,
    getConfig: () => clone(config),
    prepareRequest,
    applyGeminiConfig,
    processResponse,
    detectProvider: (proxyUrl, model) => detectProvider(proxyUrl, model),
    resetForTests: () => { config = normalizeConfig(null); lastCapture = null; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
