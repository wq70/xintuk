/* Bilingual chat display. The active chat model produces the original text
 * and its reading translation in the same response. This module never makes
 * translation requests and never delays sending a user message. */
(function initBilingualFeature() {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: false,
    roleLanguage: "auto",
    readingLanguage: "zh-Hans",
    displayMode: "stacked",
    ttsMode: "original",
    recognizeUserBilingual: true,
    groupMode: "all",
    mixedLanguage: "preserve",
    style: "natural",
    formality: "auto",
    glossary: "",
    customInstruction: "",
    scopes: {
      text: true,
      voice: true,
      offline: true,
      call: false,
      background: false,
      notification: false,
    },
  });

  const LANGUAGE_OPTIONS = [
    ["auto", "按角色设定判断"],
    ["zh-Hans", "简体中文"],
    ["zh-Hant", "繁体中文"],
    ["en", "英语"],
    ["ja", "日语"],
    ["ko", "韩语"],
    ["fr", "法语"],
    ["de", "德语"],
    ["es", "西班牙语"],
    ["pt", "葡萄牙语"],
    ["ru", "俄语"],
    ["it", "意大利语"],
    ["ar", "阿拉伯语"],
    ["th", "泰语"],
    ["vi", "越南语"],
    ["tr", "土耳其语"],
    ["id", "印尼语"],
    ["hi", "印地语"],
    ["other", "其他（在补充要求中说明）"],
  ];

  const TRANSLATABLE_TYPES = new Set(["text", "voice_message", undefined, null]);
  const DEPRECATED_SETTING_KEYS = new Set([
    "direction", "userLanguage", "engine", "presetId", "model", "provider",
    "endpoint", "apiKey", "region", "autoRetry",
  ]);
  let actionTimestamp = null;

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function cloneDefaults() {
    return { ...DEFAULTS, scopes: { ...DEFAULTS.scopes } };
  }

  function settings(chat) {
    const saved = chat?.settings?.bilingual || {};
    const cleanSaved = {};
    Object.entries(saved).forEach(([key, value]) => {
      if (!DEPRECATED_SETTING_KEYS.has(key) && key !== "scopes") cleanSaved[key] = value;
    });
    if (chat?.settings?.bilingual) {
      DEPRECATED_SETTING_KEYS.forEach((key) => delete chat.settings.bilingual[key]);
    }
    return {
      ...cloneDefaults(),
      ...cleanSaved,
      scopes: { ...DEFAULTS.scopes, ...(saved.scopes || {}) },
    };
  }

  function ensureSettings(chat) {
    if (!chat.settings) chat.settings = {};
    chat.settings.bilingual = settings(chat);
    return chat.settings.bilingual;
  }

  function languageLabel(code) {
    return LANGUAGE_OPTIONS.find(([value]) => value === code)?.[1] || code || "按角色设定判断";
  }

  function languageOptions(includeAuto = true) {
    return LANGUAGE_OPTIONS
      .filter(([value]) => includeAuto || value !== "auto")
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
  }

  function textOf(message) {
    return typeof message?.content === "string" ? message.content : "";
  }

  function inlineBilingualParts(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;

    const explicitPairs = [["〖", "〗"], ["「", "」"]];
    for (const [open, close] of explicitPairs) {
      const originalParts = [];
      const translationParts = [];
      let cursor = 0;
      while (cursor < text.length) {
        const openIndex = text.indexOf(open, cursor);
        if (openIndex < 0) break;
        const closeIndex = text.indexOf(close, openIndex + open.length);
        if (closeIndex < 0) break;
        const originalPart = text.slice(cursor, openIndex).trim();
        const translationPart = text.slice(openIndex + open.length, closeIndex).trim();
        if (!originalPart || !translationPart) break;
        originalParts.push(originalPart);
        translationParts.push(translationPart);
        cursor = closeIndex + close.length;
      }
      const tail = text.slice(cursor).trim();
      if (tail) originalParts.push(tail);
      if (translationParts.length && originalParts.length) {
        return {
          original: originalParts.join(" ").replace(/\s+/g, " ").trim(),
          translation: translationParts.join(" ").replace(/\s+/g, " ").trim(),
          format: `${open}${close}`,
        };
      }
    }

    for (const [open, close] of [["（", "）"], ["(", ")"]]) {
      if (!text.endsWith(close)) continue;
      const closeIndex = text.length - close.length;
      const openIndex = text.lastIndexOf(open, closeIndex - 1);
      if (openIndex <= 0) continue;
      const original = text.slice(0, openIndex).trim();
      const translation = text.slice(openIndex + open.length, closeIndex).trim();
      if (!original || !translation) continue;
      if (open === "（" || open === "(") {
        const crossLanguage = /[A-Za-z\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(original)
          && /[\u3400-\u9fff]/.test(translation);
        if (!crossLanguage || translation.length < 2) continue;
      }
      return { original, translation, format: `${open}${close}` };
    }
    return null;
  }

  function translationRecord(message, targetLanguage) {
    const structured = message?.bilingual;
    if (structured?.translation && (!structured.targetLanguage || structured.targetLanguage === targetLanguage)) {
      return {
        text: String(structured.translation).trim(),
        sourceLanguage: structured.sourceLanguage || message.language || "auto",
        targetLanguage: structured.targetLanguage || targetLanguage,
        origin: structured.origin || "same-response",
      };
    }
    const current = message?.translations?.[targetLanguage];
    if (!current?.text) return null;
    return {
      text: String(current.text).trim(),
      sourceLanguage: current.sourceLanguage || message.language || "auto",
      targetLanguage,
      origin: current.manuallyEdited ? "manual" : current.provider || "legacy",
    };
  }

  function assignBilingual(message, original, translation, metadata = {}) {
    const cleanOriginal = String(original || "").trim();
    const cleanTranslation = String(translation || "").trim();
    if (!cleanOriginal || !cleanTranslation) return false;
    message.content = cleanOriginal;
    message.language = metadata.sourceLanguage || message.language || "auto";
    message.bilingual = {
      original: cleanOriginal,
      translation: cleanTranslation,
      sourceLanguage: message.language,
      targetLanguage: metadata.targetLanguage || "zh-Hans",
      origin: metadata.origin || "same-response",
      format: 1,
    };
    return true;
  }

  function groupMember(chat, senderName) {
    return chat?.members?.find((member) =>
      member.originalName === senderName || member.groupNickname === senderName,
    );
  }

  function memberEnabled(chat, senderName) {
    if (!chat?.isGroup) return true;
    const config = settings(chat);
    if (config.groupMode !== "selected") return true;
    return Boolean(groupMember(chat, senderName)?.bilingual?.enabled);
  }

  function memberLanguage(chat, senderName) {
    if (!chat?.isGroup) return settings(chat).roleLanguage;
    return groupMember(chat, senderName)?.bilingual?.language || settings(chat).roleLanguage;
  }

  function normalizeMessage(message, chat, options = {}) {
    if (!message || !chat || !textOf(message).trim()) return message;
    const config = settings(chat);
    const target = config.readingLanguage;

    if (message.bilingual?.translation) {
      message.bilingual.original = textOf(message);
      message.bilingual.targetLanguage ||= target;
      message.bilingual.sourceLanguage ||= message.language || "auto";
      message.bilingual.origin ||= "same-response";
      message.bilingual.format ||= 1;
      return message;
    }

    const legacy = message.translations?.[target];
    if (legacy?.text) {
      assignBilingual(message, textOf(message), legacy.text, {
        sourceLanguage: legacy.sourceLanguage || message.language || "auto",
        targetLanguage: target,
        origin: legacy.manuallyEdited ? "manual" : "legacy-import",
      });
      return message;
    }

    const allowUser = message.role !== "user" || config.recognizeUserBilingual || options.force;
    if (!allowUser) return message;
    const split = inlineBilingualParts(textOf(message));
    if (split) {
      assignBilingual(message, split.original, split.translation, {
        sourceLanguage: message.language || memberLanguage(chat, message.senderName),
        targetLanguage: target,
        origin: message.role === "user" ? "user-authored" : "legacy-inline",
      });
    }
    return message;
  }

  function scopeEnabled(config, type, mode) {
    if (!config.enabled) return false;
    if (mode === "offline" && !config.scopes.offline) return false;
    if (mode === "call" && !config.scopes.call) return false;
    if (mode === "background" && !config.scopes.background) return false;
    if (type === "voice_message") return config.scopes.voice;
    return config.scopes.text && TRANSLATABLE_TYPES.has(type);
  }

  function promptStyle(config) {
    const styles = {
      natural: "忠实且自然，符合目标语言的日常表达",
      literal: "尽量忠实直译，保留原句结构和措辞",
      localized: "准确保留原意，并使用自然的本地化表达",
      literary: "准确保留原意，并保持文学性、氛围和修辞",
      character: "准确保留原意、角色口癖、礼貌程度和情绪强度",
    };
    const formalities = {
      auto: "礼貌程度跟随原文",
      informal: "保持轻松口语",
      formal: "保持正式礼貌",
    };
    const mixed = {
      preserve: "保留专名、俚语、昵称及原文中已有的混合语言",
      translate: "除专有名词外尽量完整转换为阅读语言",
      annotate: "保留必要原词，并在译文中给出极简自然释义",
    };
    return `${styles[config.style] || styles.natural}；${formalities[config.formality] || formalities.auto}；${mixed[config.mixedLanguage] || mixed.preserve}`;
  }

  function buildGroupRule(chat, config) {
    if (!chat.isGroup) {
      return `角色原文语言：${languageLabel(config.roleLanguage)}；选择“按角色设定判断”时，依据角色人设与当前语境自然决定。`;
    }
    const members = (chat.members || []).map((member) => {
      const enabled = config.groupMode !== "selected" || member.bilingual?.enabled;
      return `- ${member.originalName}：${enabled ? `启用双语，原文语言为${languageLabel(member.bilingual?.language || config.roleLanguage)}` : "不启用双语，只按原有格式输出"}`;
    }).join("\n");
    return `群聊必须严格按发送者区分，不能把未选成员变成双语。\n${members}`;
  }

  function buildPromptContext(chat, options = {}) {
    const config = settings(chat);
    const mode = options.mode || "chat";
    const modeAllowed = mode === "offline"
      ? config.scopes.offline
      : mode === "call"
        ? config.scopes.call
        : mode === "background"
          ? config.scopes.background
          : true;
    if (!config.enabled || !modeAllowed || (!config.scopes.text && !config.scopes.voice)) return "";
    const target = languageLabel(config.readingLanguage);
    const enabledTypes = [
      config.scopes.text ? "text" : "",
      config.scopes.voice ? "voice_message" : "",
    ].filter(Boolean).join(" 和 ");
    const glossary = config.glossary.trim()
      ? `\n# 固定术语\n以下对应关系优先遵守，不得擅自改译：\n${config.glossary.trim()}`
      : "";
    const custom = config.customInstruction.trim()
      ? `\n# 补充要求\n${config.customInstruction.trim()}`
      : "";
    return `
# 双语输出铁律（与本次回复同轮完成，禁止拆成额外消息）
- 对启用双语的角色，每个 ${enabledTypes} 对象必须保留原有字段，并额外输出："language":"原文语言代码","translation":{"text":"${target}译文","sourceLanguage":"原文语言代码","targetLanguage":"${config.readingLanguage}"}。
- content/message 只写角色真正说出的原文；translation.text 只写对应译文。译文是阅读辅助，不是角色再次说话。
- 一条原文与其译文必须处于同一个消息对象中；不得拆成两条消息，不得只给译文，不得翻译 JSON 键名。
- 译文要求：${promptStyle(config)}。
- 角色主动使用${target}说话时，不要机械生成内容相同的重复译文，可省略 translation。
- 动作、图片、表情包、转账、红包、定位、投票、状态更新等非语言字段保持原格式，不得强行添加译文。
- ${buildGroupRule(chat, config)}${glossary}${custom}`;
  }

  function buildCallPromptContext(chat, options = {}) {
    const config = settings(chat);
    if (!config.enabled || !config.scopes.call) return "";
    const target = languageLabel(config.readingLanguage);
    if (options.isGroup) {
      return `
			1. **【【【语言与双语铁律】】】**: 按下列成员规则决定语言；启用双语的角色必须在 speech 中使用“角色真正说出的原文〖${target}译文〗”，未启用者保持普通单语。译文只是字幕，不是角色重复发言。
			${buildGroupRule(chat, config)}`;
    }
    return `
# 通话双语铁律
- 你的整段发言必须使用“角色真正说出的原文〖${target}译文〗”。动作、表情或心理活动仍用原有【】格式写在原文部分。
- 〖〗中的译文只是字幕，不是你再次说话；不得只输出译文，不得拆成两次发言。
- 译文要求：${promptStyle(config)}。`;
  }

  function contextContent(message) {
    if (!message) return "";
    return message.bilingual?.original || inlineBilingualParts(textOf(message))?.original || message.content;
  }

  function notificationContent(message, chat, fallback = "") {
    const config = settings(chat);
    if (!config.enabled || !config.scopes.notification) return fallback;
    return translationRecord(message, config.readingLanguage)?.text || fallback;
  }

  function prepareMessagesForModel(messages, chat) {
    return (messages || []).map((message) => {
      if (!message || typeof message !== "object") return message;
      const copy = { ...message, content: contextContent(message, chat) };
      delete copy.bilingual;
      delete copy.translations;
      delete copy.modelContent;
      delete copy.modelTranslation;
      delete copy.modelTranslations;
      return copy;
    });
  }

  function extractGeneratedMetadata(data, chat, options = {}) {
    const config = settings(chat);
    if (!config.enabled || !data || typeof data !== "object") return {};
    const mode = options.mode || "chat";
    if (!scopeEnabled(config, data.type, mode) || !memberEnabled(chat, data.name)) return {};
    const key = typeof data.content === "string" ? "content" : typeof data.message === "string" ? "message" : null;
    if (!key) return {};

    let original = data[key];
    let translatedText = "";
    const sourceLanguage = data.language || data.translation?.sourceLanguage || data.bilingual?.sourceLanguage || memberLanguage(chat, data.name);
    const targetLanguage = data.translation?.targetLanguage || data.bilingual?.targetLanguage || config.readingLanguage;
    const split = inlineBilingualParts(original);
    if (split) {
      original = split.original;
      translatedText = split.translation;
      data[key] = original;
    } else if (typeof data.translation === "string") {
      translatedText = data.translation;
    } else if (data.translation && typeof data.translation === "object") {
      translatedText = data.translation.text || data.translation.content || "";
    } else if (data.bilingual && typeof data.bilingual === "object") {
      translatedText = data.bilingual.translation || data.bilingual.text || "";
    }

    const metadata = { language: sourceLanguage || "auto" };
    if (String(translatedText).trim() && String(translatedText).trim() !== String(original).trim()) {
      const draft = { content: original };
      assignBilingual(draft, original, translatedText, {
        sourceLanguage: metadata.language,
        targetLanguage,
        origin: "same-response",
      });
      metadata.bilingual = draft.bilingual;
    }
    return metadata;
  }

  function onMessageStored(message, chat, options = {}) {
    if (!message || !chat) return message;
    const config = settings(chat);
    if (!config.enabled) return message;
    if (message.role === "user" && !config.recognizeUserBilingual) return message;
    return normalizeMessage(message, chat, options);
  }

  function contentHost(wrapper) {
    return wrapper.querySelector(".message-bubble > .content");
  }

  function ensureOriginalHost(content) {
    let body = content.querySelector(":scope > .bilingual-original");
    if (body) return body;
    body = document.createElement("div");
    body.className = "bilingual-original";
    const quote = content.querySelector(":scope > .quoted-message");
    Array.from(content.childNodes).forEach((node) => {
      if (node !== quote) body.appendChild(node);
    });
    content.appendChild(body);
    return body;
  }

  function clearDecoration(wrapper) {
    wrapper.querySelectorAll(".bilingual-translation, .bilingual-toggle").forEach((node) => node.remove());
    wrapper.classList.remove("has-bilingual-content", "bilingual-under-mode");
    const body = wrapper.querySelector(".bilingual-original");
    if (body) body.hidden = false;
  }

  function decorateMessageElement(wrapper, message, chat) {
    if (!wrapper || !message || !chat) return;
    clearDecoration(wrapper);
    const config = settings(chat);
    if (!config.enabled || !TRANSLATABLE_TYPES.has(message.type)) return;
    normalizeMessage(message, chat);
    if (message.role === "assistant" && !memberEnabled(chat, message.senderName)) return;
    if (message.role === "user" && !config.recognizeUserBilingual) return;

    const translation = translationRecord(message, config.readingLanguage);
    if (!translation?.text || translation.text === textOf(message).trim()) return;
    const content = contentHost(wrapper);
    if (!content) return;
    const original = ensureOriginalHost(content);
    const translated = document.createElement("div");
    translated.className = "bilingual-translation";
    translated.lang = config.readingLanguage;
    translated.textContent = translation.text;
    wrapper.classList.add("has-bilingual-content");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bilingual-toggle";
    toggle.setAttribute("aria-expanded", "false");

    if (config.displayMode === "original-only") {
      return;
    } else if (config.displayMode === "translation-only") {
      original.hidden = true;
      toggle.textContent = "原文";
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        original.hidden = !original.hidden;
        toggle.classList.toggle("is-open", !original.hidden);
        toggle.setAttribute("aria-expanded", String(!original.hidden));
      });
      content.append(translated, toggle);
    } else if (config.displayMode === "expand") {
      translated.hidden = true;
      toggle.textContent = `译 · ${languageLabel(config.readingLanguage)}`;
      const toggleTranslation = (event) => {
        if (event) event.stopPropagation();
        translated.hidden = !translated.hidden;
        toggle.classList.toggle("is-open", !translated.hidden);
        toggle.setAttribute("aria-expanded", String(!translated.hidden));
      };
      toggle.addEventListener("click", toggleTranslation);
      wrapper.querySelector(".message-bubble")?.addEventListener("click", (event) => {
        if (event.target.closest("button, a, .quoted-message")) return;
        toggleTranslation(event);
      });
      content.append(toggle, translated);
    } else if (config.displayMode === "inline") {
      translated.classList.add("is-inline");
      content.appendChild(translated);
    } else if (config.displayMode === "under") {
      wrapper.classList.add("bilingual-under-mode");
      wrapper.querySelector(".message-bubble")?.insertAdjacentElement("afterend", translated);
    } else {
      content.appendChild(translated);
    }

    if (message.type === "voice_message") {
      const bubble = wrapper.querySelector(".message-bubble");
      const originalText = textOf(message);
      if (bubble) {
        bubble.dataset.voiceText = config.ttsMode === "translation"
          ? translation.text
          : config.ttsMode === "both"
            ? `${originalText}。${translation.text}`
            : originalText;
      }
    }
  }

  function renderCallContent(bubble, rawText, chat, senderName) {
    const raw = String(rawText || "").trim();
    const config = settings(chat);
    const split = config.enabled && config.scopes.call && memberEnabled(chat, senderName)
      ? inlineBilingualParts(raw)
      : null;
    const originalText = split?.original || raw;
    const translationText = split?.translation || "";
    const original = document.createElement("span");
    original.className = "bilingual-call-original";
    original.textContent = originalText;
    bubble.appendChild(original);

    if (translationText && config.displayMode !== "original-only") {
      const translation = document.createElement("span");
      translation.className = "bilingual-call-translation";
      translation.textContent = translationText;
      if (config.displayMode === "translation-only") original.hidden = true;
      if (config.displayMode === "expand") {
        translation.hidden = true;
        bubble.classList.add("bilingual-call-expandable");
        bubble.addEventListener("click", () => {
          translation.hidden = !translation.hidden;
          bubble.setAttribute("aria-expanded", String(!translation.hidden));
        });
      }
      bubble.appendChild(translation);
    }

    return {
      original: originalText,
      translation: translationText,
      ttsText: config.ttsMode === "translation" && translationText
        ? translationText
        : config.ttsMode === "both" && translationText
          ? `${originalText}。${translationText}`
          : originalText,
      bilingual: translationText ? {
        original: originalText,
        translation: translationText,
        sourceLanguage: memberLanguage(chat, senderName),
        targetLanguage: config.readingLanguage,
        origin: "same-response",
        format: 1,
      } : null,
    };
  }

  function setValue(id, value) {
    if (el(id)) el(id).value = value ?? "";
  }

  function setChecked(id, value) {
    if (el(id)) el(id).checked = Boolean(value);
  }

  function readForm() {
    const scopes = {};
    Object.keys(DEFAULTS.scopes).forEach((key) => {
      scopes[key] = Boolean(el(`bilingual-scope-${key}`)?.checked);
    });
    return {
      ...cloneDefaults(),
      enabled: Boolean(el("bilingual-enabled")?.checked),
      roleLanguage: el("bilingual-role-language")?.value || DEFAULTS.roleLanguage,
      readingLanguage: el("bilingual-reading-language")?.value || DEFAULTS.readingLanguage,
      displayMode: el("bilingual-display-mode")?.value || DEFAULTS.displayMode,
      ttsMode: el("bilingual-tts-mode")?.value || DEFAULTS.ttsMode,
      recognizeUserBilingual: Boolean(el("bilingual-recognize-user")?.checked),
      groupMode: el("bilingual-group-mode")?.value || DEFAULTS.groupMode,
      mixedLanguage: el("bilingual-mixed-language")?.value || DEFAULTS.mixedLanguage,
      style: el("bilingual-style")?.value || DEFAULTS.style,
      formality: el("bilingual-formality")?.value || DEFAULTS.formality,
      glossary: el("bilingual-glossary")?.value.trim() || "",
      customInstruction: el("bilingual-custom-instruction")?.value.trim() || "",
      scopes,
    };
  }

  function refreshSettingsVisibility() {
    const enabled = Boolean(el("bilingual-enabled")?.checked);
    if (el("bilingual-settings-body")) el("bilingual-settings-body").hidden = !enabled;
    const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
    if (el("bilingual-group-options")) el("bilingual-group-options").hidden = !chat?.isGroup;
    renderMemberRows();
  }

  function renderMemberRows() {
    const host = el("bilingual-member-list");
    const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
    if (!host) return;
    const selectedMode = el("bilingual-group-mode")?.value === "selected";
    const visible = Boolean(chat?.isGroup && el("bilingual-enabled")?.checked && selectedMode);
    host.hidden = !visible;
    if (!visible) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = (chat.members || []).map((member) => `
      <div class="bilingual-member-row" data-member-id="${escapeHtml(member.id)}">
        <label class="bilingual-member-choice" title="${escapeHtml(member.originalName)}">
          <input class="bilingual-member-enabled" type="checkbox">
          <span>${escapeHtml(member.groupNickname || member.originalName)}</span>
        </label>
        <select class="moe-input bilingual-member-language" aria-label="${escapeHtml(member.groupNickname || member.originalName)}的原文语言">${languageOptions(true)}</select>
      </div>`).join("");
    host.querySelectorAll(".bilingual-member-row").forEach((row) => {
      const member = (chat.members || []).find((item) => String(item.id) === row.dataset.memberId);
      row.querySelector(".bilingual-member-enabled").checked = Boolean(member?.bilingual?.enabled);
      row.querySelector(".bilingual-member-language").value = member?.bilingual?.language || "auto";
    });
  }

  function loadSettingsForm(chat) {
    if (!chat || !el("bilingual-enabled")) return;
    const config = settings(chat);
    setChecked("bilingual-enabled", config.enabled);
    setValue("bilingual-role-language", config.roleLanguage);
    setValue("bilingual-reading-language", config.readingLanguage);
    setValue("bilingual-display-mode", config.displayMode);
    setValue("bilingual-tts-mode", config.ttsMode);
    setChecked("bilingual-recognize-user", config.recognizeUserBilingual);
    setValue("bilingual-group-mode", config.groupMode);
    setValue("bilingual-mixed-language", config.mixedLanguage);
    setValue("bilingual-style", config.style);
    setValue("bilingual-formality", config.formality);
    setValue("bilingual-glossary", config.glossary);
    setValue("bilingual-custom-instruction", config.customInstruction);
    Object.keys(DEFAULTS.scopes).forEach((key) => setChecked(`bilingual-scope-${key}`, config.scopes[key]));
    refreshSettingsVisibility();
  }

  function saveSettingsForm(chat) {
    if (!chat || !el("bilingual-enabled")) return;
    chat.settings ||= {};
    chat.settings.bilingual = readForm();
    if (chat.isGroup) {
      el("bilingual-member-list")?.querySelectorAll(".bilingual-member-row").forEach((row) => {
        const member = (chat.members || []).find((item) => String(item.id) === row.dataset.memberId);
        if (!member) return;
        member.bilingual = {
          enabled: Boolean(row.querySelector(".bilingual-member-enabled")?.checked),
          language: row.querySelector(".bilingual-member-language")?.value || "auto",
        };
      });
    }
    ensureSettings(chat);
  }

  function loadMemberSettings(member) {
    setChecked("member-bilingual-enabled", member?.bilingual?.enabled);
    setValue("member-bilingual-language", member?.bilingual?.language || "auto");
  }

  function saveMemberSettings(member) {
    if (!member || !el("member-bilingual-language")) return;
    member.bilingual = {
      ...(member.bilingual || {}),
      enabled: Boolean(el("member-bilingual-enabled")?.checked),
      language: el("member-bilingual-language").value || "auto",
    };
  }

  function updateMessageActions(message, chat) {
    const group = el("bilingual-message-actions");
    if (!group) return;
    actionTimestamp = message?.timestamp || null;
    const config = settings(chat);
    const eligible = Boolean(message && config.enabled && textOf(message) && TRANSLATABLE_TYPES.has(message.type));
    group.hidden = !eligible;
  }

  function activeActionMessage() {
    const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
    return { chat, message: chat?.history?.find((item) => item.timestamp === actionTimestamp) };
  }

  async function closeActionsAndRender(chat) {
    el("message-actions-modal")?.classList.remove("visible");
    await db.chats.put(chat);
    renderChatInterface(chat.id);
  }

  async function copyText(value) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    el("message-actions-modal")?.classList.remove("visible");
  }

  function installSettingsUi() {
    if (el("bilingual-settings-card")) return;
    const timeCard = el("time-context-settings-host")?.closest(".settings-group-card");
    if (!timeCard?.parentNode) return;
    const card = document.createElement("div");
    card.id = "bilingual-settings-card";
    card.className = "settings-group-card moe-card bilingual-settings-card";
    card.innerHTML = `
      <div class="settings-section-title">双语模式</div>
      <label class="toggle-switch-label">
        <span class="toggle-switch-text">开启角色双语</span>
        <input type="checkbox" id="bilingual-enabled">
        <span class="toggle-switch-slider"></span>
      </label>
      <p class="bilingual-help">角色模型在同一轮回复中生成原文和阅读译文，不调用额外翻译服务。</p>
      <div id="bilingual-settings-body" class="bilingual-settings-body" hidden>
        <div class="bilingual-grid">
          <div class="form-group"><label>我的阅读语言</label><select id="bilingual-reading-language" class="moe-input">${languageOptions(false)}</select></div>
          <div class="form-group"><label>角色原文语言</label><select id="bilingual-role-language" class="moe-input">${languageOptions(true)}</select></div>
          <div class="form-group"><label>消息显示</label><select id="bilingual-display-mode" class="moe-input"><option value="stacked">原文上、译文下</option><option value="expand">原文为主，点击展开</option><option value="translation-only">译文为主，可查看原文</option><option value="inline">气泡内紧凑显示</option><option value="under">气泡下方显示译文</option><option value="original-only">只显示原文</option></select></div>
          <div class="form-group"><label>语音朗读</label><select id="bilingual-tts-mode" class="moe-input"><option value="original">只读原文</option><option value="translation">只读译文</option><option value="both">依次朗读两者</option></select></div>
        </div>
        <label class="bilingual-check-row"><input type="checkbox" id="bilingual-recognize-user"><span>识别我手写的“原文〖译文〗”消息</span></label>
        <div id="bilingual-group-options" hidden>
          <div class="form-group"><label>群聊生效成员</label><select id="bilingual-group-mode" class="moe-input"><option value="all">全部角色</option><option value="selected">仅指定角色</option></select></div>
          <div id="bilingual-member-list" class="bilingual-member-list" hidden></div>
        </div>
        <details class="bilingual-details"><summary>生效场景</summary>
          <div class="bilingual-scope-grid">${Object.entries({ text: "文字消息", voice: "语音消息", offline: "线下模式", call: "语音/视频通话", background: "后台活动", notification: "通知显示译文" }).map(([key, label]) => `<label><input type="checkbox" id="bilingual-scope-${key}"><span>${label}</span></label>`).join("")}</div>
        </details>
        <details class="bilingual-details"><summary>译文表达与术语</summary>
          <div class="bilingual-grid">
            <div class="form-group"><label>译文风格</label><select id="bilingual-style" class="moe-input"><option value="natural">忠实自然</option><option value="literal">偏直译</option><option value="localized">本地化表达</option><option value="literary">文学表达</option><option value="character">跟随角色语气</option></select></div>
            <div class="form-group"><label>正式度</label><select id="bilingual-formality" class="moe-input"><option value="auto">跟随原文</option><option value="informal">轻松口语</option><option value="formal">正式礼貌</option></select></div>
            <div class="form-group bilingual-wide"><label>混合语言</label><select id="bilingual-mixed-language" class="moe-input"><option value="preserve">保留专名、俚语和混合语言</option><option value="translate">尽量完整转换</option><option value="annotate">必要时保留原词并简释</option></select></div>
          </div>
          <div class="form-group"><label>固定术语</label><textarea id="bilingual-glossary" class="moe-input bilingual-textarea" rows="3" placeholder="每行一条，例如：senpai=前辈"></textarea></div>
          <div class="form-group"><label>补充要求</label><textarea id="bilingual-custom-instruction" class="moe-input bilingual-textarea" rows="2" placeholder="例如：保留角色口癖，不翻译魔法名称"></textarea></div>
        </details>
      </div>`;
    timeCard.parentNode.insertBefore(card, timeCard.nextSibling);

    const memberHost = el("member-time-settings-host");
    if (memberHost?.parentNode && !el("member-bilingual-settings-host")) {
      const memberBox = document.createElement("div");
      memberBox.id = "member-bilingual-settings-host";
      memberBox.className = "form-group bilingual-member-editor";
      memberBox.innerHTML = `
        <label class="bilingual-member-choice"><input id="member-bilingual-enabled" type="checkbox"><span>该成员启用双语</span></label>
        <label for="member-bilingual-language">该成员的原文语言</label>
        <select id="member-bilingual-language" class="moe-input">${languageOptions(true)}</select>
        <p class="bilingual-help">仅在群聊选择“仅指定角色”时生效。</p>`;
      memberHost.insertAdjacentElement("afterend", memberBox);
    }

    const footer = el("message-actions-modal")?.querySelector(".custom-modal-footer");
    const cancel = el("cancel-message-action-btn");
    if (footer && cancel && !el("bilingual-message-actions")) {
      const group = document.createElement("div");
      group.id = "bilingual-message-actions";
      group.className = "bilingual-message-actions";
      group.hidden = true;
      group.innerHTML = `<button type="button" id="bilingual-action-menu">双语内容</button>`;
      footer.insertBefore(group, cancel);
    }
  }

  function installHandlers() {
    installSettingsUi();
    el("bilingual-enabled")?.addEventListener("change", refreshSettingsVisibility);
    el("bilingual-group-mode")?.addEventListener("change", renderMemberRows);

    el("bilingual-action-menu")?.addEventListener("click", async () => {
      const { chat, message } = activeActionMessage();
      if (!chat || !message) return;
      const config = settings(chat);
      const translation = translationRecord(message, settings(chat).readingLanguage)?.text;
      el("message-actions-modal")?.classList.remove("visible");
      const options = [
        { text: "复制原文", value: "copy-original" },
        ...(translation ? [
          { text: "复制译文", value: "copy-translation" },
          { text: "复制原文和译文", value: "copy-both" },
        ] : []),
        { text: "编辑双语内容", value: "edit" },
        ...(translation ? [{ text: "清除译文", value: "clear" }] : []),
      ];
      const choice = await showChoiceModal("双语内容", options);
      if (choice === "copy-original") {
        await copyText(contextContent(message));
        return;
      }
      if (choice === "copy-translation") {
        await copyText(translation);
        return;
      }
      if (choice === "copy-both") {
        await copyText(`${contextContent(message)}\n${translation}`);
        return;
      }
      if (choice === "clear") {
        delete message.bilingual;
        if (message.translations) delete message.translations[config.readingLanguage];
        if (message.translations && !Object.keys(message.translations).length) delete message.translations;
        await closeActionsAndRender(chat);
        return;
      }
      if (choice !== "edit") return;
      const original = await showCustomPrompt("编辑双语原文", "修改角色真正说出的内容。", contextContent(message), "textarea");
      if (original === null || original === undefined) return;
      const currentTranslation = translationRecord(message, config.readingLanguage)?.text || "";
      const editedTranslation = await showCustomPrompt("编辑阅读译文", "译文只用于显示，不会作为角色的第二句台词。", currentTranslation, "textarea");
      if (editedTranslation === null || editedTranslation === undefined) return;
      message.content = String(original).trim();
      if (String(editedTranslation).trim()) {
        assignBilingual(message, message.content, editedTranslation, {
          sourceLanguage: message.language || memberLanguage(chat, message.senderName),
          targetLanguage: config.readingLanguage,
          origin: "manual",
        });
      } else {
        delete message.bilingual;
      }
      await closeActionsAndRender(chat);
    });
  }

  window.TukBilingual = {
    buildPromptContext,
    buildCallPromptContext,
    contextContent,
    notificationContent,
    prepareMessagesForModel,
    extractGeneratedMetadata,
    onMessageStored,
    decorateMessageElement,
    renderCallContent,
    loadSettingsForm,
    saveSettingsForm,
    loadMemberSettings,
    saveMemberSettings,
    updateMessageActions,
    normalizeMessage,
    inlineBilingualParts,
    translationRecord,
    memberEnabled,
    settings,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installHandlers, { once: true });
  } else {
    installHandlers();
  }
})();
