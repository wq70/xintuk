/* Unified media capability layer. Loaded after the legacy application so old
 * entry points remain available while newer providers can share safe helpers. */
(function initMediaIntegration() {
  "use strict";

  const POLLINATIONS_MODELS_URL = "https://gen.pollinations.ai/image/models";
  const POLLINATIONS_IMAGE_URL = "https://gen.pollinations.ai/image/";
  const LEGACY_POLLINATIONS_URL = "https://pollinations.ai/p/";
  const MEDIA_REQUEST_TIMEOUT = 90000;
  const MEDIA_MAX_RETRIES = 3;
  const MINIMAX_MODELS = [
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
    "speech-01-hd",
    "speech-01-turbo",
  ];
  const MINIMAX_SOUND_TAGS = new Set([
    "laughs", "chuckle", "coughs", "clear-throat", "groans", "breath",
    "pant", "inhale", "exhale", "gasps", "sniffs", "sighs", "snorts",
    "burps", "lip-smacking", "humming", "hissing", "emm", "whistles",
    "sneezes", "crying", "applause",
  ]);

  let minimaxVoiceCache = [];
  let naiVibes = [];

  function element(id) {
    return document.getElementById(id);
  }

  function setStatus(id, message, type = "") {
    const target = element(id);
    if (!target) return;
    target.textContent = message || "";
    target.classList.toggle("is-error", type === "error");
    target.classList.toggle("is-success", type === "success");
  }

  function readNumber(id, fallback) {
    const value = Number(element(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function setValue(id, value) {
    const target = element(id);
    if (target && value !== undefined && value !== null) target.value = String(value);
  }

  function setChecked(id, value) {
    const target = element(id);
    if (target) target.checked = Boolean(value);
  }

  function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlFromFile(file) {
    return dataUrlFromBlob(file);
  }

  function withTimeout(timeoutMs, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    const abort = () => controller.abort(externalSignal?.reason || new Error("请求已取消"));
    if (externalSignal) {
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener("abort", abort, { once: true });
    }
    return {
      signal: controller.signal,
      clear() {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
      },
    };
  }

  function retryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function fetchWithRetry(url, init = {}, retryOptions = {}) {
    const maxRetries = retryOptions.maxRetries ?? MEDIA_MAX_RETRIES;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timeout = withTimeout(retryOptions.timeout ?? MEDIA_REQUEST_TIMEOUT, init.signal);
      try {
        const response = await fetch(url, { ...init, signal: timeout.signal });
        if (response.ok || !retryableStatus(response.status) || attempt === maxRetries) {
          return response;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 15000)
          : Math.min(750 * 2 ** attempt + Math.random() * 300, 8000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        lastError = error;
        if (init.signal?.aborted || attempt === maxRetries) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(750 * 2 ** attempt + Math.random() * 300, 8000)),
        );
      } finally {
        timeout.clear();
      }
    }
    throw lastError || new Error("请求失败");
  }

  function pollinationsConfig() {
    const config = window.state?.apiConfig ||
      (typeof state !== "undefined" ? state.apiConfig : {}) || {};
    return {
      apiKey: config.pollinationsApiKey || "",
      model: config.pollinationsModel || "flux",
      width: config.pollinationsWidth || 1024,
      height: config.pollinationsHeight || 1024,
      seed: config.pollinationsSeed ?? -1,
      quality: config.pollinationsQuality || "medium",
      negativePrompt: config.pollinationsNegativePrompt || "",
      enhance: Boolean(config.pollinationsEnhance),
      transparent: Boolean(config.pollinationsTransparent),
      safe: config.pollinationsSafe || "",
      legacyFallback: config.pollinationsLegacyFallback !== false,
    };
  }

  function appendQuery(params, key, value) {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  }

  async function generatePollinationsImage(prompt, options = {}) {
    if (!String(prompt || "").trim()) throw new Error("生图提示词不能为空");
    const config = pollinationsConfig();
    const model = options.model || config.model;
    const seed = options.seed ?? (config.seed === -1
      ? Math.floor(Math.random() * 2147483647)
      : config.seed);
    const params = new URLSearchParams();
    appendQuery(params, "model", model);
    appendQuery(params, "width", options.width ?? config.width);
    appendQuery(params, "height", options.height ?? config.height);
    appendQuery(params, "seed", seed);
    appendQuery(params, "quality", options.quality ?? config.quality);
    appendQuery(params, "negative_prompt", options.negativePrompt ?? config.negativePrompt);
    appendQuery(params, "enhance", options.enhance ?? config.enhance);
    appendQuery(params, "transparent", options.transparent ?? config.transparent);
    appendQuery(params, "safe", options.safe ?? config.safe);
    if (options.nologo) params.set("nologo", "true");
    if (options.image) appendQuery(params, "image", Array.isArray(options.image) ? options.image.join("|") : options.image);

    const encodedPrompt = encodeURIComponent(String(prompt).trim());
    const primaryUrl = `${POLLINATIONS_IMAGE_URL}${encodedPrompt}?${params}`;
    const headers = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    try {
      const response = await fetchWithRetry(primaryUrl, {
        method: "GET",
        headers,
        signal: options.signal,
      }, { maxRetries: options.maxRetries ?? MEDIA_MAX_RETRIES });
      if (!response.ok) {
        const error = new Error(`Pollinations 请求失败 (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return await dataUrlFromBlob(await response.blob());
    } catch (error) {
      const canUseLegacy = (options.legacyFallback ?? config.legacyFallback) &&
        !options.signal?.aborted && error?.status !== 401 && error?.status !== 403;
      if (!canUseLegacy) throw error;
      const fallbackUrl = `${LEGACY_POLLINATIONS_URL}${encodedPrompt}?${params}`;
      const response = await fetchWithRetry(fallbackUrl, { signal: options.signal }, { maxRetries: 1 });
      if (!response.ok) throw new Error(`Pollinations 兼容接口失败 (${response.status})`);
      return await dataUrlFromBlob(await response.blob());
    }
  }

  window.generatePollinationsImage = generatePollinationsImage;
  window.MediaGeneration = Object.assign(window.MediaGeneration || {}, {
    fetchWithRetry,
    generatePollinationsImage,
  });

  function normalizeModelRecord(record) {
    if (typeof record === "string") return { id: record, name: record };
    const id = record.id || record.model || record.name;
    return id ? { id, name: record.name || record.displayName || id, raw: record } : null;
  }

  async function refreshPollinationsModels() {
    const button = element("fetch-pollinations-models-btn");
    if (button) button.disabled = true;
    setStatus("pollinations-model-status", "正在读取官方模型目录…");
    try {
      savePollinationsSettings();
      const config = pollinationsConfig();
      const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
      const response = await fetchWithRetry(POLLINATIONS_MODELS_URL, { headers }, { maxRetries: 1, timeout: 30000 });
      if (!response.ok) throw new Error(`模型目录请求失败 (${response.status})`);
      const payload = await response.json();
      const records = (Array.isArray(payload) ? payload : payload.data || payload.models || [])
        .map(normalizeModelRecord)
        .filter(Boolean);
      if (!records.length) throw new Error("官方目录未返回可识别的图像模型");
      const select = element("pollinations-model-select");
      const selected = select?.value || config.model;
      select.innerHTML = "";
      records.forEach((record) => {
        const option = document.createElement("option");
        option.value = record.id;
        option.textContent = record.name;
        select.appendChild(option);
      });
      if (!records.some((record) => record.id === selected) && selected) {
        const compatibilityOption = document.createElement("option");
        compatibilityOption.value = selected;
        compatibilityOption.textContent = `${selected}（保留的旧配置）`;
        select.prepend(compatibilityOption);
      }
      if (selected) select.value = selected;
      state.apiConfig.pollinationsModelCatalog = records.map(({ id, name }) => ({ id, name }));
      state.apiConfig.pollinationsModelCatalogUpdatedAt = Date.now();
      await db.apiConfig.put(state.apiConfig);
      setStatus("pollinations-model-status", `已读取 ${records.length} 个模型，并保存当前目录。`, "success");
    } catch (error) {
      const cached = state.apiConfig.pollinationsModelCatalog || [];
      if (cached.length) populatePollinationsModelSelect(cached);
      setStatus("pollinations-model-status", `${error.message}${cached.length ? "；已保留上次目录。" : ""}`, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function populatePollinationsModelSelect(records) {
    const select = element("pollinations-model-select");
    if (!select || !records?.length) return;
    const selected = state.apiConfig.pollinationsModel || select.value;
    select.innerHTML = "";
    records.forEach((record) => {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = record.name || record.id;
      select.appendChild(option);
    });
    if (![...select.options].some((option) => option.value === selected) && selected) {
      const compatibilityOption = document.createElement("option");
      compatibilityOption.value = selected;
      compatibilityOption.textContent = `${selected}（保留的旧配置）`;
      select.prepend(compatibilityOption);
    }
    if (selected) select.value = selected;
  }

  function savePollinationsSettings() {
    if (!element("pollinations-model-select")) return;
    Object.assign(state.apiConfig, {
      pollinationsApiKey: element("pollinations-api-key")
        ? element("pollinations-api-key").value.trim()
        : (state.apiConfig.pollinationsApiKey || ""),
      pollinationsModel: element("pollinations-model-select").value || "flux",
      pollinationsWidth: readNumber("pollinations-width", 1024),
      pollinationsHeight: readNumber("pollinations-height", 1024),
      pollinationsSeed: readNumber("pollinations-seed", -1),
      pollinationsQuality: element("pollinations-quality").value || "medium",
      pollinationsNegativePrompt: element("pollinations-negative-prompt").value.trim(),
      pollinationsEnhance: element("pollinations-enhance").checked,
      pollinationsTransparent: element("pollinations-transparent").checked,
      pollinationsSafe: element("pollinations-safe").value,
      pollinationsLegacyFallback: element("pollinations-legacy-fallback").checked,
    });
  }

  function loadPollinationsSettings() {
    const config = pollinationsConfig();
    populatePollinationsModelSelect(state.apiConfig.pollinationsModelCatalog || []);
    setValue("pollinations-model-select", config.model);
    setValue("pollinations-width", config.width);
    setValue("pollinations-height", config.height);
    setValue("pollinations-seed", config.seed);
    setValue("pollinations-quality", config.quality);
    setValue("pollinations-negative-prompt", config.negativePrompt);
    setValue("pollinations-safe", config.safe);
    setChecked("pollinations-enhance", config.enhance);
    setChecked("pollinations-transparent", config.transparent);
    setChecked("pollinations-legacy-fallback", config.legacyFallback);
    if (state.apiConfig.pollinationsModelCatalogUpdatedAt) {
      setStatus(
        "pollinations-model-status",
        `模型目录更新时间：${new Date(state.apiConfig.pollinationsModelCatalogUpdatedAt).toLocaleString()}`,
      );
    }
  }

  function minimaxBaseUrls() {
    const custom = state.apiConfig.minimaxBaseUrl?.trim();
    if (custom) return [custom.replace(/\/$/, "")];
    return state.apiConfig.minimaxProvider === "io"
      ? ["https://api.minimax.io"]
      : ["https://api.minimax.cn", "https://api.minimaxi.com"];
  }

  function buildMinimaxAudioSettings(stream = false) {
    return {
      // MiniMax 的流式接口只保证 MP3 分片可直接拼接播放。
      format: stream ? "mp3" : (state.apiConfig.minimaxAudioFormat || "mp3"),
      sample_rate: state.apiConfig.minimaxSampleRate || 32000,
      bitrate: state.apiConfig.minimaxBitrate || 128000,
      channel: state.apiConfig.minimaxChannel || 1,
    };
  }

  function parsePronunciationDictionary(value) {
    const tone = String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.includes("/"));
    return tone.length ? { tone } : null;
  }

  function looksLikePronunciation(content) {
    return /[0-9][1-6]?|[\u0250-\u02AF]|[ˈˌːɐɑɒæɓʙβɔɕçɗɖðʤəɚɛɜɞɟɡɢɣɦɧɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸɹɺɻʀʁɽɾʂʃʈʧʉʊʋⱱʌɣɯɲ]/u.test(content);
  }

  function sanitizeMinimaxText(text, chatSettings = {}, model = "") {
    const allowTags = chatSettings.minimaxSoundTagsEnabled !== false && model.startsWith("speech-2.8");
    const allowPronunciation = chatSettings.minimaxInlinePronunciationEnabled !== false;
    return String(text || "")
      .replace(/【.*?】/g, "")
      .replace(/（.*?）/g, "")
      .replace(/\((.*?)\)/g, (match, content) => {
        const normalized = content.trim().toLowerCase();
        if (allowTags && MINIMAX_SOUND_TAGS.has(normalized)) return `(${normalized})`;
        if (allowPronunciation && looksLikePronunciation(content)) return match;
        return "";
      })
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  window.sanitizeMinimaxText = sanitizeMinimaxText;
  window.buildMinimaxAudioSettings = buildMinimaxAudioSettings;
  window.parseMinimaxPronunciationDictionary = parsePronunciationDictionary;
  window.getMinimaxBaseUrls = minimaxBaseUrls;

  async function parseMinimaxSpeechResponse(response, stream = false) {
    if (!stream) return response.json();
    const reader = response.body?.getReader();
    if (!reader) return response.json();
    const decoder = new TextDecoder();
    let pending = "";
    let audio = "";
    let lastPayload = null;
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = done ? "" : lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.replace(/^data:\s*/, "").trim();
        if (!line || line === "[DONE]") continue;
        try {
          const payload = JSON.parse(line);
          lastPayload = payload;
          if (payload.data?.audio) audio += payload.data.audio;
        } catch (_) {
          // SSE 心跳或不完整行不作为失败；最终仍校验是否获得音频。
        }
      }
      if (done) break;
    }
    if (!audio && lastPayload?.data?.audio) audio = lastPayload.data.audio;
    return {
      ...(lastPayload || {}),
      data: { ...(lastPayload?.data || {}), audio },
    };
  }

  function audioUrlFromHex(hex, format = "mp3") {
    const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
    if (!clean || clean.length % 2) throw new Error("MiniMax 返回的音频数据不完整");
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < clean.length; index += 2) {
      bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    const mime = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac" }[format] || "audio/mpeg";
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  window.parseMinimaxSpeechResponse = parseMinimaxSpeechResponse;

  async function requestMinimax(path, init, allowEndpointFallback = true) {
    let lastError;
    const isReadRequest = !init?.method || String(init.method).toUpperCase() === "GET";
    for (const baseUrl of minimaxBaseUrls()) {
      const groupId = state.apiConfig.minimaxGroupId;
      const suffix = groupId ? `${path.includes("?") ? "&" : "?"}GroupId=${encodeURIComponent(groupId)}` : "";
      try {
        const response = await fetchWithRetry(`${baseUrl}${path}${suffix}`, init, { maxRetries: isReadRequest ? 1 : 0 });
        const endpointMissing = response.status === 404 || response.status === 405;
        if (response.ok || !isReadRequest && !endpointMissing || response.status === 400 || response.status === 401 || response.status === 403) return response;
        lastError = new Error(`MiniMax 请求失败 (${response.status})`);
      } catch (error) {
        lastError = error;
      }
      if (!allowEndpointFallback) break;
    }
    throw lastError || new Error("MiniMax 服务不可用");
  }

  function collectVoiceRecords(payload) {
    const groups = [
      payload?.system_voice,
      payload?.voice_cloning,
      payload?.voice_generation,
      payload?.music_generation,
      payload?.data?.system_voice,
      payload?.data?.voice_cloning,
      payload?.data?.voice_generation,
      payload?.data?.music_generation,
      payload?.voices,
      payload?.data?.voices,
    ].filter(Array.isArray);
    const seen = new Set();
    return groups.flat().map((voice) => {
      if (typeof voice === "string") return { id: voice, name: voice };
      const id = voice.voice_id || voice.id;
      return id ? { id, name: voice.voice_name || voice.name || id } : null;
    }).filter((voice) => voice && !seen.has(voice.id) && seen.add(voice.id));
  }

  function populateVoiceOptions(voices = minimaxVoiceCache) {
    const datalist = element("minimax-voice-options");
    if (!datalist) return;
    datalist.innerHTML = "";
    voices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.label = voice.name;
      datalist.appendChild(option);
    });
  }

  async function refreshMinimaxVoices() {
    saveMinimaxGlobalSettings();
    if (!state.apiConfig.minimaxApiKey) {
      setStatus("minimax-voice-library-status", "请先填写并保存 MiniMax API Key。", "error");
      return;
    }
    const button = element("fetch-minimax-voices-btn");
    if (button) button.disabled = true;
    setStatus("minimax-voice-library-status", "正在读取账户音色…");
    try {
      const response = await requestMinimax("/v1/get_voice?voice_type=all", {
        headers: { Authorization: `Bearer ${state.apiConfig.minimaxApiKey}` },
      });
      const payload = await response.json();
      if (!response.ok || payload.base_resp?.status_code) {
        throw new Error(payload.base_resp?.status_msg || `音色请求失败 (${response.status})`);
      }
      minimaxVoiceCache = collectVoiceRecords(payload);
      state.apiConfig.minimaxVoiceCatalog = minimaxVoiceCache;
      state.apiConfig.minimaxVoiceCatalogUpdatedAt = Date.now();
      await db.apiConfig.put(state.apiConfig);
      populateVoiceOptions();
      setStatus("minimax-voice-library-status", `已读取 ${minimaxVoiceCache.length} 个可用音色。`, "success");
    } catch (error) {
      minimaxVoiceCache = state.apiConfig.minimaxVoiceCatalog || [];
      populateVoiceOptions();
      setStatus("minimax-voice-library-status", `${error.message}${minimaxVoiceCache.length ? "；已保留上次音色库。" : ""}`, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function synthesizeMinimaxPreview(voiceId, characterSettings = {}) {
    const apiKey = element("minimax-api-key")
      ? element("minimax-api-key").value.trim()
      : state.apiConfig.minimaxApiKey;
    if (!apiKey) throw new Error("请先填写 MiniMax API Key");
    if (!voiceId) throw new Error("请先选择或填写语音 ID");
    saveMinimaxGlobalSettings();
    const model = element("minimax-speech-model-select")?.value ||
      state.apiConfig.minimaxSpeechModel || "speech-2.8-turbo";
    const stream = Boolean(state.apiConfig.minimaxStreamEnabled);
    const requestBody = {
      model,
      text: sanitizeMinimaxText("你好，这是当前音色的真实试听。", characterSettings, model),
      stream,
      output_format: "hex",
      subtitle_enable: Boolean(state.apiConfig.minimaxSubtitleEnabled),
      voice_setting: {
        voice_id: voiceId,
        speed: Number(characterSettings.speed ?? 1),
        vol: Number(characterSettings.minimaxVolume ?? 1),
        pitch: Number(characterSettings.minimaxPitch ?? 0),
      },
      audio_setting: buildMinimaxAudioSettings(stream),
    };
    if (characterSettings.language_boost) requestBody.language_boost = characterSettings.language_boost;
    if (characterSettings.minimaxEmotion) requestBody.voice_setting.emotion = characterSettings.minimaxEmotion;
    const pronunciation = parsePronunciationDictionary(characterSettings.minimaxPronunciationDict);
    if (pronunciation) requestBody.pronunciation_dict = pronunciation;
    const response = await requestMinimax("/v1/t2a_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const payload = await parseMinimaxSpeechResponse(response, stream);
    if (!response.ok || payload.base_resp?.status_code) {
      throw new Error(payload.base_resp?.status_msg || `试听失败 (${response.status})`);
    }
    if (!payload.data?.audio) throw new Error("MiniMax 未返回可播放的音频");
    const url = audioUrlFromHex(payload.data.audio, requestBody.audio_setting.format);
    const player = element("tts-audio-player") || new Audio();
    player.src = url;
    player.onended = () => URL.revokeObjectURL(url);
    player.onerror = () => URL.revokeObjectURL(url);
    await player.play();
  }

  function saveMinimaxGlobalSettings() {
    if (!element("minimax-audio-format")) return;
    Object.assign(state.apiConfig, {
      minimaxGroupId: element("minimax-group-id")
        ? element("minimax-group-id").value.trim()
        : (state.apiConfig.minimaxGroupId || ""),
      minimaxApiKey: element("minimax-api-key")
        ? element("minimax-api-key").value.trim()
        : (state.apiConfig.minimaxApiKey || ""),
      minimaxProvider: element("minimax-provider-select")?.value || state.apiConfig.minimaxProvider || "cn",
      minimaxSpeechModel: element("minimax-speech-model-select")?.value || state.apiConfig.minimaxSpeechModel || "speech-2.8-turbo",
      minimaxAudioFormat: element("minimax-audio-format").value,
      minimaxSampleRate: readNumber("minimax-sample-rate", 32000),
      minimaxBitrate: readNumber("minimax-bitrate", 128000),
      minimaxChannel: readNumber("minimax-channel", 1),
      minimaxStreamEnabled: element("minimax-stream-enabled").checked,
      minimaxSubtitleEnabled: element("minimax-subtitle-enabled").checked,
      minimaxBaseUrl: element("minimax-base-url").value.trim(),
    });
  }

  function loadMinimaxGlobalSettings() {
    setValue("minimax-audio-format", state.apiConfig.minimaxAudioFormat || "mp3");
    setValue("minimax-sample-rate", state.apiConfig.minimaxSampleRate || 32000);
    setValue("minimax-bitrate", state.apiConfig.minimaxBitrate || 128000);
    setValue("minimax-channel", state.apiConfig.minimaxChannel || 1);
    setChecked("minimax-stream-enabled", state.apiConfig.minimaxStreamEnabled);
    setChecked("minimax-subtitle-enabled", state.apiConfig.minimaxSubtitleEnabled);
    setValue("minimax-base-url", state.apiConfig.minimaxBaseUrl || "");
    minimaxVoiceCache = state.apiConfig.minimaxVoiceCatalog || [];
    populateVoiceOptions();
    if (state.apiConfig.minimaxVoiceCatalogUpdatedAt) {
      setStatus("minimax-voice-library-status", `音色库更新时间：${new Date(state.apiConfig.minimaxVoiceCatalogUpdatedAt).toLocaleString()}`);
    }
  }

  window.loadMediaProviderSettings = function loadMediaProviderSettings() {
    loadPollinationsSettings();
    loadMinimaxGlobalSettings();
  };

  window.fetchMinimaxSpeechModels = async function fetchCurrentMinimaxSpeechModels() {
    const select = element("minimax-speech-model-select");
    if (!select) return;
    const selected = select.value || state.apiConfig.minimaxSpeechModel || "speech-2.8-turbo";
    select.innerHTML = "";
    MINIMAX_MODELS.forEach((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
    if (!MINIMAX_MODELS.includes(selected) && selected) {
      const compatibilityOption = document.createElement("option");
      compatibilityOption.value = selected;
      compatibilityOption.textContent = `${selected}（保留的旧配置）`;
      select.prepend(compatibilityOption);
    }
    select.value = selected || "speech-2.8-turbo";
    await showCustomAlert("模型目录", "MiniMax 当前语音模型列表已更新。原有模型仍保留可选。 ");
  };
  try { fetchMinimaxSpeechModels = window.fetchMinimaxSpeechModels; } catch (_) {}

  function loadCharacterAudioSettings(chat) {
    if (!chat || chat.isGroup) return;
    const settings = chat.settings || {};
    setValue("minimax-volume-slider", settings.minimaxVolume ?? 1);
    setValue("minimax-volume-value", Number(settings.minimaxVolume ?? 1).toFixed(1));
    setValue("minimax-pitch-slider", settings.minimaxPitch ?? 0);
    setValue("minimax-pitch-value", settings.minimaxPitch ?? 0);
    setValue("minimax-emotion-select", settings.minimaxEmotion || "");
    setValue("minimax-pronunciation-dict", settings.minimaxPronunciationDict || "");
    setChecked("minimax-sound-tags-enabled", settings.minimaxSoundTagsEnabled !== false);
    setChecked("minimax-inline-pronunciation-enabled", settings.minimaxInlinePronunciationEnabled !== false);
  }

  function saveCharacterAudioSettings(chat) {
    if (!chat || chat.isGroup || !element("minimax-volume-slider")) return;
    chat.settings.minimaxVolume = readNumber("minimax-volume-slider", 1);
    chat.settings.minimaxPitch = readNumber("minimax-pitch-slider", 0);
    chat.settings.minimaxEmotion = element("minimax-emotion-select").value;
    chat.settings.minimaxPronunciationDict = element("minimax-pronunciation-dict").value.trim();
    chat.settings.minimaxSoundTagsEnabled = element("minimax-sound-tags-enabled").checked;
    chat.settings.minimaxInlinePronunciationEnabled = element("minimax-inline-pronunciation-enabled").checked;
  }

  window.loadCharacterAudioSettings = loadCharacterAudioSettings;
  window.saveCharacterAudioSettings = saveCharacterAudioSettings;

  function currentNovelAIAdvancedSettings() {
    let saved = {};
    try { saved = JSON.parse(projectStorage.getItem("novelai-advanced-settings") || "{}"); } catch (_) {}
    return {
      noiseSchedule: saved.noiseSchedule || "karras",
      cfgRescale: saved.cfgRescale || 0,
      transparent: Boolean(saved.transparent),
      furryMode: Boolean(saved.furryMode),
      backgroundMode: Boolean(saved.backgroundMode),
      characterPrompts: Array.isArray(saved.characterPrompts) ? saved.characterPrompts : [],
      normalizeVibes: saved.normalizeVibes !== false,
      vibes: Array.isArray(saved.vibes) ? saved.vibes : [],
    };
  }

  function saveNovelAIAdvancedSettings() {
    const settings = {
      noiseSchedule: element("nai-noise-schedule")?.value || "karras",
      cfgRescale: readNumber("nai-cfg-rescale", 0),
      transparent: Boolean(element("nai-transparent-bg")?.checked),
      furryMode: Boolean(element("nai-furry-mode")?.checked),
      backgroundMode: Boolean(element("nai-background-mode")?.checked),
      characterPrompts: String(element("nai-character-prompts")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      normalizeVibes: element("nai-normalize-vibes")?.checked !== false,
      vibes: naiVibes,
    };
    projectStorage.setItem("novelai-advanced-settings", JSON.stringify(settings));
    return settings;
  }

  function loadNovelAIAdvancedSettings() {
    const settings = currentNovelAIAdvancedSettings();
    setValue("nai-noise-schedule", settings.noiseSchedule);
    setValue("nai-cfg-rescale", settings.cfgRescale);
    setChecked("nai-transparent-bg", settings.transparent);
    setChecked("nai-furry-mode", settings.furryMode);
    setChecked("nai-background-mode", settings.backgroundMode);
    setValue("nai-character-prompts", settings.characterPrompts.join("\n"));
    setChecked("nai-normalize-vibes", settings.normalizeVibes);
    naiVibes = settings.vibes;
    renderVibes();
    updateReferenceCompatibilityNote();
  }

  function normalizedVibeStrengths(vibes, normalize) {
    const strengths = vibes.map((vibe) => Math.max(0, Math.min(1, Number(vibe.strength ?? 0.6))));
    const total = strengths.reduce((sum, value) => sum + value, 0);
    if (!normalize || total <= 1 || total === 0) return strengths;
    return strengths.map((value) => Number((value / total).toFixed(4)));
  }

  function applyNovelAIAdvancedParameters(requestBody, model) {
    if (!requestBody?.parameters) return requestBody;
    const settings = currentNovelAIAdvancedSettings();
    const params = requestBody.parameters;
    const isV5 = String(model).includes("nai-diffusion-5");
    params.noise_schedule = settings.noiseSchedule;
    params.cfg_rescale = settings.cfgRescale;
    if (isV5) {
      params.params_version = 4;
      delete params.sm;
      delete params.sm_dyn;
    }
    let prefix = "";
    if (settings.furryMode) prefix += "fur dataset, ";
    if (settings.backgroundMode) prefix += "background dataset, ";
    if (settings.transparent && isV5) prefix += "transparent background, has alpha, ";
    if (prefix) {
      requestBody.input = prefix + requestBody.input;
      if (params.v4_prompt?.caption) params.v4_prompt.caption.base_caption = requestBody.input;
    }
    if (params.v4_prompt?.caption && settings.characterPrompts.length) {
      params.v4_prompt.caption.char_captions = settings.characterPrompts.map((caption) => ({ char_caption: caption, centers: [] }));
      params.characterPrompts = settings.characterPrompts.map((prompt) => ({ prompt, uc: "", center: { x: 0.5, y: 0.5 } }));
    }
    const usableVibes = !isV5
      ? settings.vibes.filter((vibe) => vibe.dataUrl?.startsWith("data:image/"))
      : [];
    if (usableVibes.length) {
      params.reference_image_multiple = usableVibes.map((vibe) => vibe.dataUrl.split(",")[1]);
      params.reference_information_extracted_multiple = usableVibes.map((vibe) => Number(vibe.informationExtracted ?? 1));
      params.reference_strength_multiple = normalizedVibeStrengths(usableVibes, settings.normalizeVibes);
      params.normalize_reference_strength_multiple = settings.normalizeVibes;
    }
    return requestBody;
  }

  window.isNovelAIModernModel = (model) => /nai-diffusion-(4|5)/.test(String(model));
  window.applyNovelAIAdvancedParameters = applyNovelAIAdvancedParameters;
  window.loadNovelAIAdvancedSettings = loadNovelAIAdvancedSettings;
  window.saveNovelAIAdvancedSettings = saveNovelAIAdvancedSettings;

  function renderVibes() {
    const list = element("nai-vibe-list");
    if (!list) return;
    list.innerHTML = "";
    if (!naiVibes.length) {
      const empty = document.createElement("p");
      empty.className = "media-help-text";
      empty.textContent = "当前没有 Vibe 素材。可一次选择多张图片建立氛围组。";
      list.appendChild(empty);
      return;
    }
    naiVibes.forEach((vibe, index) => {
      const item = document.createElement("div");
      item.className = "media-vibe-item";
      item.dataset.index = String(index);
      const thumb = document.createElement("img");
      thumb.className = "media-vibe-thumb";
      thumb.alt = vibe.type === "native-bundle" ? "原生 Vibe 文件" : "";
      if (vibe.dataUrl?.startsWith("data:image/")) thumb.src = vibe.dataUrl;
      const info = document.createElement("div");
      info.className = "media-vibe-info";
      const name = document.createElement("span");
      name.className = "media-vibe-name";
      name.textContent = `${vibe.name || `Vibe ${index + 1}`}${vibe.type === "native-bundle" ? "（原样保管）" : ""}`;
      const controls = document.createElement("div");
      controls.className = "media-vibe-controls";
      controls.innerHTML = `<label>强度<input data-field="strength" type="range" min="0" max="1" step="0.05" value="${Number(vibe.strength ?? 0.6)}"></label><label>提取量<input data-field="informationExtracted" type="range" min="0" max="1" step="0.05" value="${Number(vibe.informationExtracted ?? 1)}"></label>`;
      info.append(name, controls);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "media-vibe-remove";
      remove.setAttribute("aria-label", `移除 ${name.textContent}`);
      remove.textContent = "×";
      item.append(thumb, info, remove);
      list.appendChild(item);
    });
  }

  async function importVibeFiles(files) {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        naiVibes.push({
          id: `vibe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: "image",
          dataUrl: await dataUrlFromFile(file),
          strength: 0.6,
          informationExtracted: 1,
        });
        continue;
      }
      try {
        const parsed = JSON.parse(await file.text());
        const imported = Array.isArray(parsed) ? parsed : parsed.vibes;
        if (!Array.isArray(imported)) throw new Error("文件中没有 vibes 数组");
        imported.forEach((vibe) => {
          if (vibe && (vibe.dataUrl || vibe.encoding)) {
            naiVibes.push({
              id: vibe.id || `vibe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: vibe.name || file.name,
              type: vibe.type || "imported",
              dataUrl: vibe.dataUrl || "",
              encoding: vibe.encoding || "",
              strength: Number(vibe.strength ?? 0.6),
              informationExtracted: Number(vibe.informationExtracted ?? 1),
            });
          }
        });
      } catch (error) {
        naiVibes.push({
          id: `vibe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: "native-bundle",
          dataUrl: await dataUrlFromFile(file),
          strength: 0.6,
          informationExtracted: 1,
        });
      }
    }
    naiVibes = naiVibes.slice(0, 16);
    renderVibes();
    updateReferenceCompatibilityNote();
  }

  async function exportVibes() {
    if (!naiVibes.length) {
      await showCustomAlert("无法导出", "当前氛围组为空。请先导入图片或 Vibe 文件。");
      return;
    }
    const payload = {
      format: "ephone-novelai-vibes",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      vibes: naiVibes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `NovelAI-Vibes-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function updateReferenceCompatibilityNote() {
    const note = element("nai-reference-compatibility-note");
    if (!note) return;
    const model = element("novelai-model")?.value || projectStorage.getItem("novelai-model") || "";
    note.textContent = String(model).includes("nai-diffusion-5")
      ? "V5 当前不发送 Vibe；素材会继续保留，切回支持 Vibe 的模型即可恢复。Precise Reference 仅属于 V4.5，且与 Vibe 不兼容。"
      : "当前 Vibe 会随生成请求发送；Precise Reference 仅属于 V4.5，且不能与 Vibe 同时使用。";
  }

  function installMediaUiHandlers() {
    loadPollinationsSettings();
    loadMinimaxGlobalSettings();
    loadNovelAIAdvancedSettings();

    element("fetch-pollinations-models-btn")?.addEventListener("click", refreshPollinationsModels);
    element("test-pollinations-btn")?.addEventListener("click", async () => {
      const button = element("test-pollinations-btn");
      button.disabled = true;
      setStatus("pollinations-model-status", "正在生成连接测试图…");
      try {
        savePollinationsSettings();
        const dataUrl = await generatePollinationsImage("a small pink flower icon, clean background", { width: 512, height: 512, maxRetries: 1 });
        const preview = element("pollinations-test-preview");
        if (preview) {
          preview.src = dataUrl;
          preview.hidden = false;
        }
        setStatus("pollinations-model-status", "连接与图像返回正常。", "success");
      } catch (error) {
        setStatus("pollinations-model-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
    element("fetch-minimax-voices-btn")?.addEventListener("click", refreshMinimaxVoices);
    element("save-api-settings-btn")?.addEventListener("click", async () => {
      savePollinationsSettings();
      saveMinimaxGlobalSettings();
      await db.apiConfig.put(state.apiConfig);
    });
    element("novelai-settings-btn")?.addEventListener("click", loadNovelAIAdvancedSettings);
    element("save-nai-settings-btn")?.addEventListener("click", saveNovelAIAdvancedSettings);
    element("nai-import-vibes-btn")?.addEventListener("click", () => element("nai-vibe-file-input")?.click());
    element("nai-vibe-file-input")?.addEventListener("change", async (event) => {
      await importVibeFiles([...event.target.files]);
      event.target.value = "";
    });
    element("nai-export-vibes-btn")?.addEventListener("click", exportVibes);
    element("nai-clear-vibes-btn")?.addEventListener("click", async () => {
      if (!naiVibes.length || await showCustomConfirm("清空氛围组", "确定清空当前氛围组吗？原图片和其他设置不会受影响。")) {
        naiVibes = [];
        renderVibes();
        updateReferenceCompatibilityNote();
      }
    });
    element("nai-vibe-list")?.addEventListener("input", (event) => {
      const item = event.target.closest(".media-vibe-item");
      const field = event.target.dataset.field;
      if (!item || !field || !naiVibes[item.dataset.index]) return;
      naiVibes[item.dataset.index][field] = Number(event.target.value);
    });
    element("nai-vibe-list")?.addEventListener("click", (event) => {
      const button = event.target.closest(".media-vibe-remove");
      if (!button) return;
      const item = button.closest(".media-vibe-item");
      naiVibes.splice(Number(item.dataset.index), 1);
      renderVibes();
      updateReferenceCompatibilityNote();
    });
    element("novelai-model")?.addEventListener("change", updateReferenceCompatibilityNote);

    const volume = element("minimax-volume-slider");
    const pitch = element("minimax-pitch-slider");
    volume?.addEventListener("input", () => setValue("minimax-volume-value", Number(volume.value).toFixed(1)));
    pitch?.addEventListener("input", () => setValue("minimax-pitch-value", pitch.value));

    element("save-chat-settings-btn")?.addEventListener("click", async () => {
      if (!state.activeChatId) return;
      const chat = state.chats[state.activeChatId];
      saveCharacterAudioSettings(chat);
      await db.chats.put(chat);
    });
    element("chat-settings-modal")?.addEventListener("transitionend", () => {
      if (!state.activeChatId) return;
      loadCharacterAudioSettings(state.chats[state.activeChatId]);
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("#chat-settings-btn, .chat-settings-btn")) {
        setTimeout(() => {
          if (state.activeChatId) loadCharacterAudioSettings(state.chats[state.activeChatId]);
        }, 0);
      }
    });
    element("preview-character-voice-btn")?.addEventListener("click", async () => {
      const button = element("preview-character-voice-btn");
      const voiceId = element("minimax-voice-id-input")?.value.trim();
      const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
      if (!chat) return showCustomAlert("无法试听", "请先打开一个单人聊天的角色设置。");
      button.disabled = true;
      try {
        const settings = { ...(chat.settings || {}) };
        settings.speed = readNumber("minimax-speed-slider", settings.speed ?? 1);
        settings.language_boost = element("minimax-language-boost-select")?.value || null;
        settings.minimaxVolume = readNumber("minimax-volume-slider", 1);
        settings.minimaxPitch = readNumber("minimax-pitch-slider", 0);
        settings.minimaxEmotion = element("minimax-emotion-select")?.value || "";
        settings.minimaxPronunciationDict = element("minimax-pronunciation-dict")?.value || "";
        settings.minimaxSoundTagsEnabled = element("minimax-sound-tags-enabled")?.checked !== false;
        settings.minimaxInlinePronunciationEnabled = element("minimax-inline-pronunciation-enabled")?.checked !== false;
        await synthesizeMinimaxPreview(voiceId, settings);
      } catch (error) {
        await showCustomAlert("试听失败", error.message);
      } finally {
        button.disabled = false;
      }
    });
    element("test-minimax-voice-btn")?.addEventListener("click", async () => {
      const button = element("test-minimax-voice-btn");
      const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
      const voiceId = chat?.settings?.minimaxVoiceId || minimaxVoiceCache[0]?.id;
      button.disabled = true;
      setStatus("minimax-voice-library-status", "正在请求真实试听（会消耗少量额度）…");
      try {
        await synthesizeMinimaxPreview(voiceId, chat?.settings || {});
        setStatus("minimax-voice-library-status", "连接正常，试听音频已播放。", "success");
      } catch (error) {
        setStatus("minimax-voice-library-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    element("minimax-stream-enabled")?.addEventListener("change", (event) => {
      if (event.target.checked && element("minimax-audio-format")?.value !== "mp3") {
        setStatus("minimax-voice-library-status", "流式返回会自动使用 MP3；关闭流式后仍使用你选择的格式。 ");
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installMediaUiHandlers, { once: true });
  else installMediaUiHandlers();
})();
