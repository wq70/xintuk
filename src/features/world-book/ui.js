(function initTukWorldBookUI(global) {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const positionLabels = {
    before_system: "系统提示词之前", before_character: "角色定义之前", after_character: "角色定义之后",
    before_examples: "示例消息之前", after_examples: "示例消息之后", author_note_top: "作者注释顶部",
    author_note_bottom: "作者注释底部", before_history: "对话历史之前", at_depth: "指定聊天深度",
    after_history: "对话历史之后", before_response: "最终回复指令之前", outlet: "自定义插槽",
    collection_only: "仅收集，不自动注入",
  };

  function optionMarkup(options, selected) {
    return options.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
  }

  function setInput(card, selector, value) {
    const element = card.querySelector(selector);
    if (element) element.value = value ?? "";
  }

  function updateEntrySummary(card) {
    const enabled = card.querySelector(".entry-enabled-switch").checked;
    const name = card.querySelector(".entry-name-input").value.trim() || "未命名词条";
    const mode = card.querySelector(".entry-mode-select").value;
    const keys = card.querySelector(".entry-keys-input").value.trim();
    const position = card.querySelector(".entry-position-select").value;
    card.classList.toggle("is-disabled", !enabled);
    card.querySelector(".world-book-entry-summary-name").textContent = name;
    card.querySelector(".world-book-entry-summary-meta").textContent = `${enabled ? "已启用" : "已关闭"} · ${mode === "constant" ? "常驻" : mode === "vector" ? "向量" : keys || "无关键词"} · ${positionLabels[position] || position}`;
    updateEntryCount();
  }

  function updateEntryCount() {
    const cards = [...(byId("world-book-entries-container")?.querySelectorAll(".world-book-entry-card") || [])];
    const enabled = cards.filter((card) => card.querySelector(".entry-enabled-switch")?.checked).length;
    if (byId("world-book-entry-count")) byId("world-book-entry-count").textContent = `${enabled}/${cards.length} 已启用`;
  }

  function createEntryCard(rawEntry, open = false) {
    const entry = global.TukWorldBook.normalizeEntry(rawEntry);
    const card = document.createElement("article");
    card.className = `world-book-entry-card${open ? " is-open" : ""}${entry.enabled ? "" : " is-disabled"}`;
    card.dataset.entryId = entry.id;
    card.dataset.createdAt = String(entry.createdAt);
    card.innerHTML = `
      <div class="world-book-entry-summary" role="button" tabindex="0" aria-expanded="${open}">
        <label class="world-book-switch-item" title="单独启用或关闭此词条">
          <input type="checkbox" class="entry-enabled-switch"${entry.enabled ? " checked" : ""} />
          <span class="world-book-toggle-slider"></span>
        </label>
        <div class="world-book-entry-summary-main"><span class="world-book-entry-summary-name"></span><span class="world-book-entry-summary-meta"></span></div>
        <span class="world-book-entry-expand">⌄</span>
      </div>
      <div class="world-book-entry-body">
        <div class="world-book-entry-row">
          <div class="form-group"><label>词条名称</label><input type="text" class="entry-name-input" placeholder="便于识别，不会发送给 AI" /></div>
          <div class="form-group"><label>说明/备注</label><input type="text" class="entry-comment-input" placeholder="仅供自己查看" /></div>
        </div>
        <div class="form-group"><label>内容</label><textarea class="entry-content-input" rows="5" placeholder="此词条激活后注入给 AI 的内容"></textarea></div>
        <div class="world-book-entry-row">
          <div class="form-group"><label>激活方式</label><select class="entry-mode-select">${optionMarkup([["constant","常驻"],["keyword","关键词"],["vector","向量匹配"]], entry.activationMode)}</select></div>
          <div class="form-group"><label>插入位置</label><select class="entry-position-select">${optionMarkup(Object.entries(positionLabels), entry.position)}</select></div>
        </div>
        <div class="form-group"><label>主关键词（逗号或换行分隔）</label><input type="text" class="entry-keys-input" placeholder="例如：银月城, 王都" /></div>
        <div class="world-book-entry-row">
          <div class="form-group"><label>次级关键词</label><input type="text" class="entry-secondary-keys-input" /></div>
          <div class="form-group"><label>次级逻辑</label><select class="entry-selective-logic">${optionMarkup([["AND_ANY","AND ANY"],["AND_ALL","AND ALL"],["NOT_ANY","NOT ANY"],["NOT_ALL","NOT ALL"]], entry.selectiveLogic)}</select></div>
        </div>
        <details class="world-book-entry-options">
          <summary>顺序、匹配、过滤与高级行为</summary>
          <div class="world-book-entry-row">
            <label>顺序<input type="number" class="entry-order-input" /></label>
            <label>优先级<input type="number" class="entry-priority-input" /></label>
            <label>触发概率 %<input type="number" class="entry-probability-input" min="0" max="100" /></label>
            <label>扫描深度（留空继承）<input type="number" class="entry-scan-depth-input" min="0" /></label>
            <label>聊天深度<input type="number" class="entry-depth-input" min="0" /></label>
            <label>消息角色<select class="entry-role-select">${optionMarkup([["system","系统"],["user","用户"],["assistant","AI"]], entry.role)}</select></label>
            <label>大小写<select class="entry-case-select">${optionMarkup([["inherit","继承世界书"],["true","区分"],["false","不区分"]], entry.caseSensitive === null ? "inherit" : String(entry.caseSensitive))}</select></label>
            <label>全词匹配<select class="entry-whole-select">${optionMarkup([["inherit","继承世界书"],["true","开启"],["false","关闭"]], entry.matchWholeWords === null ? "inherit" : String(entry.matchWholeWords))}</select></label>
            <label>包含组<input type="text" class="entry-groups-input" placeholder="互斥组名" /></label>
            <label>组权重<input type="number" class="entry-group-weight-input" min="0" /></label>
            <label>角色白名单<input type="text" class="entry-character-filter-input" /></label>
            <label>角色黑名单<input type="text" class="entry-character-exclude-input" /></label>
            <label>Persona 过滤<input type="text" class="entry-persona-filter-input" /></label>
            <label>生成类型<input type="text" class="entry-generation-types-input" placeholder="normal, regenerate, quiet" /></label>
            <label>扫描来源<input type="text" class="entry-scan-sources-input" placeholder="messages, character, persona, scenario" /></label>
            <label>向量阈值<input type="number" class="entry-vector-threshold-input" min="0" max="1" step="0.01" placeholder="0.75" /></label>
            <label>Sticky 消息数<input type="number" class="entry-sticky-input" min="0" /></label>
            <label>Cooldown 消息数<input type="number" class="entry-cooldown-input" min="0" /></label>
            <label>Delay 消息数<input type="number" class="entry-delay-input" min="0" /></label>
            <label>自定义插槽名<input type="text" class="entry-outlet-input" /></label>
          </div>
          <div class="world-book-entry-row">
            <label class="world-book-checkline"><input type="checkbox" class="entry-prioritize-group" />包含组优先</label>
            <label class="world-book-checkline"><input type="checkbox" class="entry-group-scoring" />使用组评分</label>
            <label class="world-book-checkline"><input type="checkbox" class="entry-no-recursion" />激活后停止递归</label>
            <label class="world-book-checkline"><input type="checkbox" class="entry-exclude-recursion" />不可被递归激活</label>
            <label class="world-book-checkline"><input type="checkbox" class="entry-delay-recursion" />仅通过递归激活</label>
            <label class="world-book-checkline"><input type="checkbox" class="entry-vectorized" />允许向量召回</label>
          </div>
        </details>
        <div class="world-book-entry-footer"><button type="button" class="world-book-compact-btn world-book-entry-delete">删除词条</button></div>
      </div>`;
    setInput(card, ".entry-name-input", entry.name); setInput(card, ".entry-comment-input", entry.comment);
    setInput(card, ".entry-content-input", entry.content); setInput(card, ".entry-keys-input", entry.keys.join(", "));
    setInput(card, ".entry-secondary-keys-input", entry.secondaryKeys.join(", ")); setInput(card, ".entry-order-input", entry.order);
    setInput(card, ".entry-priority-input", entry.priority); setInput(card, ".entry-probability-input", entry.probability);
    setInput(card, ".entry-scan-depth-input", entry.scanDepth); setInput(card, ".entry-depth-input", entry.depth);
    setInput(card, ".entry-groups-input", entry.inclusionGroups.join(", ")); setInput(card, ".entry-group-weight-input", entry.groupWeight);
    setInput(card, ".entry-character-filter-input", entry.characterFilters.join(", ")); setInput(card, ".entry-character-exclude-input", entry.excludedCharacterFilters.join(", "));
    setInput(card, ".entry-persona-filter-input", entry.personaFilters.join(", ")); setInput(card, ".entry-generation-types-input", entry.generationTypes.join(", "));
    setInput(card, ".entry-scan-sources-input", entry.scanSources.join(", ")); setInput(card, ".entry-vector-threshold-input", entry.vectorThreshold);
    setInput(card, ".entry-sticky-input", entry.sticky); setInput(card, ".entry-cooldown-input", entry.cooldown); setInput(card, ".entry-delay-input", entry.delay);
    setInput(card, ".entry-outlet-input", entry.outletName);
    card.querySelector(".entry-prioritize-group").checked = entry.prioritizeInclusion;
    card.querySelector(".entry-group-scoring").checked = entry.useGroupScoring;
    card.querySelector(".entry-no-recursion").checked = entry.preventRecursion;
    card.querySelector(".entry-exclude-recursion").checked = entry.excludeFromRecursion;
    card.querySelector(".entry-delay-recursion").checked = entry.delayUntilRecursion;
    card.querySelector(".entry-vectorized").checked = entry.vectorized;
    const summary = card.querySelector(".world-book-entry-summary");
    const toggleOpen = (event) => {
      if (event.target.closest("label")) return;
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      if (event.type === "keydown") event.preventDefault();
      card.classList.toggle("is-open"); summary.setAttribute("aria-expanded", String(card.classList.contains("is-open")));
    };
    summary.addEventListener("click", toggleOpen); summary.addEventListener("keydown", toggleOpen);
    card.addEventListener("input", () => updateEntrySummary(card));
    card.addEventListener("change", () => updateEntrySummary(card));
    card.querySelector(".world-book-entry-delete").addEventListener("click", async () => {
      const confirmed = await global.showCustomConfirm?.("删除词条", "确定删除这个词条吗？保存世界书后生效。") ?? confirm("确定删除这个词条吗？");
      if (confirmed) { card.remove(); updateEntryCount(); }
    });
    updateEntrySummary(card);
    return card;
  }

  function parseList(value) { return String(value || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); }
  function numberValue(card, selector, fallback, nullable = false) {
    const value = card.querySelector(selector).value;
    if (nullable && value === "") return null;
    const number = Number(value); return Number.isFinite(number) ? number : fallback;
  }
  function triValue(card, selector) { const value = card.querySelector(selector).value; return value === "inherit" ? null : value === "true"; }

  function readEntries() {
    return [...byId("world-book-entries-container").querySelectorAll(".world-book-entry-card")].map((card) => global.TukWorldBook.normalizeEntry({
      id: card.dataset.entryId, createdAt: Number(card.dataset.createdAt) || Date.now(), updatedAt: Date.now(),
      enabled: card.querySelector(".entry-enabled-switch").checked,
      name: card.querySelector(".entry-name-input").value, comment: card.querySelector(".entry-comment-input").value,
      content: card.querySelector(".entry-content-input").value, activationMode: card.querySelector(".entry-mode-select").value,
      keys: parseList(card.querySelector(".entry-keys-input").value), secondaryKeys: parseList(card.querySelector(".entry-secondary-keys-input").value),
      selectiveLogic: card.querySelector(".entry-selective-logic").value, position: card.querySelector(".entry-position-select").value,
      order: numberValue(card, ".entry-order-input", 100), priority: numberValue(card, ".entry-priority-input", 100),
      probability: numberValue(card, ".entry-probability-input", 100), scanDepth: numberValue(card, ".entry-scan-depth-input", null, true),
      depth: numberValue(card, ".entry-depth-input", 0), role: card.querySelector(".entry-role-select").value,
      caseSensitive: triValue(card, ".entry-case-select"), matchWholeWords: triValue(card, ".entry-whole-select"),
      inclusionGroups: parseList(card.querySelector(".entry-groups-input").value), groupWeight: numberValue(card, ".entry-group-weight-input", 100),
      prioritizeInclusion: card.querySelector(".entry-prioritize-group").checked, useGroupScoring: card.querySelector(".entry-group-scoring").checked,
      preventRecursion: card.querySelector(".entry-no-recursion").checked, excludeFromRecursion: card.querySelector(".entry-exclude-recursion").checked,
      delayUntilRecursion: card.querySelector(".entry-delay-recursion").checked, vectorized: card.querySelector(".entry-vectorized").checked,
      characterFilters: parseList(card.querySelector(".entry-character-filter-input").value), excludedCharacterFilters: parseList(card.querySelector(".entry-character-exclude-input").value),
      personaFilters: parseList(card.querySelector(".entry-persona-filter-input").value), generationTypes: parseList(card.querySelector(".entry-generation-types-input").value),
      scanSources: parseList(card.querySelector(".entry-scan-sources-input").value), vectorThreshold: numberValue(card, ".entry-vector-threshold-input", null, true),
      sticky: numberValue(card, ".entry-sticky-input", 0), cooldown: numberValue(card, ".entry-cooldown-input", 0), delay: numberValue(card, ".entry-delay-input", 0),
      outletName: card.querySelector(".entry-outlet-input").value,
    }));
  }

  async function openEditor(bookId) {
    const [rawBook, categories] = await Promise.all([global.db.worldBooks.get(bookId), global.db.worldBookCategories.toArray()]);
    if (!rawBook) return;
    const book = global.TukWorldBook.normalizeBook(rawBook);
    global.editingWorldBookId = bookId;
    byId("world-book-editor-title").textContent = book.name;
    byId("world-book-name-input").value = book.name; byId("world-book-description-input").value = book.description;
    byId("world-book-enabled-switch").checked = book.enabled; byId("world-book-global-switch").checked = book.globallyEnabled;
    byId("world-book-scan-depth-input").value = book.defaultScanDepth; byId("world-book-token-budget-input").value = book.tokenBudget;
    byId("world-book-recursion-steps-input").value = book.maxRecursionSteps; byId("world-book-recursive-switch").checked = book.recursiveScanning;
    byId("world-book-case-sensitive-switch").checked = book.defaultCaseSensitive; byId("world-book-whole-word-switch").checked = book.defaultMatchWholeWords;
    const select = byId("world-book-category-select"); select.replaceChildren(new Option("-- 未分类 --", ""));
    categories.forEach((category) => { const option = new Option(category.name, category.id); option.selected = String(book.categoryId) === String(category.id); select.append(option); });
    const container = byId("world-book-entries-container"); container.replaceChildren();
    book.content.forEach((entry, index) => container.append(createEntryCard(entry, index === 0 && book.content.length === 1)));
    updateEntryCount(); global.showScreen("world-book-editor-screen");
  }

  async function saveEditor() {
    if (!global.editingWorldBookId) return false;
    const existing = await global.db.worldBooks.get(global.editingWorldBookId);
    if (!existing) return false;
    const name = byId("world-book-name-input").value.trim();
    if (!name) { await global.showCustomAlert?.("无法保存", "书名不能为空。"); return false; }
    const rawCategory = byId("world-book-category-select").value;
    const book = global.TukWorldBook.normalizeBook({ ...existing, id: global.editingWorldBookId, name,
      description: byId("world-book-description-input").value, enabled: byId("world-book-enabled-switch").checked,
      globallyEnabled: byId("world-book-global-switch").checked, defaultScanDepth: Number(byId("world-book-scan-depth-input").value),
      tokenBudget: Number(byId("world-book-token-budget-input").value), maxRecursionSteps: Number(byId("world-book-recursion-steps-input").value),
      recursiveScanning: byId("world-book-recursive-switch").checked, defaultCaseSensitive: byId("world-book-case-sensitive-switch").checked,
      defaultMatchWholeWords: byId("world-book-whole-word-switch").checked, categoryId: rawCategory ? Number(rawCategory) : null,
      content: readEntries(), updatedAt: Date.now(),
    });
    const errors = global.TukWorldBook.validateBook(book);
    if (errors.length) { await global.showCustomAlert?.("无法保存", errors.join("\n")); return false; }
    await global.db.worldBooks.put(book);
    const index = global.state.worldBooks.findIndex((item) => item.id === book.id);
    if (index >= 0) global.state.worldBooks[index] = book; else global.state.worldBooks.push(book);
    byId("world-book-editor-title").textContent = name; global.editingWorldBookId = null;
    await global.renderWorldBookScreen(); global.showScreen("world-book-screen"); return true;
  }

  function createGroup(groupName, books) {
    const group = document.createElement("div"); group.className = "world-book-group-container";
    const header = document.createElement("div"); header.className = "world-book-group-header collapsed";
    const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "▼";
    const name = document.createElement("span"); name.className = "group-name"; name.textContent = groupName;
    header.append(arrow, name); const content = document.createElement("div"); content.className = "world-book-group-content collapsed";
    [...books].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN")).forEach((raw) => {
      const book = global.TukWorldBook.normalizeBook(raw); const item = document.createElement("div"); item.className = "list-item"; item.dataset.bookId = book.id;
      const title = document.createElement("div"); title.className = "item-title"; title.textContent = book.name;
      const body = document.createElement("div"); body.className = "item-content"; body.textContent = global.TukWorldBook.preview(book).slice(0, 50);
      const meta = document.createElement("div"); meta.className = "world-book-list-meta";
      const active = book.content.filter((entry) => entry.enabled).length;
      meta.append(`${active}/${book.content.length} 条`);
      if (book.globallyEnabled) { const badge = document.createElement("span"); badge.className = "world-book-badge"; badge.textContent = "全局"; meta.append(badge); }
      if (!book.enabled) { const badge = document.createElement("span"); badge.className = "world-book-badge world-book-status-off"; badge.textContent = "已关闭"; meta.append(badge); }
      item.append(title, body, meta);
      if (typeof global.addLongPressListener === "function") {
        global.addLongPressListener(item, async () => {
          const confirmed = await global.showCustomConfirm?.(
            "删除世界书",
            `确定要删除《${book.name}》吗？此操作不可撤销。`,
            { confirmButtonClass: "btn-danger" },
          );
          if (!confirmed) return;
          await global.TukWorldBook.deleteBooksAndReferences(global.db, [book.id]);
          global.state.worldBooks = global.state.worldBooks.filter((item) => item.id !== book.id);
          await global.renderWorldBookScreen();
        });
      }
      content.append(item);
    });
    group.append(header, content); return group;
  }

  async function importFile(file, source = "sillytavern") {
    const data = JSON.parse(await file.text());
    const books = global.TukWorldBook.parseImport(data, { source, name: file.name.replace(/\.(json|jsonl)$/i, "") });
    const problems = books.flatMap((book) => global.TukWorldBook.validateBook(book));
    if (problems.length) throw new Error(problems.join("\n"));
    const summary = `${books.length} 本世界书，共 ${books.reduce((sum, book) => sum + book.content.length, 0)} 个词条；将作为副本导入，不覆盖现有内容。`;
    const confirmed = await global.showCustomConfirm?.("确认导入", summary) ?? confirm(summary);
    if (!confirmed) return { imported: 0 };
    await global.db.worldBooks.bulkAdd(books); global.state.worldBooks.push(...books); await global.renderWorldBookScreen();
    return { imported: books.length, entries: books.reduce((sum, book) => sum + book.content.length, 0) };
  }

  async function readLegacyBooks() {
    const exists = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).some((item) => item.name === "GeminiChatDB") : await global.Dexie.exists("GeminiChatDB");
    if (!exists) return [];
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("GeminiChatDB"); request.onerror = () => reject(request.error);
      request.onsuccess = () => { const old = request.result;
        if (!old.objectStoreNames.contains("worldBooks")) { old.close(); resolve([]); return; }
        const transaction = old.transaction("worldBooks", "readonly"); const getAll = transaction.objectStore("worldBooks").getAll();
        getAll.onerror = () => { old.close(); reject(getAll.error); }; getAll.onsuccess = () => { old.close(); resolve(getAll.result || []); };
      };
    });
  }

  async function importLegacyDatabase() {
    const rawBooks = await readLegacyBooks();
    if (!rawBooks.length) { await global.showCustomAlert?.("没有可导入数据", "旧项目数据库中没有世界书。旧数据库未被修改。"); return; }
    const books = rawBooks.map((book) => global.TukWorldBook.normalizeBook({ ...book, id: undefined, source: { type: "legacy-database", originalId: book.id, importedAt: Date.now() } }));
    const count = books.reduce((sum, book) => sum + book.content.length, 0);
    const confirmed = await global.showCustomConfirm?.("从旧项目数据库导入", `检测到 ${books.length} 本世界书、${count} 个词条。将只读复制并转换为新 ID，不会修改旧项目，是否导入？`) ?? confirm("是否导入？");
    if (!confirmed) return;
    await global.db.worldBooks.bulkAdd(books); global.state.worldBooks.push(...books); await global.renderWorldBookScreen();
    await global.showCustomAlert?.("导入完成", `已导入 ${books.length} 本世界书、${count} 个词条。旧项目数据库未被修改。`);
  }

  async function exportCurrentBooks() {
    const books = (await global.db.worldBooks.toArray()).map(global.TukWorldBook.normalizeBook);
    if (!books.length) { await global.showCustomAlert?.("没有可导出数据", "当前项目还没有世界书。"); return; }
    const payload = { schema: "tuk-world-book", schemaVersion: 1, exportedAt: new Date().toISOString(), worldBooks: books };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `世界书-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runDiagnostics() {
    const books = await global.db.worldBooks.toArray(); const reports = global.TukWorldBook.diagnose(books);
    const invalid = reports.filter((report) => report.errors.length || report.shape === "非法结构");
    const legacy = reports.filter((report) => report.shape === "旧字符串");
    byId("world-book-diagnostic-summary").textContent = `共 ${reports.length} 本世界书；旧字符串结构 ${legacy.length} 本；非法或有错误 ${invalid.length} 本。${invalid.length ? "\n" + invalid.map((item) => `• ${item.name}: ${item.errors.join("、") || item.shape}`).join("\n") : "\n当前数据可以安全读取。"}`;
    return reports;
  }

  function renderLogs() {
    const logs = global.TukWorldBook.getLogs();
    byId("world-book-runtime-logs").textContent = logs.length ? logs.slice(0, 20).map((log) => `${new Date(log.timestamp).toLocaleTimeString()} · ${log.generationType} · ${log.tokenUsage} tokens · ${log.activated.join("、") || "无激活"}`).join("\n") : "暂无日志";
  }

  function bind() {
    byId("add-world-book-entry-btn")?.addEventListener("click", () => { byId("world-book-entries-container").append(createEntryCard(global.TukWorldBook.defaultEntry({ name: "新词条" }), true)); updateEntryCount(); });
    byId("world-book-enable-all-entries")?.addEventListener("click", () => { byId("world-book-entries-container").querySelectorAll(".entry-enabled-switch").forEach((input) => { input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); }); });
    byId("world-book-disable-all-entries")?.addEventListener("click", () => { byId("world-book-entries-container").querySelectorAll(".entry-enabled-switch").forEach((input) => { input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true })); }); });
    byId("world-book-search-input")?.addEventListener("input", (event) => { const query = event.target.value.trim().toLocaleLowerCase(); document.querySelectorAll("#world-book-list .list-item").forEach((item) => { item.hidden = query && !item.textContent.toLocaleLowerCase().includes(query); }); });
    byId("world-book-engine-enabled")?.addEventListener("change", async (event) => { global.state.globalSettings.worldBookEngineEnabled = event.target.checked; await global.db.globalSettings.put(global.state.globalSettings); });
    byId("world-book-tools-btn")?.addEventListener("click", async () => {
      byId("world-book-total-budget-input").value = global.state.globalSettings.worldBookTokenBudget || 4096;
      byId("world-book-include-names-switch").checked = global.state.globalSettings.worldBookIncludeNames !== false;
      byId("world-book-tools-modal").classList.add("visible"); await runDiagnostics(); renderLogs();
    });
    byId("world-book-tools-close")?.addEventListener("click", () => byId("world-book-tools-modal").classList.remove("visible"));
    byId("world-book-run-diagnostics")?.addEventListener("click", runDiagnostics);
    byId("world-book-repair-data")?.addEventListener("click", async () => { const confirmed = await global.showCustomConfirm?.("规范化当前项目数据", "只处理当前项目数据库，不读取或修改旧项目。现有字符串正文会安全转换为独立词条，是否继续？") ?? confirm("是否继续？"); if (!confirmed) return; const result = await global.TukWorldBook.normalizeDatabase(global.db); await global.renderWorldBookScreen(); await runDiagnostics(); await global.showCustomAlert?.("处理完成", `已规范化 ${result.changed} 本世界书。`); });
    byId("world-book-export-data")?.addEventListener("click", exportCurrentBooks);
    byId("world-book-import-legacy-db")?.addEventListener("click", importLegacyDatabase);
    byId("world-book-total-budget-input")?.addEventListener("change", async (event) => { global.state.globalSettings.worldBookTokenBudget = Math.max(0, Number(event.target.value) || 0); await global.db.globalSettings.put(global.state.globalSettings); });
    byId("world-book-include-names-switch")?.addEventListener("change", async (event) => { global.state.globalSettings.worldBookIncludeNames = event.target.checked; await global.db.globalSettings.put(global.state.globalSettings); });
    byId("world-book-run-test")?.addEventListener("click", () => { const value = byId("world-book-test-text").value; const books = (global.state.worldBooks || []).map(global.TukWorldBook.normalizeBook); const result = global.TukWorldBook.buildContext({ books, chat: { id: "world-book-test", name: "测试角色", settings: { linkedWorldBookIds: books.map((book) => book.id) }, history: [{ role: "user", content: value }] }, messages: [{ role: "user", content: value }], requestId: value, generationType: "normal" }); byId("world-book-test-results").textContent = `激活 ${result.activatedEntries.length} 条，约 ${result.tokenUsage} tokens${result.overflow ? "，存在预算溢出" : ""}\n` + result.activatedEntries.map((entry) => `✓ ${entry.bookName} / ${entry.name}：${entry.reason} → ${positionLabels[entry.position]}`).concat(result.rejectedEntries.slice(0, 80).map((entry) => `— ${entry.name}：${entry.reason}`)).join("\n"); renderLogs(); });
    byId("world-book-clear-logs")?.addEventListener("click", () => { global.TukWorldBook.clearLogs(); renderLogs(); });
    if (global.state?.globalSettings) byId("world-book-engine-enabled").checked = global.state.globalSettings.worldBookEngineEnabled !== false;
  }

  document.addEventListener("DOMContentLoaded", bind);
  global.TukWorldBookUI = { createEntryCard, createGroup, openEditor, saveEditor, importFile, importLegacyDatabase, exportCurrentBooks, runDiagnostics, updateEntryCount };
})(window);
