(function initTukWorldBookCore(global) {
  "use strict";

  const POSITIONS = [
    "before_system", "before_character", "after_character", "before_examples",
    "after_examples", "author_note_top", "author_note_bottom", "before_history",
    "at_depth", "after_history", "before_response", "outlet", "collection_only",
  ];
  const POSITION_ALIASES = {
    0: "before_character", 1: "after_character", before: "before_character",
    2: "before_examples", 3: "after_examples", 4: "at_depth", 5: "author_note_top", 6: "author_note_bottom",
    after: "after_character", before_char: "before_character", after_char: "after_character",
    before_system: "before_system", in_chat: "at_depth", at_depth: "at_depth",
  };
  const LOG_LIMIT = 100;
  const runtimeLogs = [];
  const timedEffects = new Map();

  function uuid(prefix) {
    const value = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${value}`;
  }

  function text(value, fallback = "") {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return fallback;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return fallback;
  }

  function stringArray(value) {
    if (Array.isArray(value)) return value.map((item) => text(item).trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  function finite(value, fallback, min = -Infinity, max = Infinity) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function nullableBoolean(value) {
    return typeof value === "boolean" ? value : null;
  }

  function defaultEntry(overrides = {}) {
    const now = Date.now();
    return {
      id: uuid("wbe"), name: "", comment: "", content: "", enabled: true,
      activationMode: "constant", keys: [], secondaryKeys: [], selectiveLogic: "AND_ANY",
      position: "after_character", depth: 0, role: "system", order: 100, priority: 100,
      probability: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
      inclusionGroups: [], groupWeight: 100, prioritizeInclusion: false, useGroupScoring: false,
      preventRecursion: false, excludeFromRecursion: false, delayUntilRecursion: false,
      recursionLevel: 0, sticky: 0, cooldown: 0, delay: 0, characterFilters: [],
      excludedCharacterFilters: [], personaFilters: [], generationTypes: [], vectorized: false,
      vectorThreshold: null, scanSources: ["messages"], outletName: "", extensions: {},
      createdAt: now, updatedAt: now, ...overrides,
    };
  }

  function normalizeEntry(raw, index = 0, bookDefaults = {}) {
    raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { content: text(raw) };
    const ext = raw.extensions && typeof raw.extensions === "object" ? raw.extensions : {};
    const disabledAlias = raw.disable === true;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : !disabledAlias;
    const keys = stringArray(raw.keys ?? raw.key ?? raw.triggers);
    const secondaryKeys = stringArray(raw.secondaryKeys ?? raw.secondary_keys ?? raw.keysecondary);
    const constant = raw.constant === true || raw.activationMode === "constant";
    const vectorized = raw.vectorized === true || raw.activationMode === "vector";
    const rawPosition = raw.position ?? raw.injectPosition ?? ext.position ?? "after_character";
    const position = POSITIONS.includes(rawPosition) ? rawPosition : (POSITION_ALIASES[rawPosition] || "after_character");
    const known = new Set([
      "id", "uid", "name", "comment", "memo", "content", "enabled", "disable", "activationMode",
      "keys", "key", "triggers", "secondaryKeys", "secondary_keys", "keysecondary", "selectiveLogic", "selective",
      "constant", "position", "injectPosition", "depth", "role", "order", "insertion_order", "displayIndex",
      "priority", "probability", "useProbability", "scanDepth", "scan_depth", "caseSensitive", "case_sensitive",
      "matchWholeWords", "match_whole_words", "inclusionGroups", "group", "groupWeight", "group_weight",
      "prioritizeInclusion", "groupOverride", "useGroupScoring", "preventRecursion", "excludeFromRecursion",
      "delayUntilRecursion", "recursionLevel", "sticky", "cooldown", "delay", "characterFilters",
      "excludedCharacterFilters", "personaFilters", "generationTypes", "vectorized", "vectorThreshold",
      "scanSources", "outletName", "extensions", "createdAt", "updatedAt", "use_regex",
    ]);
    const unknown = {};
    Object.keys(raw).forEach((key) => { if (!known.has(key)) unknown[key] = raw[key]; });
    const activationMode = constant ? "constant" : vectorized && keys.length === 0 ? "vector" : "keyword";
    return defaultEntry({
      id: text(raw.id ?? raw.uid) || (bookDefaults.bookId ? `${bookDefaults.bookId}::entry-${index + 1}` : uuid("wbe")),
      name: text(raw.name).trim() || text(raw.comment ?? raw.memo).trim() || `词条 ${index + 1}`,
      comment: text(raw.comment ?? raw.memo), content: text(raw.content), enabled, activationMode,
      keys, secondaryKeys,
      selectiveLogic: ["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"].includes(raw.selectiveLogic)
        ? raw.selectiveLogic : (["AND_ANY", "NOT_ALL", "NOT_ANY", "AND_ALL"][finite(raw.selectiveLogic, 0, 0, 3)] || "AND_ANY"),
      position, depth: finite(raw.depth, 0, 0, 999), role: ["system", "user", "assistant"].includes(raw.role)
        ? raw.role : (["system", "user", "assistant"][finite(raw.role, 0, 0, 2)] || "system"),
      order: finite(raw.order ?? raw.insertion_order ?? raw.displayIndex, 100),
      priority: finite(raw.priority, 100), probability: raw.useProbability === false ? 100 : finite(raw.probability, 100, 0, 100),
      scanDepth: raw.scanDepth == null && raw.scan_depth == null ? null : finite(raw.scanDepth ?? raw.scan_depth, 0, 0, 999),
      caseSensitive: nullableBoolean(raw.caseSensitive ?? raw.case_sensitive),
      matchWholeWords: nullableBoolean(raw.matchWholeWords ?? raw.match_whole_words),
      inclusionGroups: stringArray(raw.inclusionGroups ?? raw.group),
      groupWeight: finite(raw.groupWeight ?? raw.group_weight, 100, 0),
      prioritizeInclusion: raw.prioritizeInclusion === true || raw.groupOverride === true,
      useGroupScoring: raw.useGroupScoring === true,
      preventRecursion: raw.preventRecursion === true || ext.prevent_recursion === true,
      excludeFromRecursion: raw.excludeFromRecursion === true || raw.excludeRecursion === true || ext.exclude_recursion === true,
      delayUntilRecursion: raw.delayUntilRecursion === true || ext.delay_until_recursion === true,
      recursionLevel: finite(raw.recursionLevel ?? ext.recursion_level, 0, 0),
      sticky: finite(raw.sticky ?? ext.sticky, 0, 0), cooldown: finite(raw.cooldown ?? ext.cooldown, 0, 0), delay: finite(raw.delay ?? ext.delay, 0, 0),
      characterFilters: stringArray(raw.characterFilters), excludedCharacterFilters: stringArray(raw.excludedCharacterFilters),
      personaFilters: stringArray(raw.personaFilters), generationTypes: stringArray(raw.generationTypes),
      vectorized, vectorThreshold: raw.vectorThreshold == null ? null : finite(raw.vectorThreshold, 0.75, 0, 1),
      scanSources: stringArray(raw.scanSources).length ? stringArray(raw.scanSources) : [
        "messages",
        ...(ext.matchCharacterDescription ? ["character"] : []),
        ...(ext.matchPersonaDescription ? ["persona"] : []),
        ...(ext.matchScenario ? ["scenario"] : []),
        ...(ext.matchCreatorNotes ? ["description"] : []),
      ],
      outletName: text(raw.outletName).trim(),
      extensions: { ...(raw.extensions && typeof raw.extensions === "object" ? raw.extensions : {}), ...unknown },
      createdAt: finite(raw.createdAt, Date.now()), updatedAt: finite(raw.updatedAt, Date.now()),
    });
  }

  function normalizeBook(raw, options = {}) {
    raw = raw && typeof raw === "object" ? raw : {};
    const normalizedBookId = text(raw.id) || uuid("wb");
    const wasString = typeof raw.content === "string";
    const rawEntries = Array.isArray(raw.entries) ? raw.entries
      : Array.isArray(raw.content) ? raw.content
        : wasString ? [{ name: raw.name, comment: "兼容正文", content: raw.content, enabled: raw.isEnabled !== false, constant: true }]
          : [];
    const entries = rawEntries.map((entry, index) => normalizeEntry(entry, index, { ...raw, bookId: normalizedBookId }));
    const known = new Set([
      "id", "name", "description", "content", "entries", "enabled", "isEnabled", "globallyEnabled", "isGlobal",
      "defaultScanDepth", "scan_depth", "tokenBudget", "token_budget", "recursiveScanning", "recursive_scanning",
      "maxRecursionSteps", "defaultCaseSensitive", "defaultMatchWholeWords", "categoryId", "tags", "source",
      "extensions", "schemaVersion", "createdAt", "updatedAt", "injectPosition",
    ]);
    const unknown = {};
    Object.keys(raw).forEach((key) => { if (!known.has(key)) unknown[key] = raw[key]; });
    return {
      id: normalizedBookId, schemaVersion: 1, name: text(raw.name).trim() || "未命名世界书",
      description: text(raw.description), enabled: raw.enabled !== false && raw.isEnabled !== false,
      globallyEnabled: raw.globallyEnabled === true || raw.isGlobal === true,
      defaultScanDepth: finite(raw.defaultScanDepth ?? raw.scan_depth, 6, 0, 999),
      tokenBudget: finite(raw.tokenBudget ?? raw.token_budget, 1500, 0),
      recursiveScanning: raw.recursiveScanning !== false && raw.recursive_scanning !== false,
      maxRecursionSteps: finite(raw.maxRecursionSteps, 3, 0, 20),
      defaultCaseSensitive: raw.defaultCaseSensitive === true,
      defaultMatchWholeWords: raw.defaultMatchWholeWords === true,
      categoryId: raw.categoryId ?? null, tags: stringArray(raw.tags), content: entries,
      source: raw.source && typeof raw.source === "object" ? raw.source : { type: options.source || "native" },
      extensions: { ...(raw.extensions && typeof raw.extensions === "object" ? raw.extensions : {}), ...unknown },
      createdAt: finite(raw.createdAt, Date.now()), updatedAt: finite(raw.updatedAt, Date.now()),
    };
  }

  function validateBook(book) {
    const errors = [];
    if (!book || typeof book !== "object") return ["世界书不是对象"];
    if (!book.id) errors.push("缺少世界书 ID");
    if (!book.name?.trim()) errors.push("书名为空");
    if (!Array.isArray(book.content)) errors.push("词条集合不是数组");
    (Array.isArray(book.content) ? book.content : []).forEach((entry, index) => {
      if (typeof entry.content !== "string") errors.push(`词条 ${index + 1} 正文不是字符串`);
      if (!Array.isArray(entry.keys)) errors.push(`词条 ${index + 1} 关键词不是数组`);
      if (!POSITIONS.includes(entry.position)) errors.push(`词条 ${index + 1} 插入位置无效`);
      if (entry.keys.some((key) => isRegexKey(key) && !compileRegex(key))) errors.push(`词条 ${index + 1} 包含无效正则`);
    });
    return errors;
  }

  function isRegexKey(key) { return /^\/(?:[^/\\]|\\.)+\/[dgimsuvy]*$/.test(key); }
  function compileRegex(key) {
    if (!isRegexKey(key) || key.length > 500) return null;
    const end = key.lastIndexOf("/");
    try { return new RegExp(key.slice(1, end), key.slice(end + 1)); } catch { return null; }
  }

  function containsCjk(value) { return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value); }
  function matchKey(haystack, key, caseSensitive, wholeWords) {
    key = text(key).trim();
    if (!key || key.length > 500) return false;
    if (isRegexKey(key)) return compileRegex(key)?.test(haystack.slice(0, 100000)) === true;
    const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
    const needle = caseSensitive ? key : key.toLocaleLowerCase();
    if (!wholeWords || containsCjk(needle)) return source.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(source); }
    catch { return source.includes(needle); }
  }

  function entryMatches(entry, book, scanText, recursionPass) {
    if (!entry.enabled || !entry.content.trim()) return { match: false, reason: entry.enabled ? "正文为空" : "条目已关闭", score: 0 };
    if (entry.delayUntilRecursion && recursionPass === 0) return { match: false, reason: "仅允许递归激活", score: 0 };
    if (entry.excludeFromRecursion && recursionPass > 0) return { match: false, reason: "禁止被递归激活", score: 0 };
    if (entry.activationMode === "constant") return { match: true, reason: "常驻条目", score: 1000 };
    const caseSensitive = entry.caseSensitive ?? book.defaultCaseSensitive;
    const wholeWords = entry.matchWholeWords ?? book.defaultMatchWholeWords;
    const primaryMatches = entry.keys.filter((key) => matchKey(scanText, key, caseSensitive, wholeWords));
    if (!primaryMatches.length) return { match: false, reason: entry.vectorized ? "关键词未命中，等待向量结果" : "主关键词未命中", score: 0 };
    const secondaryMatches = entry.secondaryKeys.filter((key) => matchKey(scanText, key, caseSensitive, wholeWords));
    let allowed = true;
    if (entry.secondaryKeys.length) {
      if (entry.selectiveLogic === "AND_ALL") allowed = secondaryMatches.length === entry.secondaryKeys.length;
      else if (entry.selectiveLogic === "NOT_ANY") allowed = secondaryMatches.length === 0;
      else if (entry.selectiveLogic === "NOT_ALL") allowed = secondaryMatches.length !== entry.secondaryKeys.length;
      else allowed = secondaryMatches.length > 0;
    }
    return allowed
      ? { match: true, reason: `命中关键词：${primaryMatches.concat(secondaryMatches).join("、")}`, score: primaryMatches.length + secondaryMatches.length }
      : { match: false, reason: "次级关键词条件未满足", score: 0 };
  }

  function stableRoll(seed) {
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
    return (hash >>> 0) % 100;
  }

  function estimateTokens(value) {
    const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    return Math.max(1, Math.ceil(cjk * 0.8 + (value.length - cjk) / 4));
  }

  function buildScanText(messages, depth, includeNames = true) {
    return (Array.isArray(messages) ? messages : []).filter((message) => !message?.isHidden)
      .slice(-Math.max(0, depth)).map((message) => {
        const body = text(message?.content);
        if (!includeNames) return body;
        return `${text(message?.name ?? message?.sender ?? message?.role)}: ${body}`;
      }).join("\n").slice(-100000);
  }

  function buildEntryScanText(entry, book, options, recursionText, recursionPass, includeNames) {
    if (recursionPass > 0) return recursionText;
    const depth = entry.scanDepth ?? book.defaultScanDepth;
    const sources = new Set(entry.scanSources.length ? entry.scanSources : ["messages"]);
    const settings = options.chat?.settings || {};
    const chunks = [];
    if (sources.has("messages") || sources.has("chat")) chunks.push(buildScanText(options.messages || options.chat?.history, depth, includeNames));
    if (sources.has("character") || sources.has("character_description")) chunks.push(text(settings.aiPersona));
    if (sources.has("persona") || sources.has("persona_description")) chunks.push(text(settings.myPersona));
    if (sources.has("scenario")) chunks.push(text(settings.scenario ?? options.chat?.scenario));
    if (sources.has("description")) chunks.push(text(options.chat?.description));
    return chunks.filter(Boolean).join("\n").slice(-100000);
  }

  function getPersonaIdentity(options) {
    const settings = options.chat?.settings || {};
    return [options.personaId, options.personaName, settings.activePersonaId, settings.personaId, settings.myNickname]
      .map((value) => text(value).trim()).filter(Boolean);
  }

  function getCandidateBooks(books, chat, temporaryBookIds = [], excludedBookIds = []) {
    const excluded = new Set(excludedBookIds.map(String));
    const linked = new Set([
      ...(chat?.settings?.linkedWorldBookIds || []), ...(chat?.settings?.chatWorldBookIds || []),
      ...(chat?.settings?.personaWorldBookIds || []), ...temporaryBookIds,
    ].map(String));
    return books.filter((book) => !excluded.has(String(book.id)) && (book.globallyEnabled || linked.has(String(book.id))));
  }

  function buildContext(options = {}) {
    const settings = options.globalSettings || global.state?.globalSettings || {};
    const engineEnabled = settings.worldBookEngineEnabled !== false;
    const allBooks = (options.books || global.state?.worldBooks || []).map((book) => normalizeBook(book));
    const diagnostics = [];
    const rejectedEntries = [];
    if (!engineEnabled) return emptyResult("世界书引擎已关闭");
    const candidates = getCandidateBooks(allBooks, options.chat, options.temporaryBookIds, options.excludedBookIds);
    const maxDepth = Math.max(0, ...candidates.map((book) => book.defaultScanDepth), 6);
    const baseScanText = buildScanText(options.messages || options.chat?.history, maxDepth, settings.worldBookIncludeNames !== false);
    const messageCount = (options.messages || options.chat?.history || []).filter((message) => !message?.isHidden).length;
    const activated = [];
    const activatedIds = new Set();
    let recursionText = baseScanText;
    const maxRecursions = Math.max(0, ...candidates.map((book) => book.maxRecursionSteps));
    for (let pass = 0; pass <= maxRecursions; pass += 1) {
      const newlyActivated = [];
      candidates.forEach((book) => {
        if (pass > 0 && !book.recursiveScanning) return;
        if (!book.enabled) {
          book.content.forEach((entry) => rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "世界书已关闭" }));
          return;
        }
        book.content.forEach((entry) => {
          const activationKey = `${book.id}:${entry.id}`;
          if (activatedIds.has(activationKey)) return;
          if (entry.generationTypes.length && !entry.generationTypes.includes(options.generationType || "normal")) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "生成类型不匹配" });
            return;
          }
          const characterName = text(options.chat?.name);
          if (entry.characterFilters.length && !entry.characterFilters.includes(characterName)) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "角色白名单不匹配" });
            return;
          }
          if (entry.excludedCharacterFilters.includes(characterName)) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "角色在黑名单中" });
            return;
          }
          const personaIdentity = getPersonaIdentity(options);
          if (entry.personaFilters.length && !entry.personaFilters.some((filter) => personaIdentity.includes(filter))) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "Persona 过滤条件不匹配" });
            return;
          }
          if (messageCount < entry.delay) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: `对话消息数未达到 Delay ${entry.delay}` });
            return;
          }
          const effectKey = `${options.chat?.id || "global"}:${activationKey}`;
          const effect = timedEffects.get(effectKey);
          const stickyActive = effect && messageCount <= effect.stickyUntil;
          if (!stickyActive && effect && messageCount <= effect.cooldownUntil) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "词条处于冷却期" });
            return;
          }
          const localScan = buildEntryScanText(entry, book, options, recursionText, pass, settings.worldBookIncludeNames !== false);
          const vectorMatches = options.vectorMatches instanceof Set ? options.vectorMatches : new Set(options.vectorMatches || []);
          const match = stickyActive
            ? { match: true, reason: "Sticky 持续激活", score: 900 }
            : entry.vectorized && (vectorMatches.has(entry.id) || vectorMatches.has(activationKey))
              ? { match: true, reason: "向量相似度命中", score: 500 }
              : entryMatches(entry, book, localScan, pass);
          if (!match.match) {
            if (pass === 0) rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: match.reason });
            return;
          }
          const seed = `${options.chat?.id || "global"}:${options.requestId || options.messages?.length || 0}:${entry.id}:${options.generationType || "normal"}`;
          if (stableRoll(seed) >= entry.probability) {
            rejectedEntries.push({ bookId: book.id, entryId: entry.id, name: entry.name, reason: "概率检查未通过" });
            return;
          }
          const record = { ...entry, activationKey, bookId: book.id, bookName: book.name, reason: match.reason, score: match.score, tokens: estimateTokens(entry.content), recursionPass: pass };
          if (!stickyActive && (entry.sticky > 0 || entry.cooldown > 0)) {
            timedEffects.set(effectKey, {
              stickyUntil: messageCount + entry.sticky,
              cooldownUntil: messageCount + entry.sticky + entry.cooldown,
            });
          }
          activatedIds.add(activationKey); newlyActivated.push(record); activated.push(record);
        });
      });
      if (!newlyActivated.length || !candidates.some((book) => book.recursiveScanning)) break;
      recursionText += `\n${newlyActivated.filter((entry) => !entry.preventRecursion).map((entry) => entry.content).join("\n")}`;
    }

    const groupMembers = new Map();
    activated.forEach((entry) => entry.inclusionGroups.forEach((group) => {
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      groupMembers.get(group).push(entry);
    }));
    const groupWinners = new Map();
    groupMembers.forEach((members, group) => {
      let pool = members.some((entry) => entry.prioritizeInclusion) ? members.filter((entry) => entry.prioritizeInclusion) : members;
      if (pool.some((entry) => entry.useGroupScoring)) {
        const bestScore = Math.max(...pool.map((entry) => entry.score));
        pool = pool.filter((entry) => entry.score === bestScore);
      }
      const totalWeight = pool.reduce((sum, entry) => sum + Math.max(0, entry.groupWeight), 0);
      const groupSeed = `${options.chat?.id || "global"}:${options.requestId || options.messages?.length || 0}:${group}`;
      let cursor = totalWeight ? (stableRoll(groupSeed) / 100) * totalWeight : 0;
      let winner = pool[0];
      for (const entry of pool) {
        cursor -= Math.max(0, entry.groupWeight);
        if (cursor < 0) { winner = entry; break; }
      }
      groupWinners.set(group, winner);
    });
    let selected = activated.filter((entry) => entry.inclusionGroups.every((group) => groupWinners.get(group)?.activationKey === entry.activationKey));
    activated.filter((entry) => !selected.includes(entry)).forEach((entry) => rejectedEntries.push({ bookId: entry.bookId, entryId: entry.id, name: entry.name, reason: "被包含组内其他词条淘汰" }));
    selected.sort((a, b) => b.priority - a.priority || b.score - a.score || b.order - a.order || a.id.localeCompare(b.id));
    const totalBudget = finite(settings.worldBookTokenBudget, 4096, 0);
    const usedByBook = new Map();
    let used = 0;
    const budgeted = [];
    selected.forEach((entry) => {
      const book = candidates.find((item) => item.id === entry.bookId);
      const bookUsed = usedByBook.get(entry.bookId) || 0;
      if (used + entry.tokens > totalBudget || bookUsed + entry.tokens > book.tokenBudget) {
        rejectedEntries.push({ bookId: entry.bookId, entryId: entry.id, name: entry.name, reason: "超出 Token 预算" });
      } else {
        used += entry.tokens; usedByBook.set(entry.bookId, bookUsed + entry.tokens); budgeted.push(entry);
      }
    });
    selected = budgeted.sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position) || a.order - b.order || a.id.localeCompare(b.id));
    const segments = Object.fromEntries(POSITIONS.map((position) => [position, []]));
    selected.forEach((entry) => segments[entry.position].push({ role: entry.role, depth: entry.depth, outletName: entry.outletName, content: entry.content, entryId: entry.id, bookId: entry.bookId }));
    const result = { segments, activatedEntries: selected, rejectedEntries, tokenUsage: used, overflow: rejectedEntries.some((entry) => entry.reason === "超出 Token 预算"), diagnostics };
    result.text = toLegacyText(result);
    runtimeLogs.unshift({ timestamp: Date.now(), chatId: options.chat?.id || null, generationType: options.generationType || "normal", activated: selected.map((entry) => entry.name), rejected: rejectedEntries, tokenUsage: used });
    runtimeLogs.splice(LOG_LIMIT);
    return result;
  }

  function emptyResult(reason) {
    const segments = Object.fromEntries(POSITIONS.map((position) => [position, []]));
    return { segments, activatedEntries: [], rejectedEntries: [], tokenUsage: 0, overflow: false, diagnostics: [reason], text: "" };
  }

  function toLegacyText(result) {
    return POSITIONS.filter((position) => position !== "collection_only" && position !== "outlet")
      .flatMap((position) => result.segments[position] || []).map((segment) => segment.content).filter(Boolean).join("\n\n");
  }

  function getOutlets(result) {
    const outlets = {};
    (result?.segments?.outlet || []).forEach((segment) => {
      const name = text(segment.outletName).trim();
      if (!name) return;
      if (!outlets[name]) outlets[name] = [];
      outlets[name].push(segment.content);
    });
    return Object.fromEntries(Object.entries(outlets).map(([name, values]) => [name, values.join("\n\n")]));
  }

  function resolveOutlets(template, result) {
    const outlets = getOutlets(result);
    return text(template).replace(/\{\{\s*worldbook_outlet\s*:\s*([^}]+)\}\}/gi, (_match, name) => outlets[name.trim()] || "");
  }

  function preview(book) {
    const normalized = normalizeBook(book);
    const active = normalized.content.filter((entry) => entry.enabled);
    return active.map((entry) => entry.content).filter(Boolean).join(" ").trim() || "暂无内容...";
  }

  function diagnose(books) {
    return (books || []).map((raw) => {
      const shape = typeof raw?.content === "string" ? "旧字符串" : Array.isArray(raw?.content) ? "词条数组" : "非法结构";
      const normalized = normalizeBook(raw);
      return { id: raw?.id, name: text(raw?.name, "未命名"), shape, errors: validateBook(normalized), normalized };
    });
  }

  function parseImport(data, meta = {}) {
    const source = meta.source || "external";
    if (data?.spec && data?.data?.character_book) data = data.data.character_book;
    if (data?.character_book) data = data.character_book;
    if (data?.entries) {
      const rawEntries = Array.isArray(data.entries) ? data.entries : Object.values(data.entries);
      return [normalizeBook({
        id: uuid("wb"), name: data.name || meta.name || "导入的世界书", description: data.description || "",
        content: rawEntries, defaultScanDepth: data.scan_depth, tokenBudget: data.token_budget,
        recursiveScanning: data.recursive_scanning, source: { type: source, importedAt: Date.now() }, extensions: data.extensions || {},
      }, { source })];
    }
    if (Array.isArray(data?.worldBooks)) return data.worldBooks.map((book) => normalizeBook({ ...book, id: uuid("wb"), source: { type: source, originalId: book.id, importedAt: Date.now() } }, { source }));
    if (Array.isArray(data)) return data.map((book) => normalizeBook({ ...book, id: uuid("wb") }, { source }));
    if (data && (data.content !== undefined || data.name)) return [normalizeBook({ ...data, id: uuid("wb") }, { source })];
    throw new Error("未识别到可导入的世界书或词条结构。");
  }

  async function normalizeDatabase(database) {
    if (!database?.worldBooks) return { changed: 0, diagnostics: [] };
    const rawBooks = await database.worldBooks.toArray();
    const reports = diagnose(rawBooks);
    const changedBooks = reports.filter((report, index) => JSON.stringify(report.normalized) !== JSON.stringify(rawBooks[index])).map((report) => report.normalized);
    if (changedBooks.length) await database.transaction("rw", database.worldBooks, () => database.worldBooks.bulkPut(changedBooks));
    if (global.state) global.state.worldBooks = reports.map((report) => report.normalized);
    return { changed: changedBooks.length, diagnostics: reports };
  }

  async function deleteBooksAndReferences(database, ids) {
    const targetIds = new Set(ids.map(String));
    await database.transaction("rw", database.worldBooks, database.chats, async () => {
      await database.worldBooks.bulkDelete(ids);
      const chats = await database.chats.toArray();
      const changed = chats.filter((chat) => {
        if (!chat.settings) return false;
        let wasChanged = false;
        ["linkedWorldBookIds", "chatWorldBookIds", "personaWorldBookIds"].forEach((field) => {
          if (!Array.isArray(chat.settings[field])) return;
          const next = chat.settings[field].filter((id) => !targetIds.has(String(id)));
          if (next.length !== chat.settings[field].length) { chat.settings[field] = next; wasChanged = true; }
        });
        const datingSettings = chat.settings.datingUISettings;
        if (Array.isArray(datingSettings?.linkedWorldBookIds)) {
          const next = datingSettings.linkedWorldBookIds.filter((id) => !targetIds.has(String(id)));
          if (next.length !== datingSettings.linkedWorldBookIds.length) { datingSettings.linkedWorldBookIds = next; wasChanged = true; }
        }
        return wasChanged;
      });
      if (changed.length) await database.chats.bulkPut(changed);
    });
  }

  function buildForChat(chat, options = {}) {
    const result = buildContext({
      chat,
      messages: options.messages || chat?.history || [],
      generationType: options.generationType || "normal",
      temporaryBookIds: options.temporaryBookIds || [],
      excludedBookIds: options.excludedBookIds || [],
      requestId: options.requestId,
    });
    return result.text ? `\n\n# 核心世界观设定\n${result.text}\n` : "";
  }

  global.TukWorldBook = {
    POSITIONS, defaultEntry, normalizeEntry, normalizeBook, validateBook, diagnose, preview,
    buildContext, buildForChat, toLegacyText, getOutlets, resolveOutlets, estimateTokens, parseImport, normalizeDatabase, deleteBooksAndReferences,
    getLogs: () => runtimeLogs.map((item) => structuredClone(item)), clearLogs: () => { runtimeLogs.length = 0; },
  };
})(window);
