(function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    temperature: { enabled: true, value: 0.8 },
    topP: { enabled: false, value: 1 },
    maxOutputTokens: { enabled: false, value: 2048, openAIField: "auto" },
    frequencyPenalty: { enabled: false, value: 0 },
    presencePenalty: { enabled: false, value: 0 },
    topK: { enabled: false, value: 40 },
    seed: { enabled: false, value: 0 },
    stopSequences: { enabled: false, value: [] },
    custom: { enabled: false, value: {} },
  });

  const PARAM_META = Object.freeze({
    temperature: { min: 0, max: 2, kind: "number" },
    topP: { min: 0, max: 1, kind: "number" },
    maxOutputTokens: { min: 1, max: Number.MAX_SAFE_INTEGER, kind: "integer" },
    frequencyPenalty: { min: -2, max: 2, kind: "number" },
    presencePenalty: { min: -2, max: 2, kind: "number" },
    topK: { min: 1, max: Number.MAX_SAFE_INTEGER, kind: "integer" },
    seed: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, kind: "integer" },
  });

  const OPENAI_KEYS = Object.freeze({
    temperature: "temperature",
    topP: "top_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    seed: "seed",
    stopSequences: "stop",
  });

  const GEMINI_KEYS = Object.freeze({
    temperature: "temperature",
    topP: "topP",
    maxOutputTokens: "maxOutputTokens",
    frequencyPenalty: "frequencyPenalty",
    presencePenalty: "presencePenalty",
    topK: "topK",
    seed: "seed",
    stopSequences: "stopSequences",
  });

  const RESERVED_CUSTOM_KEYS = new Set([
    "model", "messages", "contents", "systemInstruction", "tools", "stream",
    "generationConfig", "temperature", "top_p", "topP", "top_k", "topK",
    "max_tokens", "max_completion_tokens", "maxOutputTokens", "frequency_penalty",
    "frequencyPenalty", "presence_penalty", "presencePenalty", "stop", "stopSequences", "seed",
  ]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function finiteNumber(value, fallback) {
    if (value === "" || value === null || typeof value === "undefined") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeValue(name, value, fallback) {
    if (name === "stopSequences") {
      const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
      return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
    }
    if (name === "custom") {
      return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};
    }
    const meta = PARAM_META[name];
    let number = finiteNumber(value, fallback);
    if (meta.kind === "integer") number = Math.trunc(number);
    return Math.min(meta.max, Math.max(meta.min, number));
  }

  function normalizeGenerationParams(raw, legacyTemperature) {
    const source = raw && typeof raw === "object" ? raw : {};
    const normalized = { schema: 1 };
    Object.keys(DEFAULTS).forEach((name) => {
      const defaults = DEFAULTS[name];
      const current = source[name] && typeof source[name] === "object" ? source[name] : {};
      const legacyValue = name === "temperature" ? finiteNumber(legacyTemperature, defaults.value) : defaults.value;
      normalized[name] = {
        enabled: typeof current.enabled === "boolean" ? current.enabled : defaults.enabled,
        value: normalizeValue(name, typeof current.value === "undefined" ? legacyValue : current.value, legacyValue),
      };
      if (name === "maxOutputTokens") {
        normalized[name].openAIField = ["auto", "max_tokens", "max_completion_tokens"].includes(current.openAIField)
          ? current.openAIField
          : defaults.openAIField;
      }
    });
    return normalized;
  }

  function normalizeApiConfig(apiConfig) {
    const config = apiConfig && typeof apiConfig === "object" ? apiConfig : {};
    if (!["auto", "openai", "gemini"].includes(config.apiProtocol)) config.apiProtocol = "auto";
    config.generationParams = normalizeGenerationParams(config.generationParams, config.temperature);
    config.temperature = config.generationParams.temperature.value;
    return config;
  }

  function resolveProtocol(apiConfig, url) {
    const config = apiConfig && typeof apiConfig === "object" ? apiConfig : {};
    if (config.apiProtocol === "openai" || config.apiProtocol === "gemini") return config.apiProtocol;
    const target = String(url || config.proxyUrl || "").toLowerCase();
    return target.includes("generativelanguage.googleapis.com") ? "gemini" : "openai";
  }

  function isGemini(url, apiConfig) {
    return resolveProtocol(apiConfig || window.state?.apiConfig, url) === "gemini";
  }

  function effectiveValue(params, name, overrides) {
    const entry = params[name];
    if (!entry?.enabled) return undefined;
    if (Object.prototype.hasOwnProperty.call(overrides || {}, name)) {
      return normalizeValue(name, overrides[name], entry.value);
    }
    return clone(entry.value);
  }

  function safeCustom(params) {
    if (!params.custom?.enabled) return {};
    return Object.fromEntries(
      Object.entries(params.custom.value || {}).filter(([key]) => !RESERVED_CUSTOM_KEYS.has(key)),
    );
  }

  function buildOpenAI(apiConfig, overrides = {}, constraints = {}) {
    const params = normalizeGenerationParams(apiConfig?.generationParams, apiConfig?.temperature);
    const result = safeCustom(params);
    Object.entries(OPENAI_KEYS).forEach(([name, requestKey]) => {
      const value = effectiveValue(params, name, overrides);
      if (typeof value !== "undefined") result[requestKey] = value;
    });
    const maxTokens = effectiveValue(params, "maxOutputTokens", overrides);
    if (typeof maxTokens !== "undefined") {
      const constrained = Number.isFinite(constraints.maxOutputTokens)
        ? Math.min(maxTokens, constraints.maxOutputTokens)
        : maxTokens;
      let key = params.maxOutputTokens.openAIField;
      if (key === "auto") key = constraints.preferLegacyMaxTokens ? "max_tokens" : "max_completion_tokens";
      result[key] = constrained;
    }
    return result;
  }

  function buildGemini(apiConfig, overrides = {}, constraints = {}) {
    const params = normalizeGenerationParams(apiConfig?.generationParams, apiConfig?.temperature);
    const result = safeCustom(params);
    Object.entries(GEMINI_KEYS).forEach(([name, requestKey]) => {
      let value = effectiveValue(params, name, overrides);
      if (typeof value === "undefined") return;
      if (name === "maxOutputTokens" && Number.isFinite(constraints.maxOutputTokens)) {
        value = Math.min(value, constraints.maxOutputTokens);
      }
      result[requestKey] = value;
    });
    return result;
  }

  function mergeOpenAIOptions(baseOptions, apiConfig, overrides = {}, constraints = {}) {
    const filtered = Object.fromEntries(
      Object.entries(baseOptions || {}).filter(([key]) => !RESERVED_CUSTOM_KEYS.has(key)),
    );
    return { ...filtered, ...buildOpenAI(apiConfig, overrides, constraints) };
  }

  function current(overrides = {}, constraints = {}, apiConfig) {
    const config = normalizeApiConfig(apiConfig || window.state?.apiConfig || {});
    return resolveProtocol(config) === "gemini"
      ? buildGemini(config, overrides, constraints)
      : buildOpenAI(config, overrides, constraints);
  }

  function parameterMarkup(name, title, control, note = "") {
    return `<div class="api-generation-param" data-generation-param="${name}">
      <div class="api-generation-param-head">
        <label class="api-generation-mini-toggle" aria-label="启用${title}"><input id="generation-param-${name}-enabled" data-generation-toggle="${name}" type="checkbox"><span></span></label>
        <div class="api-generation-param-title"><strong>${title}</strong><span class="api-generation-param-status">由渠道决定</span></div>
        <button class="api-generation-reset" data-generation-reset="${name}" type="button">重置</button>
      </div>${control}${note ? `<p class="api-generation-compatibility">${note}</p>` : ""}
    </div>`;
  }

  function rangeControl(name, min, max, step, value, label) {
    return `<div class="api-generation-control">
      <input id="generation-param-${name}" data-generation-range="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" class="moe-slider">
      <input id="generation-param-${name}-value" data-generation-number="${name}" class="moe-input api-generation-number" type="number" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
    </div>`;
  }

  function ensureFormMarkup() {
    const host = document.getElementById("api-generation-params");
    if (!host || host.children.length) return host;
    const number = (name, value, min = "", step = "1") =>
      `<input id="generation-param-${name}" class="moe-input" type="number" ${min === "" ? "" : `min="${min}"`} step="${step}" value="${value}">`;
    const textarea = (name, placeholder) =>
      `<textarea id="generation-param-${name}" class="moe-input api-generation-textarea" placeholder="${placeholder}"></textarea>`;
    host.innerHTML = `<div class="api-generation-heading">
      <div class="api-generation-heading-main"><strong>生成参数</strong><p class="api-generation-help">关闭某项后，请求中将完全省略该属性。</p></div>
      <button id="reset-all-generation-params" class="api-generation-reset-all" type="button">全部重置</button>
    </div>
    <div class="api-generation-protocol"><label for="api-protocol-select">接口协议</label>
      <select id="api-protocol-select" class="moe-input"><option value="auto">自动识别</option><option value="openai">OpenAI 兼容</option><option value="gemini">Gemini</option></select>
      <p class="api-generation-help">自定义 Gemini 代理建议手动选择 Gemini。</p>
    </div>
    ${parameterMarkup("temperature", "温度（随机性）", rangeControl("temperature", 0, 2, 0.1, 0.8, "温度值"))}
    <details class="api-generation-advanced"><summary>更多可调属性</summary>
      ${parameterMarkup("topP", "Top P（核采样）", rangeControl("topP", 0, 1, 0.05, 1, "Top P 值"), "通常只调整温度或 Top P 其中一项。")}
      ${parameterMarkup("maxOutputTokens", "最大输出 Token", `${number("maxOutputTokens", 2048, 1)}<select id="generation-param-maxOutputTokens-field" class="moe-input api-generation-token-field" aria-label="OpenAI Token 字段"><option value="auto">OpenAI 字段：自动</option><option value="max_completion_tokens">使用 max_completion_tokens</option><option value="max_tokens">使用 max_tokens（旧兼容）</option></select>`)}
      ${parameterMarkup("frequencyPenalty", "频率惩罚", rangeControl("frequencyPenalty", -2, 2, 0.1, 0, "频率惩罚值"))}
      ${parameterMarkup("presencePenalty", "存在惩罚", rangeControl("presencePenalty", -2, 2, 0.1, 0, "存在惩罚值"))}
      ${parameterMarkup("topK", "Top K", number("topK", 40, 1), "Gemini 原生支持；OpenAI 兼容渠道不一定支持。")}
      ${parameterMarkup("seed", "随机种子", number("seed", 0))}
      ${parameterMarkup("stopSequences", "停止序列", textarea("stopSequences", "每行一个停止序列"))}
      ${parameterMarkup("custom", "自定义参数 JSON", textarea("custom", "例如：{&quot;min_p&quot;: 0.1}"), "仅填写渠道文档明确支持的请求参数。")}
    </details>`;
    return host;
  }

  function element(id) {
    return document.getElementById(id);
  }

  function setFieldState(name) {
    const enabled = element(`generation-param-${name}-enabled`);
    const row = enabled?.closest(".api-generation-param");
    if (!enabled || !row) return;
    row.classList.toggle("is-disabled", !enabled.checked);
    row.querySelectorAll("input:not([type='checkbox']), select, textarea").forEach((control) => {
      control.disabled = !enabled.checked;
    });
    const status = row.querySelector(".api-generation-param-status");
    if (status) status.textContent = enabled.checked ? "随请求发送" : "由渠道决定";
  }

  function updateRangeValue(name) {
    const input = element(`generation-param-${name}`);
    const output = element(`generation-param-${name}-value`);
    if (input && output) {
      if ("value" in output) output.value = input.value;
      else output.textContent = input.value;
    }
  }

  function renderForm(apiConfig) {
    ensureFormMarkup();
    const config = normalizeApiConfig(apiConfig);
    if (element("api-protocol-select")) element("api-protocol-select").value = config.apiProtocol;
    Object.keys(DEFAULTS).forEach((name) => {
      const entry = config.generationParams[name];
      const enabled = element(`generation-param-${name}-enabled`);
      const input = element(`generation-param-${name}`);
      if (enabled) enabled.checked = entry.enabled;
      if (input) {
        if (name === "stopSequences") input.value = entry.value.join("\n");
        else if (name === "custom") input.value = Object.keys(entry.value).length ? JSON.stringify(entry.value, null, 2) : "";
        else input.value = entry.value;
      }
      if (name === "maxOutputTokens" && element("generation-param-maxOutputTokens-field")) {
        element("generation-param-maxOutputTokens-field").value = entry.openAIField;
      }
      updateRangeValue(name);
      setFieldState(name);
    });
  }

  function readForm(apiConfig) {
    const base = normalizeApiConfig(apiConfig || {});
    const raw = {};
    Object.keys(DEFAULTS).forEach((name) => {
      const enabled = element(`generation-param-${name}-enabled`);
      const input = element(`generation-param-${name}`);
      let value = input ? input.value : base.generationParams[name].value;
      if (PARAM_META[name]) {
        const number = Number(value);
        const meta = PARAM_META[name];
        if (value === "" || !Number.isFinite(number)) {
          throw new Error(`${input?.closest(".api-generation-param")?.querySelector("strong")?.textContent || name} 必须填写有效数字。`);
        }
        if (number < meta.min || number > meta.max || (meta.kind === "integer" && !Number.isInteger(number))) {
          throw new Error(`${input?.closest(".api-generation-param")?.querySelector("strong")?.textContent || name} 超出允许范围。`);
        }
      }
      if (name === "custom") {
        if (String(value).trim()) {
          try {
            value = JSON.parse(value);
          } catch (_error) {
            throw new Error("自定义参数必须是合法的 JSON 对象。");
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("自定义参数必须填写 JSON 对象，不能填写数组或单个值。");
          }
          const blocked = Object.keys(value).filter((key) => RESERVED_CUSTOM_KEYS.has(key));
          if (blocked.length) throw new Error(`自定义参数不能覆盖保留字段：${blocked.join("、")}`);
        } else {
          value = {};
        }
      }
      raw[name] = { enabled: enabled ? enabled.checked : base.generationParams[name].enabled, value };
      if (name === "maxOutputTokens") {
        raw[name].openAIField = element("generation-param-maxOutputTokens-field")?.value || "auto";
      }
    });
    const normalized = normalizeGenerationParams(raw, base.temperature);
    base.apiProtocol = element("api-protocol-select")?.value || base.apiProtocol;
    base.generationParams = normalized;
    base.temperature = normalized.temperature.value;
    return base;
  }

  function resetField(name, resetEnabled = false) {
    const defaults = DEFAULTS[name];
    const enabled = element(`generation-param-${name}-enabled`);
    const input = element(`generation-param-${name}`);
    if (resetEnabled && enabled) enabled.checked = defaults.enabled;
    if (input) {
      if (name === "stopSequences" || name === "custom") input.value = "";
      else input.value = defaults.value;
    }
    if (name === "maxOutputTokens" && element("generation-param-maxOutputTokens-field")) {
      element("generation-param-maxOutputTokens-field").value = defaults.openAIField;
    }
    updateRangeValue(name);
    setFieldState(name);
  }

  function bindForm() {
    const host = ensureFormMarkup();
    if (!host || host.dataset.bound === "true") return;
    host.dataset.bound = "true";
    host.addEventListener("input", (event) => {
      const name = event.target.dataset.generationRange;
      if (name) updateRangeValue(name);
      const numberName = event.target.dataset.generationNumber;
      if (numberName) {
        const range = element(`generation-param-${numberName}`);
        if (range) range.value = event.target.value;
      }
    });
    host.addEventListener("change", (event) => {
      const name = event.target.dataset.generationToggle;
      if (name) setFieldState(name);
    });
    host.addEventListener("click", (event) => {
      const reset = event.target.closest("[data-generation-reset]");
      if (reset) resetField(reset.dataset.generationReset, false);
      if (event.target.closest("#reset-all-generation-params")) {
        Object.keys(DEFAULTS).forEach((name) => resetField(name, true));
        if (element("api-protocol-select")) element("api-protocol-select").value = "auto";
      }
    });
  }

  window.ApiGenerationParams = {
    DEFAULTS,
    normalizeApiConfig,
    normalizeGenerationParams,
    resolveProtocol,
    isGemini,
    openAI: (overrides, constraints, apiConfig) => buildOpenAI(
      normalizeApiConfig(apiConfig || window.state?.apiConfig || {}), overrides, constraints,
    ),
    gemini: (overrides, constraints, apiConfig) => buildGemini(
      normalizeApiConfig(apiConfig || window.state?.apiConfig || {}), overrides, constraints,
    ),
    mergeOpenAI: (baseOptions, overrides, constraints, apiConfig) => mergeOpenAIOptions(
      baseOptions,
      normalizeApiConfig(apiConfig || window.state?.apiConfig || {}),
      overrides,
      constraints,
    ),
    current,
    renderForm,
    readForm,
    resetField,
    bindForm,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindForm, { once: true });
  else bindForm();
})();
