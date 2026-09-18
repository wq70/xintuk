(() => {
  const DEVICE_SOURCE = "device";
  const ZONE_SOURCE = "timezone";
  const CUSTOM_SOURCE = "custom";
  const VALID_SOURCES = new Set([DEVICE_SOURCE, ZONE_SOURCE, CUSTOM_SOURCE]);
  const VALID_GAP_MODES = new Set(["precise", "soft", "off"]);
  const COMMON_TIME_ZONES = [
    ["Asia/Shanghai", "上海 / 北京（中国标准时间）"],
    ["Asia/Hong_Kong", "香港"],
    ["Asia/Taipei", "台北"],
    ["Asia/Tokyo", "东京"],
    ["Asia/Seoul", "首尔"],
    ["Asia/Singapore", "新加坡"],
    ["Europe/London", "伦敦"],
    ["Europe/Paris", "巴黎"],
    ["Europe/Berlin", "柏林"],
    ["America/New_York", "纽约"],
    ["America/Chicago", "芝加哥"],
    ["America/Denver", "丹佛"],
    ["America/Los_Angeles", "洛杉矶"],
    ["America/Toronto", "多伦多"],
    ["Australia/Sydney", "悉尼"],
    ["Pacific/Auckland", "奥克兰"],
    ["UTC", "UTC"],
  ];

  function getDeviceTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  function isValidTimeZone(timeZone) {
    if (!timeZone) return false;
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone }).format();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getTimeZones() {
    const deviceZone = getDeviceTimeZone();
    let zones = [];
    try {
      zones = typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [];
    } catch (_error) {
      zones = [];
    }
    const fallbacks = COMMON_TIME_ZONES.map(([zone]) => zone);
    return Array.from(new Set([deviceZone, ...fallbacks, ...zones])).sort();
  }

  function normalizeClockConfig(config, fallback = {}) {
    const source = VALID_SOURCES.has(config?.source)
      ? config.source
      : fallback.source || DEVICE_SOURCE;
    const requestedZone = config?.timeZone || fallback.timeZone || getDeviceTimeZone();
    return {
      source,
      timeZone: isValidTimeZone(requestedZone) ? requestedZone : getDeviceTimeZone(),
      customTime: typeof config?.customTime === "string"
        ? config.customTime
        : fallback.customTime || "",
    };
  }

  function getUserConfig(state) {
    return normalizeClockConfig(state?.qzoneSettings?.timeContext, {
      source: DEVICE_SOURCE,
      timeZone: getDeviceTimeZone(),
      customTime: "",
    });
  }

  function getChatConfig(chat) {
    const modern = chat?.settings?.timeContext;
    const legacyCustomTime = chat?.settings?.customTime || "";
    const legacySource =
      chat?.settings?.timePerceptionEnabled === false && legacyCustomTime
        ? CUSTOM_SOURCE
        : DEVICE_SOURCE;
    const clock = normalizeClockConfig(modern, {
      source: legacySource,
      timeZone: getDeviceTimeZone(),
      customTime: legacyCustomTime,
    });
    return {
      enabled: modern?.enabled ?? true,
      ...clock,
      gapAwareness: VALID_GAP_MODES.has(modern?.gapAwareness)
        ? modern.gapAwareness
        : "precise",
      customPrompt:
        typeof modern?.customPrompt === "string" ? modern.customPrompt : "",
    };
  }

  function getMemberConfig(member, state, groupChat) {
    const linkedChat = member?.id ? state?.chats?.[member.id] : null;
    if (linkedChat && !linkedChat.isGroup) return getChatConfig(linkedChat);
    return {
      enabled: member?.timeContext?.enabled ?? true,
      ...normalizeClockConfig(member?.timeContext, getChatConfig(groupChat)),
    };
  }

  function parsePlainDateTime(value) {
    const match = String(value || "").match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/,
    );
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    const date = new Date(
      Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5] || 0),
    );
    if (
      date.getUTCFullYear() !== parts[0] ||
      date.getUTCMonth() !== parts[1] - 1 ||
      date.getUTCDate() !== parts[2] ||
      date.getUTCHours() !== parts[3] ||
      date.getUTCMinutes() !== parts[4]
    ) {
      return null;
    }
    return date;
  }

  function formatDateTime(date, timeZone) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function resolveClock(config, now = Date.now()) {
    const normalized = normalizeClockConfig(config);
    if (normalized.source === CUSTOM_SOURCE) {
      const plainDate = parsePlainDateTime(normalized.customTime);
      if (plainDate) {
        return {
          ...normalized,
          formatted: formatDateTime(plainDate, "UTC"),
          effectiveTimeZone: normalized.timeZone,
          isCustom: true,
          usedFallback: false,
        };
      }
    }
    const effectiveTimeZone =
      normalized.source === ZONE_SOURCE
        ? normalized.timeZone
        : getDeviceTimeZone();
    return {
      ...normalized,
      formatted: formatDateTime(new Date(now), effectiveTimeZone),
      effectiveTimeZone,
      isCustom: false,
      usedFallback: normalized.source === CUSTOM_SOURCE,
    };
  }

  function isEffectiveMessage(message) {
    return Boolean(
      message &&
        !message.isHidden &&
        !message.isTemporary &&
        message.type !== "summary" &&
        (message.role === "user" || message.role === "assistant") &&
        message.timestamp !== null &&
        typeof message.timestamp !== "undefined" &&
        Number.isFinite(Number(message.timestamp)),
    );
  }

  function getLastInteraction(chat, excludeTrailingUserMessages) {
    const messages = (chat?.history || []).filter(isEffectiveMessage);
    let index = messages.length - 1;
    if (
      excludeTrailingUserMessages &&
      index >= 0 &&
      messages[index].role === "user"
    ) {
      const latestUserTimestamp = Number(messages[index].timestamp);
      while (
        index >= 0 &&
        messages[index].role === "user" &&
        latestUserTimestamp - Number(messages[index].timestamp) <= 5 * 60000
      ) {
        index -= 1;
      }
    }
    return index >= 0 ? messages[index] : null;
  }

  function buildGapLine(
    chat,
    mode,
    now,
    excludeTrailingUserMessages,
    contextMode,
  ) {
    if (mode === "off") return "";
    const lastMessage = getLastInteraction(chat, excludeTrailingUserMessages);
    if (!lastMessage) return "- 对话间隔：这是你们的第一次有效对话。";
    const diffMinutes = Math.max(
      0,
      Math.floor((now - Number(lastMessage.timestamp)) / 60000),
    );
    if (
      mode === "precise" &&
      (contextMode === "background" || contextMode === "group_background")
    ) {
      return `- 对话间隔：已经有${diffMinutes}分钟没有互动。`;
    }
    if (mode === "soft") {
      if (diffMinutes < 5) return "- 对话间隔：对话正在连续进行。";
      if (diffMinutes < 60) return "- 对话间隔：你们刚才聊过。";
      if (diffMinutes < 8 * 60) return "- 对话间隔：你们隔了一会儿没有互动。";
      if (diffMinutes < 24 * 60) return "- 对话间隔：你们有一阵没有互动。";
      if (diffMinutes < 7 * 24 * 60) return "- 对话间隔：你们有几天没有聊天。";
      if (diffMinutes < 30 * 24 * 60) return "- 对话间隔：你们有段时间没有联系。";
      return "- 对话间隔：你们已经很久没有联系。";
    }
    if (diffMinutes < 5) return "- 对话间隔：你们的对话刚刚还在继续。";
    if (diffMinutes < 60) return `- 对话间隔：你们在${diffMinutes}分钟前聊过。`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `- 对话间隔：你们在${diffHours}小时前聊过。`;
    return `- 对话间隔：你们已经有${Math.floor(diffHours / 24)}天没有聊天了。`;
  }

  function buildContext({ chat, state, mode = "chat", now = Date.now() }) {
    const chatConfig = getChatConfig(chat);
    if (!chatConfig.enabled) {
      return { prompt: "", character: null, user: null, gapLine: "" };
    }
    const user = resolveClock(getUserConfig(state), now);
    const excludeTrailingUserMessages = mode === "chat" || mode === "offline";
    const gapLine = buildGapLine(
      chat,
      chatConfig.gapAwareness,
      now,
      excludeTrailingUserMessages,
      mode,
    );
    const lines = ["# 时间上下文（低优先级环境信息）"];
    lines.push(
      `- 用户当地时间：${user.formatted}（${user.effectiveTimeZone}${user.isCustom ? "，自定义固定时间" : ""}）`,
    );
    let character = null;
    if (chat?.isGroup) {
      for (const member of chat.members || []) {
        const memberConfig = getMemberConfig(member, state, chat);
        if (memberConfig.enabled === false) continue;
        const memberClock = resolveClock(memberConfig, now);
        lines.push(
          `- 群成员“${member.originalName || member.groupNickname}”当地时间：${memberClock.formatted}（${memberClock.effectiveTimeZone}${memberClock.isCustom ? "，自定义固定时间" : ""}）`,
        );
      }
    } else {
      character = resolveClock(chatConfig, now);
      lines.push(
        `- 角色当地时间：${character.formatted}（${character.effectiveTimeZone}${character.isCustom ? "，自定义固定时间" : ""}）`,
      );
      lines.push("- 判断角色作息时必须使用角色当地时间，不得把用户当地时间当作角色时间。");
    }
    if (gapLine) lines.push(gapLine);
    lines.push(
      "- 除非用户主动谈论时间、作息或时间确实影响当前事件，否则不要刻意复述时间或时差。",
      "- 始终优先回应用户刚刚发送的内容，不得仅因长时间未聊天而责备、质问或反复强调用户消失。",
    );
    if (chatConfig.customPrompt.trim()) {
      lines.push("- 用户自定义时间感知规则：", chatConfig.customPrompt.trim());
    }
    return { prompt: lines.join("\n"), character, user, gapLine };
  }

  function fillTimeZoneSelect(select, selectedValue) {
    if (!select) return;
    const selected = isValidTimeZone(selectedValue) ? selectedValue : getDeviceTimeZone();
    if (!select.dataset.populated) {
      const fragment = document.createDocumentFragment();
      const commonGroup = document.createElement("optgroup");
      commonGroup.label = "常用时区";
      const commonSet = new Set();
      const deviceZone = getDeviceTimeZone();
      const prioritized = [
        [deviceZone, `当前设备 · ${deviceZone}`],
        ...COMMON_TIME_ZONES,
      ];
      for (const [zone, label] of prioritized) {
        if (commonSet.has(zone) || !isValidTimeZone(zone)) continue;
        commonSet.add(zone);
        const option = document.createElement("option");
        option.value = zone;
        option.textContent = `${label} · ${zone}`;
        commonGroup.appendChild(option);
      }
      fragment.appendChild(commonGroup);
      const allGroup = document.createElement("optgroup");
      allGroup.label = "全部时区";
      for (const zone of getTimeZones()) {
        if (commonSet.has(zone)) continue;
        const option = document.createElement("option");
        option.value = zone;
        option.textContent = zone;
        allGroup.appendChild(option);
      }
      fragment.appendChild(allGroup);
      select.replaceChildren(fragment);
      select.dataset.populated = "true";
    }
    if (![...select.options].some((option) => option.value === selected)) {
      select.add(new Option(selected, selected));
    }
    select.value = selected;
  }

  function ensureSettingsMarkup() {
    const host = document.getElementById("time-context-settings-host");
    if (!host || document.getElementById("time-context-settings")) return;
    host.innerHTML = `
      <div id="time-context-settings" class="time-context-settings">
        <p class="time-context-help">用户与角色的时间相互独立；关闭后不会向角色提供系统时间、时区或聊天间隔。</p>
        <div class="time-context-section">
          <div class="time-context-section-title">我的时间</div>
          <label for="user-time-source-select">时间来源</label>
          <select id="user-time-source-select" class="moe-input">
            <option value="device">跟随本地设备</option>
            <option value="timezone">选择时区</option>
            <option value="custom">自定义固定时间</option>
          </select>
          <div id="user-timezone-container" hidden><label for="user-timezone-select">我的时区</label><select id="user-timezone-select" class="moe-input"></select></div>
          <div id="user-custom-time-container" hidden><label for="user-custom-time-input">自定义时间</label><input type="datetime-local" id="user-custom-time-input" class="moe-input" /></div>
        </div>
        <div id="character-time-section" class="time-context-section">
          <div class="time-context-section-title">角色时间</div>
          <label for="character-time-source-select">时间来源</label>
          <select id="character-time-source-select" class="moe-input">
            <option value="device">跟随本地设备</option>
            <option value="timezone">选择时区</option>
            <option value="custom">自定义固定时间</option>
          </select>
          <div id="character-timezone-container" hidden><label for="character-timezone-select">角色时区</label><select id="character-timezone-select" class="moe-input"></select></div>
          <div id="custom-time-container" hidden><label for="custom-time-input">自定义时间</label><input type="datetime-local" id="custom-time-input" class="moe-input" /></div>
        </div>
        <p id="group-member-time-hint" class="time-context-help" hidden>群成员时间可在群成员编辑中分别设置；关联已有角色的成员会自动使用该角色的时间设置。</p>
        <div class="time-context-section">
          <label for="gap-awareness-select">聊天间隔感知</label>
          <select id="gap-awareness-select" class="moe-input"><option value="precise">精确时间</option><option value="soft">柔和描述</option><option value="off">不提供聊天间隔</option></select>
          <label for="time-context-custom-prompt">自定义时间感知规则（可选）</label>
          <textarea id="time-context-custom-prompt" class="moe-input time-context-prompt" rows="3" placeholder="例如：除非我主动问起，否则不要提及时间或时差。"></textarea>
        </div>
        <details class="time-context-preview-box"><summary>预览提供给角色的时间上下文</summary><pre id="time-context-preview"></pre></details>
      </div>`;
  }

  function ensureMemberMarkup() {
    const host = document.getElementById("member-time-settings-host");
    if (!host || document.getElementById("member-time-controls")) return;
    host.innerHTML = `
      <div class="form-group time-context-section">
        <div class="time-context-section-title">成员时间</div>
        <p id="member-time-link-note" class="time-context-help" hidden></p>
        <div id="member-time-controls">
          <label class="toggle-switch-label time-context-member-toggle"><span class="toggle-switch-text">提供该成员时间</span><input type="checkbox" id="member-time-enabled" checked /><span class="toggle-switch-slider"></span></label>
          <div id="member-time-clock-fields">
            <label for="member-time-source-select">时间来源</label>
            <select id="member-time-source-select" class="moe-input"><option value="device">跟随本地设备</option><option value="timezone">选择时区</option><option value="custom">自定义固定时间</option></select>
            <div id="member-timezone-container" hidden><label for="member-timezone-select">成员时区</label><select id="member-timezone-select" class="moe-input"></select></div>
            <div id="member-custom-time-container" hidden><label for="member-custom-time-input">自定义时间</label><input type="datetime-local" id="member-custom-time-input" class="moe-input" /></div>
          </div>
        </div>
      </div>`;
  }

  function readClockForm(prefix) {
    return normalizeClockConfig({
      source: document.getElementById(`${prefix}-time-source-select`)?.value,
      timeZone: document.getElementById(`${prefix}-timezone-select`)?.value,
      customTime: document.getElementById(`${prefix}-custom-time-input`)?.value,
    });
  }

  function updateFormVisibility() {
    const enabled = document.getElementById("time-perception-toggle")?.checked ?? true;
    const settings = document.getElementById("time-context-settings");
    if (settings) settings.hidden = !enabled;
    for (const prefix of ["user", "character", "member"]) {
      const source = document.getElementById(`${prefix}-time-source-select`)?.value;
      const zoneContainer = document.getElementById(`${prefix}-timezone-container`);
      const customContainer = document.getElementById(
        prefix === "character" ? "custom-time-container" : `${prefix}-custom-time-container`,
      );
      if (zoneContainer) zoneContainer.hidden = source === DEVICE_SOURCE;
      if (customContainer) customContainer.hidden = source !== CUSTOM_SOURCE;
    }
    const memberFields = document.getElementById("member-time-clock-fields");
    const memberEnabled = document.getElementById("member-time-enabled");
    if (memberFields && memberEnabled) memberFields.hidden = !memberEnabled.checked;
  }

  function updatePreview(chat, state) {
    const preview = document.getElementById("time-context-preview");
    if (!preview || !chat) return;
    const originalUser = state.qzoneSettings.timeContext;
    const originalChat = chat.settings.timeContext;
    try {
      state.qzoneSettings.timeContext = readClockForm("user");
      chat.settings.timeContext = {
        enabled: document.getElementById("time-perception-toggle").checked,
        ...readClockForm("character"),
        gapAwareness:
          document.getElementById("gap-awareness-select")?.value || "precise",
        customPrompt:
          document.getElementById("time-context-custom-prompt")?.value || "",
      };
      const context = buildContext({ chat, state });
      preview.textContent = context.prompt || "关闭后不会向角色提供系统时间、时区或聊天间隔。";
    } finally {
      if (typeof originalUser === "undefined") {
        delete state.qzoneSettings.timeContext;
      } else {
        state.qzoneSettings.timeContext = originalUser;
      }
      if (typeof originalChat === "undefined") {
        delete chat.settings.timeContext;
      } else {
        chat.settings.timeContext = originalChat;
      }
    }
  }

  function loadSettingsForm(chat, state) {
    if (!chat || !state?.qzoneSettings) return;
    ensureSettingsMarkup();
    const user = getUserConfig(state);
    const character = getChatConfig(chat);
    document.getElementById("time-perception-toggle").checked = character.enabled;
    document.getElementById("user-time-source-select").value = user.source;
    document.getElementById("user-custom-time-input").value = user.customTime;
    fillTimeZoneSelect(document.getElementById("user-timezone-select"), user.timeZone);
    document.getElementById("character-time-source-select").value = character.source;
    document.getElementById("custom-time-input").value = character.customTime;
    fillTimeZoneSelect(
      document.getElementById("character-timezone-select"),
      character.timeZone,
    );
    document.getElementById("gap-awareness-select").value = character.gapAwareness;
    document.getElementById("time-context-custom-prompt").value = character.customPrompt;
    const characterSection = document.getElementById("character-time-section");
    const groupHint = document.getElementById("group-member-time-hint");
    if (characterSection) characterSection.hidden = Boolean(chat.isGroup);
    if (groupHint) groupHint.hidden = !chat.isGroup;
    updateFormVisibility();
    updatePreview(chat, state);
  }

  async function saveSettingsForm(chat, state, db) {
    if (!chat || !state?.qzoneSettings) return;
    state.qzoneSettings.timeContext = readClockForm("user");
    chat.settings.timeContext = {
      enabled: document.getElementById("time-perception-toggle").checked,
      ...readClockForm("character"),
      gapAwareness:
        document.getElementById("gap-awareness-select")?.value || "precise",
      customPrompt:
        document.getElementById("time-context-custom-prompt")?.value.trim() || "",
    };
    chat.settings.timePerceptionEnabled = chat.settings.timeContext.enabled;
    chat.settings.customTime = chat.settings.timeContext.customTime;
    await db?.qzoneSettings?.put(state.qzoneSettings);
  }

  function loadMemberSettings(member, state, groupChat) {
    ensureMemberMarkup();
    const config = getMemberConfig(member, state, groupChat);
    document.getElementById("member-time-enabled").checked = config.enabled !== false;
    document.getElementById("member-time-source-select").value = config.source;
    document.getElementById("member-custom-time-input").value = config.customTime || "";
    fillTimeZoneSelect(
      document.getElementById("member-timezone-select"),
      config.timeZone,
    );
    const linked = Boolean(member?.id && state?.chats?.[member.id] && !state.chats[member.id].isGroup);
    const note = document.getElementById("member-time-link-note");
    if (note) {
      note.hidden = !linked;
      note.textContent = linked
        ? "该成员关联已有角色，群聊会自动使用角色聊天中的时间设置。"
        : "";
    }
    const controls = document.getElementById("member-time-controls");
    if (controls) controls.hidden = linked;
    updateFormVisibility();
  }

  function saveMemberSettings(member, state) {
    const linked = Boolean(member?.id && state?.chats?.[member.id] && !state.chats[member.id].isGroup);
    if (!linked) {
      member.timeContext = {
        enabled: document.getElementById("member-time-enabled").checked,
        ...readClockForm("member"),
      };
    }
  }

  function bindSettingsUI(getActiveChat, getState) {
    ensureSettingsMarkup();
    ensureMemberMarkup();
    const ids = [
      "time-perception-toggle",
      "user-time-source-select",
      "user-timezone-select",
      "user-custom-time-input",
      "character-time-source-select",
      "character-timezone-select",
      "custom-time-input",
      "gap-awareness-select",
      "time-context-custom-prompt",
      "member-time-source-select",
      "member-time-enabled",
      "member-timezone-select",
      "member-custom-time-input",
    ];
    for (const id of ids) {
      const element = document.getElementById(id);
      if (!element || element.dataset.timeContextBound) continue;
      const eventName = element.tagName === "TEXTAREA" || element.tagName === "INPUT"
        ? "input"
        : "change";
      element.addEventListener(eventName, () => {
        updateFormVisibility();
        updatePreview(getActiveChat(), getState());
      });
      element.dataset.timeContextBound = "true";
    }
  }

  window.TukTimeContext = {
    buildContext,
    getChatConfig,
    getDeviceTimeZone,
    getUserConfig,
    loadMemberSettings,
    loadSettingsForm,
    saveMemberSettings,
    saveSettingsForm,
    bindSettingsUI,
  };
})();
