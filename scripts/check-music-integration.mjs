import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/features/music/music-integration.js", import.meta.url),
  "utf8",
);
const storage = new Map();

class AudioMock {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  removeAttribute() {}

  load() {}

  set src(value) {
    if (value) queueMicrotask(() => this.listeners.get("loadedmetadata")?.());
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

async function fetchMock(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "api.vkeys.cn") {
    return jsonResponse({ code: 503, data: [] });
  }
  if (parsed.hostname === "api.bugpk.com" && parsed.searchParams.get("type") === "search") {
    return jsonResponse({
      code: 200,
      data: [
        {
          name: "测试歌曲",
          singername: "测试歌手",
          mid: "qq-mid",
        },
      ],
    });
  }
  if (parsed.hostname === "api.bugpk.com") {
    return jsonResponse({
      code: 200,
      data: {
        url: "http://audio.example/qq.mp3",
        lrc_data: "[00:00.00]测试歌词",
      },
    });
  }
  if (parsed.hostname === "music-api.gdstudio.xyz" && parsed.searchParams.get("types") === "search") {
    if (parsed.searchParams.get("source") !== "netease") return jsonResponse({ code: 400 });
    return jsonResponse([
      {
        id: "ncm-id",
        name: "测试歌曲",
        artist: [{ name: "测试歌手" }],
        source: "netease",
      },
    ]);
  }
  if (parsed.hostname === "music-api.gdstudio.xyz") {
    return jsonResponse({ url: "https://audio.example/ncm.mp3" });
  }
  if (parsed.pathname === "/search") {
    return jsonResponse({
      code: 200,
      result: {
        songs: [
          {
            id: "ncm-id",
            name: "测试歌曲",
            ar: [{ name: "测试歌手" }],
            al: {},
          },
        ],
      },
    });
  }
  if (parsed.pathname === "/song/url/v1") {
    return jsonResponse({ data: [{ url: "http://audio.example/ncm.mp3" }] });
  }
  if (parsed.pathname === "/lyric") {
    return jsonResponse({ lrc: { lyric: "[00:00.00]测试歌词" } });
  }
  return jsonResponse({}, 404);
}

const documentMock = {
  readyState: "loading",
  addEventListener() {},
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
};
const context = {
  window: null,
  document: documentMock,
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  },
  location: { href: "https://example.test/app/" },
  fetch: fetchMock,
  AbortController,
  URL,
  Audio: AudioMock,
  performance,
  setTimeout,
  clearTimeout,
  console,
  queueMicrotask,
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "music-integration.js" });

const service = context.MusicIntegration;
assert.ok(service, "music facade should be installed");

const allResults = await service.search("测试歌曲", { scope: "all" });
assert.ok(allResults.length >= 1, "aggregate search should survive failed providers");
assert.doesNotThrow(() => JSON.stringify(allResults), "search records must stay serializable");

const qqResults = await service.search("测试歌曲", { scope: "tencent" });
assert.equal(qqResults[0].apiProvider, "bugpk-qq");
const qqPlayable = await service.resolveTrack(qqResults[0], {
  allowSearchFallback: false,
});
assert.equal(qqPlayable.provider, "bugpk-qq");
assert.equal(qqPlayable.url, "https://audio.example/qq.mp3");
assert.match(qqPlayable.lrcContent, /测试歌词/);

const neteaseResult =
  allResults.find((song) => song.source === "netease") ||
  allResults.flatMap((song) => song.alternatives || []).find((song) => song.source === "netease");
assert.ok(neteaseResult, "NetEase should remain represented in aggregate results");
const neteasePlayable = await service.resolveTrack(neteaseResult, {
  allowSearchFallback: false,
});
assert.ok(neteasePlayable?.url.startsWith("https://"));

assert.equal(
  service.normalizePlayableUrl("http://audio.example/test.mp3"),
  "https://audio.example/test.mp3",
);
assert.equal(
  service.isManagedTrack({ isLocal: false, musicId: "1", musicSource: "netease" }),
  true,
);
assert.equal(service.isManagedTrack({ isLocal: true, musicId: "1" }), false);

console.log("music integration checks passed");
