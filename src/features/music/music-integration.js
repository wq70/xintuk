/**
 * Third-party music aggregation and QR-account bridge.
 *
 * This file deliberately exposes one small global facade because the legacy
 * player is still assembled as a classic script. Existing song records remain
 * valid; the facade only adds providers, renewal and account capabilities.
 */
(function installMusicIntegration(global) {
  "use strict";

  const PLACEHOLDER_COVER =
    "https://i.postimg.cc/pT2xKzPz/album-cover-placeholder.png";
  const REQUEST_TIMEOUT = 10000;
  const AUDIO_TIMEOUT = 9000;
  const HEALTH_STORAGE_KEY = "ephone-music-source-health";
  const DEFAULT_NCM_NODES = [
    "https://music.mcseekeri.com",
    "https://zm.wwoyun.cn",
    "https://ncm.landdy.cn",
  ];
  const nodeHealth = readJson(HEALTH_STORAGE_KEY, {});
  let importHandler = null;
  let qrRunId = 0;

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn("[Music] 无法保存本地设置:", error);
    }
  }

  function currentAccountStorageKey() {
    const projectRoot = new URL("./", global.location.href);
    const projectId = `tuk-phone:${projectRoot.protocol}//${projectRoot.host}${projectRoot.pathname}`;
    const uidKey = `ephone:${projectId}:ephone_saved_uid`;
    const uid = localStorage.getItem(uidKey) || "anonymous";
    return `ephone:${projectId}:music-auth:${uid}`;
  }

  function getAuthState() {
    return readJson(currentAccountStorageKey(), { netease: null, qq: null });
  }

  function updateAuthState(platform, value) {
    const state = getAuthState();
    state[platform] = value;
    writeJson(currentAccountStorageKey(), state);
    return state;
  }

  function cleanBaseUrl(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "https:" ? parsed.origin + parsed.pathname.replace(/\/$/, "") : "";
    } catch (_) {
      return "";
    }
  }

  function safeText(value, fallback = "") {
    const text = value == null ? "" : String(value).trim();
    return text || fallback;
  }

  function normalizeArtist(value) {
    if (Array.isArray(value)) {
      return value
        .map((artist) => (typeof artist === "string" ? artist : artist?.name))
        .filter(Boolean)
        .join(" / ");
    }
    return safeText(value, "未知艺术家");
  }

  function normalizePlayableUrl(value) {
    let url = safeText(value);
    if (!url || !/^https?:\/\//i.test(url)) return "";
    if (url.startsWith("http://")) url = `https://${url.slice(7)}`;
    return url;
  }

  function sourceKey(url) {
    try {
      return new URL(url).origin;
    } catch (_) {
      return String(url);
    }
  }

  function recordHealth(url, succeeded, latency) {
    const key = sourceKey(url);
    const item = nodeHealth[key] || { success: 0, failure: 0, latency: 0, cooldownUntil: 0 };
    if (succeeded) {
      item.success += 1;
      item.latency = item.latency ? Math.round(item.latency * 0.7 + latency * 0.3) : latency;
      item.cooldownUntil = 0;
    } else {
      item.failure += 1;
      if (item.failure - item.success >= 3) item.cooldownUntil = Date.now() + 2 * 60 * 1000;
    }
    nodeHealth[key] = item;
    writeJson(HEALTH_STORAGE_KEY, nodeHealth);
  }

  function sortNodes(nodes) {
    return [...nodes].sort((left, right) => {
      const a = nodeHealth[sourceKey(left)] || {};
      const b = nodeHealth[sourceKey(right)] || {};
      const aCooling = Number(a.cooldownUntil || 0) > Date.now();
      const bCooling = Number(b.cooldownUntil || 0) > Date.now();
      if (aCooling !== bCooling) return aCooling ? 1 : -1;
      const aRate = (a.success || 0) / Math.max(1, (a.success || 0) + (a.failure || 0));
      const bRate = (b.success || 0) / Math.max(1, (b.success || 0) + (b.failure || 0));
      if (aRate !== bRate) return bRate - aRate;
      return (a.latency || 99999) - (b.latency || 99999);
    });
  }

  function orderedNcmNodes(preferredBase) {
    const sorted = sortNodes(DEFAULT_NCM_NODES);
    return preferredBase
      ? [preferredBase, ...sorted.filter((base) => base !== preferredBase)]
      : sorted;
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT);
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        credentials: options.credentials || "omit",
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      recordHealth(url, true, Math.round(performance.now() - started));
      return result;
    } catch (error) {
      recordHealth(url, false, Math.round(performance.now() - started));
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function allSettledValues(tasks) {
    const settled = await Promise.allSettled(tasks);
    return settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value || [] : []));
  }

  function normalizedFingerprint(song) {
    const clean = (value) =>
      safeText(value)
        .toLowerCase()
        .replace(/[\s·•・._\-—–()（）【】\[\]《》'"“”]/g, "")
        .replace(/(live|伴奏|纯音乐|翻唱|cover|remix|版)$/i, "");
    return `${clean(song.name)}::${clean(song.artist).slice(0, 24)}`;
  }

  function dedupeSongs(songs, limit = 40) {
    const seen = new Map();
    for (const song of songs) {
      if (!song?.id || !song?.name) continue;
      const key = normalizedFingerprint(song);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, song);
      } else {
        const alternative = { ...song };
        delete alternative.alternatives;
        existing.alternatives ||= [];
        if (
          !existing.alternatives.some(
            (item) =>
              item.id === alternative.id &&
              item.apiProvider === alternative.apiProvider,
          )
        ) {
          existing.alternatives.push(alternative);
        }
        if (!existing.cover && song.cover) existing.cover = song.cover;
      }
      if (seen.size >= limit) break;
    }
    return Array.from(seen.values());
  }

  async function searchVkeys(platform, query) {
    const endpoint = platform === "netease" ? "netease" : "tencent";
    const result = await fetchJson(
      `https://api.vkeys.cn/v2/music/${endpoint}?word=${encodeURIComponent(query)}`,
    );
    if (!Array.isArray(result?.data)) return [];
    return result.data.slice(0, 15).map((song) => ({
      name: safeText(song.song || song.name, "未知歌曲"),
      artist: normalizeArtist(song.singer || song.artist),
      id: safeText(song.id || song.songmid),
      cover: normalizePlayableUrl(song.cover) || PLACEHOLDER_COVER,
      source: platform,
      originalSource: platform,
      apiProvider: "vkeys",
    }));
  }

  async function searchBugpkQq(query) {
    const result = await fetchJson(
      `https://api.bugpk.com/api/qqmusic?type=search&name=${encodeURIComponent(query)}`,
    );
    if (!Array.isArray(result?.data)) return [];
    return result.data.slice(0, 15).map((song) => ({
      name: safeText(song.name, "未知歌曲"),
      artist: normalizeArtist(song.singername),
      id: safeText(song.mid),
      cover: PLACEHOLDER_COVER,
      source: "tencent",
      originalSource: "tencent",
      apiProvider: "bugpk-qq",
      duration: song.duration || 0,
    }));
  }

  async function searchGdSource(source, query) {
    const url = `https://music-api.gdstudio.xyz/api.php?btwaf=9018895&types=search&source=${source}&name=${encodeURIComponent(query)}&count=12&pages=1`;
    const result = await fetchJson(url);
    if (!Array.isArray(result)) return [];
    return result.map((song) => ({
      name: safeText(song.name, "未知歌曲"),
      artist: normalizeArtist(song.artist),
      id: safeText(song.id),
      pic_id: song.pic_id || song.album?.id,
      lyric_id: song.lyric_id || song.id,
      cover: normalizePlayableUrl(song.pic) || PLACEHOLDER_COVER,
      source,
      originalSource: source,
      apiProvider: "gdstudio",
    }));
  }

  async function searchNcmNode(query) {
    let lastError;
    for (const base of sortNodes(DEFAULT_NCM_NODES)) {
      try {
        const result = await fetchJson(
          `${base}/search?keywords=${encodeURIComponent(query)}&limit=12&timestamp=${Date.now()}`,
        );
        const songs = result?.result?.songs;
        if (!Array.isArray(songs)) continue;
        return songs.map((song) => ({
          name: safeText(song.name, "未知歌曲"),
          artist: normalizeArtist(song.ar || song.artists),
          id: safeText(song.id),
          cover: normalizePlayableUrl(song.al?.picUrl || song.album?.picUrl) || PLACEHOLDER_COVER,
          source: "netease",
          originalSource: "netease",
          apiProvider: "ncm-public",
          nodeBase: base,
          duration: song.dt || song.duration || 0,
        }));
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async function search(query, options = {}) {
    const text = safeText(query);
    if (!text) return [];
    const scope = options.scope || "all";
    let tasks;
    if (scope === "tencent") {
      tasks = [searchBugpkQq(text), searchVkeys("tencent", text)];
    } else if (scope === "netease") {
      tasks = [searchVkeys("netease", text), searchGdSource("netease", text), searchNcmNode(text)];
    } else if (scope === "gdstudio") {
      // Tencent is no longer accepted by GD; keep the GD entry useful with its
      // currently supported NetEase, Joox and Kuwo adapters.
      tasks = [
        searchGdSource("netease", text),
        searchGdSource("joox", text),
        searchGdSource("kuwo", text),
      ];
    } else {
      tasks = [
        searchGdSource("netease", text),
        searchNcmNode(text),
        searchVkeys("netease", text),
        searchBugpkQq(text),
        searchVkeys("tencent", text),
        searchGdSource("joox", text),
        searchGdSource("kuwo", text),
      ];
    }
    return dedupeSongs(await allSettledValues(tasks));
  }

  function extractVkeysUrl(result) {
    return normalizePlayableUrl(result?.data?.url || result?.url);
  }

  function extractGdUrl(result) {
    return normalizePlayableUrl(result?.url || result?.data?.url);
  }

  async function validateAudio(url) {
    const normalized = normalizePlayableUrl(url);
    if (!normalized) return false;
    return new Promise((resolve) => {
      const audio = new Audio();
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        audio.removeAttribute("src");
        audio.load();
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), AUDIO_TIMEOUT);
      audio.preload = "metadata";
      audio.addEventListener("loadedmetadata", () => finish(true), { once: true });
      audio.addEventListener("canplay", () => finish(true), { once: true });
      audio.addEventListener("error", () => finish(false), { once: true });
      audio.src = normalized;
    });
  }

  async function firstPlayable(attempts) {
    for (const attempt of attempts) {
      try {
        const value = await attempt();
        const url = normalizePlayableUrl(value?.url || value);
        if (url && (await validateAudio(url))) return { ...value, url };
      } catch (error) {
        console.warn("[Music] 音源尝试失败:", error.message || error);
      }
    }
    return null;
  }

  function withNcmCookie(url, base) {
    const auth = getAuthState().netease;
    if (!auth?.cookie) return url;
    if (auth.nodeBase && base && auth.nodeBase !== base) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}cookie=${encodeURIComponent(auth.cookie)}`;
  }

  function directResolveAttempts(song) {
    const id = encodeURIComponent(song.id || song.musicId || "");
    const source = song.originalSource || song.source || song.musicSource;
    const provider = song.apiProvider || "vkeys";
    const attempts = [];
    const addVkeys = (platform) =>
      attempts.push(async () => {
        const result = await fetchJson(`https://api.vkeys.cn/v2/music/${platform}?id=${id}`);
        return { url: extractVkeysUrl(result), provider: "vkeys", source: platform, id: song.id || song.musicId };
      });
    const addBugpkQq = () =>
      attempts.push(async () => {
        const link = `https://y.qq.com/n/ryqq/songDetail/${id}`;
        const result = await fetchJson(
          `https://api.bugpk.com/api/qqmusic?url=${encodeURIComponent(link)}`,
        );
        return {
          url: normalizePlayableUrl(result?.data?.url),
          provider: "bugpk-qq",
          source: "tencent",
          id: song.id || song.musicId,
          lrcContent: safeText(result?.data?.lrc_data),
          cover: normalizePlayableUrl(result?.data?.cover),
        };
      });
    const addKit9Qq = () =>
      attempts.push(async () => {
        const link = `https://y.qq.com/n/ryqq/songDetail/${id}`;
        const result = await fetchJson(
          `https://apis.kit9.cn/api/qq_music/song_download.php?link=${encodeURIComponent(link)}`,
        );
        return {
          url: normalizePlayableUrl(result?.data?.play_url),
          provider: "kit9-qq",
          source: "tencent",
          id: song.id || song.musicId,
          lrcContent: safeText(result?.data?.lyric),
          cover: normalizePlayableUrl(result?.data?.cover_url),
        };
      });
    const addQqAccountNode = () => {
      const auth = getAuthState().qq;
      const base = cleanBaseUrl(auth?.endpoint);
      if (!base) return;
      attempts.push(async () => {
        const query = auth?.opaqueSession
          ? `?quality=flac&cookie=${encodeURIComponent(auth.opaqueSession)}`
          : "?quality=flac";
        const result = await fetchJson(`${base}/getMusicPlay/${id}${query}`, {
          credentials: "include",
        });
        return {
          url: normalizePlayableUrl(
            result?.data?.url || result?.data?.playUrl || result?.url,
          ),
          provider: "qq-account-node",
          source: "tencent",
          id: song.id || song.musicId,
        };
      });
    };
    const addGd = (platform) =>
      attempts.push(async () => {
        const result = await fetchJson(
          `https://music-api.gdstudio.xyz/api.php?btwaf=20639888&types=url&source=${platform}&id=${id}&br=320`,
        );
        return { url: extractGdUrl(result), provider: "gdstudio", source: platform, id: song.id || song.musicId };
      });
    const addNcmNodes = () => {
      const authNode = getAuthState().netease?.nodeBase;
      for (const base of orderedNcmNodes(song.nodeBase || authNode)) {
        attempts.push(async () => {
          const requestUrl = withNcmCookie(
            `${base}/song/url/v1?id=${id}&level=exhigh&timestamp=${Date.now()}`,
            base,
          );
          const result = await fetchJson(requestUrl);
          return {
            url: normalizePlayableUrl(result?.data?.[0]?.url),
            provider: "ncm-public",
            source: "netease",
            id: song.id || song.musicId,
            nodeBase: base,
          };
        });
      }
    };
    const addOurcraft = () =>
      attempts.push(async () => {
        const result = await fetchJson(
          `https://music.yuncan.xyz/api?server=netease&type=url&id=${id}&json=1`,
        );
        return { url: normalizePlayableUrl(result?.url), provider: "ourcraft", source: "netease", id: song.id || song.musicId };
      });

    if (source === "tencent") addQqAccountNode();

    if (provider === "gdstudio") addGd(source);
    else if (provider === "ncm-public") addNcmNodes();
    else if (provider === "ourcraft") addOurcraft();
    else if (provider === "bugpk-qq") addBugpkQq();
    else if (provider === "kit9-qq") addKit9Qq();
    else if (source === "tencent") addVkeys("tencent");
    else addVkeys("netease");

    if (source === "netease") {
      if (provider !== "ncm-public") addNcmNodes();
      if (provider !== "gdstudio") addGd("netease");
      if (provider !== "ourcraft") addOurcraft();
    } else if (source === "tencent") {
      if (provider !== "bugpk-qq") addBugpkQq();
      if (provider !== "kit9-qq") addKit9Qq();
      if (provider !== "vkeys") addVkeys("tencent");
    } else if (source === "joox" || source === "kuwo") {
      if (provider !== "gdstudio") addGd(source);
    }
    return attempts;
  }

  function matchScore(target, candidate) {
    const simplify = (value) => safeText(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const targetName = simplify(target.name);
    const candidateName = simplify(candidate.name);
    const targetArtist = simplify(target.artist);
    const candidateArtist = simplify(candidate.artist);
    let score = targetName === candidateName ? 70 : targetName.includes(candidateName) || candidateName.includes(targetName) ? 45 : 0;
    if (targetArtist && candidateArtist) {
      if (targetArtist === candidateArtist) score += 30;
      else if (targetArtist.includes(candidateArtist) || candidateArtist.includes(targetArtist)) score += 18;
    }
    return score;
  }

  async function resolveTrack(song, options = {}) {
    if (!song) return null;
    const direct = await firstPlayable(directResolveAttempts(song));
    if (direct) return direct;
    for (const alternative of song.alternatives || []) {
      const resolved = await firstPlayable(directResolveAttempts(alternative));
      if (resolved) return { ...resolved, matchedSong: alternative };
    }
    if (options.allowSearchFallback === false || !song.name) return null;
    const candidates = await search(`${song.name} ${song.artist || ""}`, { scope: "all" });
    const ranked = candidates
      .map((candidate) => ({ candidate, score: matchScore(song, candidate) }))
      .filter((entry) => entry.score >= 45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const entry of ranked) {
      const resolved = await firstPlayable(directResolveAttempts(entry.candidate));
      if (resolved) return { ...resolved, matchedSong: entry.candidate };
    }
    return null;
  }

  async function getLyrics(song) {
    if (!song) return "";
    const id = encodeURIComponent(song.id || song.musicId || "");
    const source = song.originalSource || song.source || song.musicSource;
    const provider = song.apiProvider || "vkeys";
    const attempts = [];
    if (provider === "gdstudio") {
      attempts.push(
        `https://music-api.gdstudio.xyz/api.php?btwaf=20639888&types=lyric&source=${source}&id=${id}`,
      );
    }
    if (source === "netease") {
      const auth = getAuthState().netease;
      const bases = auth?.nodeBase ? [auth.nodeBase, ...DEFAULT_NCM_NODES] : DEFAULT_NCM_NODES;
      for (const base of [...new Set(bases)]) {
        attempts.push(withNcmCookie(`${base}/lyric?id=${id}`, base));
      }
      attempts.push(`https://api.vkeys.cn/v2/music/netease/lyric?id=${id}`);
    } else if (source === "tencent") {
      attempts.push(`https://api.vkeys.cn/v2/music/tencent/lyric?id=${id}`);
    }
    for (const url of attempts) {
      try {
        const response = await fetchJson(url);
        const data = response?.data || response;
        const original = data?.lrc?.lyric || data?.lrc || data?.lyric || "";
        const translated = data?.tlyric?.lyric || data?.tlyric || data?.trans || "";
        if (original || translated) return translated ? `${original}\n${translated}` : original;
      } catch (_) {}
    }
    return "";
  }

  function isManagedTrack(track) {
    return Boolean(
      track &&
        !track.isLocal &&
        (track.musicId || track.apiProvider || /(?:vkeys|gdstudio|music\.126|qqmusic|yuncan)/i.test(track.src || "")),
    );
  }

  async function tryNcmNodes(pathBuilder) {
    let lastError;
    for (const base of sortNodes(DEFAULT_NCM_NODES)) {
      try {
        return { base, data: await fetchJson(pathBuilder(base)) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("没有可用的网易云节点");
  }

  async function startNeteaseQr(onUpdate, runId) {
    const keyResult = await tryNcmNodes(
      (base) => `${base}/login/qr/key?timestamp=${Date.now()}`,
    );
    const unikey = keyResult.data?.data?.unikey;
    if (!unikey) throw new Error("节点没有返回二维码密钥");
    const created = await fetchJson(
      `${keyResult.base}/login/qr/create?key=${encodeURIComponent(unikey)}&qrimg=true&timestamp=${Date.now()}`,
    );
    const qrimg = created?.data?.qrimg;
    const qrurl = created?.data?.qrurl;
    if (!qrimg && !qrurl) throw new Error("节点没有返回二维码");
    onUpdate({ state: "waiting", qrimg, qrurl, message: "请使用网易云音乐扫码" });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (runId === qrRunId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if (runId !== qrRunId) return null;
      const checked = await fetchJson(
        `${keyResult.base}/login/qr/check?key=${encodeURIComponent(unikey)}&timestamp=${Date.now()}`,
      );
      if (checked.code === 802) onUpdate({ state: "scanned", message: "已扫码，请在手机上确认" });
      if (checked.code === 800) throw new Error("二维码已过期，请重新获取");
      if (checked.code === 803) {
        const cookie = safeText(checked.cookie || checked.data?.cookie);
        if (!cookie) throw new Error("登录成功，但节点没有返回登录凭据");
        const auth = { cookie, nodeBase: keyResult.base, updatedAt: Date.now() };
        updateAuthState("netease", auth);
        const profile = await getNeteaseProfile(auth).catch(() => null);
        if (profile) {
          auth.profile = profile;
          updateAuthState("netease", auth);
        }
        onUpdate({ state: "success", message: "网易云登录成功", profile });
        return auth;
      }
    }
    if (runId === qrRunId) throw new Error("二维码已超时，请重新获取");
    return null;
  }

  async function getNeteaseProfile(auth = getAuthState().netease) {
    if (!auth?.cookie || !auth?.nodeBase) return null;
    const result = await fetchJson(
      `${auth.nodeBase}/login/status?timestamp=${Date.now()}&cookie=${encodeURIComponent(auth.cookie)}`,
    );
    const profile = result?.data?.profile || result?.profile;
    if (!profile?.userId) return null;
    return {
      userId: String(profile.userId),
      nickname: safeText(profile.nickname, "网易云用户"),
      avatarUrl: normalizePlayableUrl(profile.avatarUrl),
    };
  }

  async function getNeteasePlaylists(auth = getAuthState().netease) {
    const profile = auth?.profile || (await getNeteaseProfile(auth));
    if (!profile) throw new Error("网易云登录态已失效");
    const result = await fetchJson(
      `${auth.nodeBase}/user/playlist?uid=${encodeURIComponent(profile.userId)}&limit=100&timestamp=${Date.now()}&cookie=${encodeURIComponent(auth.cookie)}`,
    );
    return (result?.playlist || []).map((list) => ({
      id: String(list.id),
      name: safeText(list.name, "未命名歌单"),
      count: Number(list.trackCount || 0),
    }));
  }

  async function getNeteasePlaylistTracks(playlistId, auth = getAuthState().netease) {
    const result = await fetchJson(
      `${auth.nodeBase}/playlist/track/all?id=${encodeURIComponent(playlistId)}&limit=1000&timestamp=${Date.now()}&cookie=${encodeURIComponent(auth.cookie)}`,
      { timeout: 20000 },
    );
    return (result?.songs || []).map((song) => ({
      name: safeText(song.name, "未知歌曲"),
      artist: normalizeArtist(song.ar),
      src: "",
      cover: normalizePlayableUrl(song.al?.picUrl) || PLACEHOLDER_COVER,
      isLocal: false,
      lrcContent: "",
      isTemporary: false,
      addedTimestamp: Date.now(),
      musicId: String(song.id),
      musicSource: "netease",
      source: "netease",
      apiProvider: "ncm-public",
      nodeBase: auth.nodeBase,
    }));
  }

  async function startQqQr(endpoint, channel, onUpdate, runId) {
    const base = cleanBaseUrl(endpoint);
    if (!base) throw new Error("请输入支持 HTTPS 的 QQ 音乐聚合节点");
    const credentials = "include";
    const keyResult = await fetchJson(
      `${base}/login/qr/key?channel=${encodeURIComponent(channel)}&timestamp=${Date.now()}`,
      { credentials },
    );
    const unikey = keyResult?.data?.unikey;
    if (!unikey) throw new Error("该节点不兼容 QQ 扫码接口");
    const created = await fetchJson(
      `${base}/login/qr/create?key=${encodeURIComponent(unikey)}&timestamp=${Date.now()}`,
      { credentials },
    );
    const qrimg = created?.data?.qrimg;
    const qrurl = created?.data?.qrurl;
    if (!qrimg && !qrurl) throw new Error("QQ 节点没有返回二维码");
    onUpdate({ state: "waiting", qrimg, qrurl, message: channel === "wechat" ? "请使用微信扫码" : "请使用 QQ音乐扫码" });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (runId === qrRunId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if (runId !== qrRunId) return null;
      const checked = await fetchJson(
        `${base}/login/qr/check?key=${encodeURIComponent(unikey)}&timestamp=${Date.now()}`,
        { credentials },
      );
      if (checked.code === 802) onUpdate({ state: "scanned", message: "已扫码，请在手机上确认" });
      if (checked.code === 800) throw new Error(checked.message || "二维码已过期，请重新获取");
      if (checked.code === 803) {
        const auth = {
          endpoint: base,
          channel,
          opaqueSession: safeText(checked.cookie || checked.data?.cookie),
          updatedAt: Date.now(),
        };
        updateAuthState("qq", auth);
        const profile = await getQqProfile(auth).catch(() => null);
        if (profile) {
          auth.profile = profile;
          updateAuthState("qq", auth);
        }
        onUpdate({ state: "success", message: "QQ音乐登录成功", profile });
        return auth;
      }
    }
    if (runId === qrRunId) throw new Error("二维码已超时，请重新获取");
    return null;
  }

  async function getQqProfile(auth = getAuthState().qq) {
    const base = cleanBaseUrl(auth?.endpoint);
    if (!base) return null;
    const query = auth?.opaqueSession ? `?cookie=${encodeURIComponent(auth.opaqueSession)}` : "";
    const result = await fetchJson(`${base}/user/detail${query}`, { credentials: "include" });
    const profile = result?.data?.profile || result?.data || result?.profile;
    if (!profile) return null;
    return {
      userId: safeText(profile.userId || profile.uin || profile.id),
      nickname: safeText(profile.nickname || profile.nick, "QQ音乐用户"),
      avatarUrl: normalizePlayableUrl(profile.avatarUrl || profile.avatar),
    };
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function setQrVisual(elements, update) {
    elements.status.textContent = update.message || "";
    elements.status.dataset.state = update.state || "";
    if (update.state === "success") {
      elements.image.hidden = true;
      elements.link.hidden = true;
      return;
    }
    if (update.qrimg) {
      elements.image.src = update.qrimg;
      elements.image.hidden = false;
      elements.link.hidden = true;
    } else if (update.qrurl) {
      elements.link.href = update.qrurl;
      elements.link.hidden = false;
      elements.image.hidden = true;
    }
  }

  function renderAccountSummary(container, auth, platformName) {
    container.replaceChildren();
    const row = createElement("div", "music-account-profile");
    if (auth?.profile?.avatarUrl) {
      const image = document.createElement("img");
      image.src = auth.profile.avatarUrl;
      image.alt = "";
      row.appendChild(image);
    }
    row.appendChild(
      createElement(
        "span",
        "music-account-profile-name",
        auth?.profile?.nickname ? `${auth.profile.nickname} · 已登录` : `${platformName}未登录`,
      ),
    );
    container.appendChild(row);
  }

  function buildPlatformSection(name, subtitle) {
    const section = createElement("section", "music-account-section");
    const titleRow = createElement("div", "music-account-section-title");
    titleRow.append(createElement("strong", "", name), createElement("span", "", subtitle));
    const summary = createElement("div", "music-account-summary");
    const controls = createElement("div", "music-account-controls");
    const qr = createElement("div", "music-account-qr");
    const image = document.createElement("img");
    image.alt = `${name}登录二维码`;
    image.hidden = true;
    const link = createElement("a", "music-account-qr-link", "打开扫码页面");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.hidden = true;
    const status = createElement("div", "music-account-status", "未登录");
    qr.append(image, link, status);
    section.append(titleRow, summary, controls, qr);
    return { section, summary, controls, qr, image, link, status };
  }

  function button(text, variant = "") {
    const item = createElement("button", `music-account-btn ${variant}`.trim(), text);
    item.type = "button";
    return item;
  }

  async function refreshNeteaseUi(section, playlistSelect, importButton) {
    const auth = getAuthState().netease;
    if (!auth) {
      renderAccountSummary(section.summary, null, "网易云");
      playlistSelect.hidden = true;
      importButton.hidden = true;
      return;
    }
    try {
      const profile = await getNeteaseProfile(auth);
      auth.profile = profile;
      updateAuthState("netease", auth);
      renderAccountSummary(section.summary, auth, "网易云");
      const playlists = await getNeteasePlaylists(auth);
      playlistSelect.replaceChildren();
      for (const list of playlists) {
        const option = document.createElement("option");
        option.value = list.id;
        option.textContent = `${list.name} (${list.count})`;
        playlistSelect.appendChild(option);
      }
      playlistSelect.hidden = playlists.length === 0;
      importButton.hidden = playlists.length === 0;
      section.status.textContent = playlists.length ? "可选择歌单导入" : "已登录，暂未读取到歌单";
    } catch (error) {
      section.status.textContent = "登录态可能已失效，请重新扫码";
      renderAccountSummary(section.summary, auth, "网易云");
    }
  }

  function installAccountUi() {
    if (document.getElementById("music-account-overlay")) return;
    const headerActions = document.querySelector("#music-playlist-panel .playlist-header > div");
    if (!headerActions) return;
    const entry = createElement("span", "panel-btn music-account-entry", "账号");
    entry.id = "music-account-entry-btn";
    entry.title = "音乐账号与歌单";
    headerActions.insertBefore(entry, headerActions.firstChild);

    const overlay = createElement("div", "music-account-overlay");
    overlay.id = "music-account-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "音乐账号");
    const panel = createElement("div", "music-account-panel");
    const header = createElement("div", "music-account-header");
    const close = button("返回", "music-account-close");
    header.append(close, createElement("strong", "", "音乐账号"), createElement("span", "music-account-header-spacer"));
    const body = createElement("div", "music-account-body");

    const netease = buildPlatformSection("网易云音乐", "第三方聚合节点");
    const ncmLogin = button("扫码登录");
    const ncmRefresh = button("刷新状态", "secondary");
    const ncmLogout = button("退出", "danger");
    const playlistRow = createElement("div", "music-account-playlist-row");
    const playlistSelect = document.createElement("select");
    playlistSelect.className = "music-account-select";
    playlistSelect.setAttribute("aria-label", "网易云歌单");
    playlistSelect.hidden = true;
    const importButton = button("导入歌单", "secondary");
    importButton.hidden = true;
    playlistRow.append(playlistSelect, importButton);
    netease.controls.append(ncmLogin, ncmRefresh, ncmLogout);
    netease.section.appendChild(playlistRow);

    const qq = buildPlatformSection("QQ音乐", "兼容聚合节点");
    const endpoint = document.createElement("input");
    endpoint.className = "music-account-input";
    endpoint.type = "url";
    endpoint.inputMode = "url";
    endpoint.placeholder = "https://可信的QQ聚合节点";
    endpoint.setAttribute("aria-label", "QQ音乐聚合节点地址");
    endpoint.value = getAuthState().qq?.endpoint || "";
    const channel = document.createElement("select");
    channel.className = "music-account-select music-account-channel";
    for (const [value, label] of [["qq", "QQ音乐扫码"], ["wechat", "微信扫码"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      channel.appendChild(option);
    }
    const qqLogin = button("获取二维码");
    const qqRefresh = button("检查登录", "secondary");
    const qqLogout = button("退出", "danger");
    qq.controls.append(endpoint, channel, qqLogin, qqRefresh, qqLogout);
    const qqNotice = createElement(
      "p",
      "music-account-notice",
      "节点会参与登录过程，请只填写你信任且支持 /login/qr/* 的 HTTPS 聚合接口。",
    );
    qq.section.appendChild(qqNotice);

    body.append(netease.section, qq.section);
    panel.append(header, body);
    overlay.appendChild(panel);
    (document.getElementById("phone-screen") || document.body).appendChild(
      overlay,
    );

    const closeOverlay = () => {
      qrRunId += 1;
      overlay.classList.remove("visible");
    };
    entry.addEventListener("click", async () => {
      overlay.classList.add("visible");
      renderAccountSummary(qq.summary, getAuthState().qq, "QQ音乐");
      await refreshNeteaseUi(netease, playlistSelect, importButton);
    });
    close.addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOverlay();
    });

    ncmLogin.addEventListener("click", async () => {
      const runId = ++qrRunId;
      ncmLogin.disabled = true;
      netease.status.textContent = "正在连接可用节点…";
      try {
        await startNeteaseQr((update) => setQrVisual(netease, update), runId);
        await refreshNeteaseUi(netease, playlistSelect, importButton);
      } catch (error) {
        netease.status.textContent = error.message || "扫码登录失败";
      } finally {
        ncmLogin.disabled = false;
      }
    });
    ncmRefresh.addEventListener("click", () => refreshNeteaseUi(netease, playlistSelect, importButton));
    ncmLogout.addEventListener("click", () => {
      qrRunId += 1;
      updateAuthState("netease", null);
      netease.image.hidden = true;
      netease.link.hidden = true;
      netease.status.textContent = "已退出并清除本地凭据";
      renderAccountSummary(netease.summary, null, "网易云");
      playlistSelect.hidden = true;
      importButton.hidden = true;
    });
    importButton.addEventListener("click", async () => {
      if (!playlistSelect.value || typeof importHandler !== "function") return;
      importButton.disabled = true;
      const originalText = importButton.textContent;
      importButton.textContent = "读取中…";
      try {
        const tracks = await getNeteasePlaylistTracks(playlistSelect.value);
        const result = await importHandler(tracks, { platform: "netease", playlistId: playlistSelect.value });
        netease.status.textContent = `已导入 ${result?.added ?? tracks.length} 首，跳过 ${result?.skipped ?? 0} 首重复歌曲`;
      } catch (error) {
        netease.status.textContent = error.message || "歌单导入失败";
      } finally {
        importButton.disabled = false;
        importButton.textContent = originalText;
      }
    });

    qqLogin.addEventListener("click", async () => {
      const base = cleanBaseUrl(endpoint.value);
      if (!base) {
        qq.status.textContent = "请输入可信的 HTTPS 聚合节点";
        return;
      }
      endpoint.value = base;
      const runId = ++qrRunId;
      qqLogin.disabled = true;
      qq.status.textContent = "正在检查节点能力…";
      try {
        await startQqQr(base, channel.value, (update) => setQrVisual(qq, update), runId);
        renderAccountSummary(qq.summary, getAuthState().qq, "QQ音乐");
      } catch (error) {
        qq.status.textContent = error.message || "QQ音乐扫码失败";
      } finally {
        qqLogin.disabled = false;
      }
    });
    qqRefresh.addEventListener("click", async () => {
      try {
        const auth = getAuthState().qq;
        const profile = await getQqProfile(auth);
        if (!profile) throw new Error("未检测到有效登录态");
        auth.profile = profile;
        updateAuthState("qq", auth);
        renderAccountSummary(qq.summary, auth, "QQ音乐");
        qq.status.textContent = "登录状态有效";
      } catch (error) {
        qq.status.textContent = error.message || "检查登录状态失败";
      }
    });
    qqLogout.addEventListener("click", async () => {
      qrRunId += 1;
      const auth = getAuthState().qq;
      const base = cleanBaseUrl(auth?.endpoint);
      const logoutQuery = auth?.opaqueSession
        ? `?cookie=${encodeURIComponent(auth.opaqueSession)}`
        : "";
      if (base)
        fetchJson(`${base}/logout${logoutQuery}`, {
          credentials: "include",
        }).catch(() => {});
      updateAuthState("qq", null);
      qq.image.hidden = true;
      qq.link.hidden = true;
      qq.status.textContent = "已退出并清除本地会话信息";
      renderAccountSummary(qq.summary, null, "QQ音乐");
    });

    renderAccountSummary(netease.summary, getAuthState().netease, "网易云");
    renderAccountSummary(qq.summary, getAuthState().qq, "QQ音乐");
  }

  const facade = {
    search,
    resolveTrack,
    getLyrics,
    validateAudio,
    normalizePlayableUrl,
    isManagedTrack,
    getAuthState,
    installAccountUi,
    setImportHandler(handler) {
      importHandler = typeof handler === "function" ? handler : null;
    },
    getHealthSnapshot() {
      return JSON.parse(JSON.stringify(nodeHealth));
    },
  };

  global.MusicIntegration = facade;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installAccountUi, { once: true });
  } else {
    installAccountUi();
  }
})(window);
